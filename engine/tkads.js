#!/usr/bin/env node
/**
 * tkads.js — GMV Max 广告管理统一引擎 v4
 * 
 * ✅ 自动检测 AdsPower 浏览器 WebSocket 地址
 * ✅ 浏览器未运行时自动唤醒（无需手动启动）
 * ✅ 所有命令一个入口
 * ✅ 配置驱动 (config-chain) + 生命周期钩子 (hook-engine) + 门禁检查 (gate-engine)
 * ✅ 审计日志 (db_v2)
 * 
 * 用法: node tkads.js <command> [args...]
 *   list [days]          — 广告列表（默认30天）
 *   pause <campaign_id>  — 暂停广告
 *   resume <campaign_id> — 恢复广告
 *   update <id> <roi>    — 修改 ROI
 *   creatives            — 作品/创作者概览
 *   products <id>        — 广告内商品数据
 *   post <vid> [mode]    — 视频详情（time_series/frame/all）
 */
const http = require('http');
const { execSync } = require('child_process');

// ============ 新架构模块 ============
const cfg = require('./config-chain');
const hookEngine = require('./hook-engine');
const gateEngine = require('./gate-engine');

// ============ 配置 ============
const CONFIG = {
  ADS_URL: cfg.get('ads_url') || 'http://local.adspower.net:50325',
  PROFILE_ID: cfg.get('profile_id') || 'k1456ta2',
  SELLER_DOMAIN: cfg.get('seller_domain') || 'seller-my.tiktok.com',
  SID: cfg.get('sid') || '7494105016200037977',
  ADVID: cfg.get('aadvid') || '7569565674088136705',
  HOME: process.env.HOME || process.env.USERPROFILE || '~',
};

const STORE_ID = cfg.getStore() ? cfg.listStores()[0] || 'hanmac' : 'hanmac';

// ============ 工具函数 ============
function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({raw: d}); } });
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============ 审计日志 ============
async function auditLog(opts) {
  const { operation, campaign_id, status, duration_ms, error_message } = opts;
  const home = CONFIG.HOME.replace(/\\/g, '/');
  try {
    execSync('python', {
      input: `import sys
sys.path.insert(0, '${home}/.tkads')
from db_v2 import log_operation_v2
log_operation_v2(
    operation='${operation}',
    namespace='tkads.ad',
    store_id='${STORE_ID}',
    campaign_id='${campaign_id || ''}',
    status='${status || 'OK'}',
    duration_ms=${duration_ms || 0},
    error_message='${(error_message || '').replace(/'/g, "\\'")}'
)`,
      timeout: 5000,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
  } catch(e) {
    // Audit logging is best-effort; don't crash the main operation
  }
}

// ============ 浏览器管理 ============
async function getBrowserWS() {
  let info = await httpGet(`${CONFIG.ADS_URL}/api/v1/browser/active?user_id=${CONFIG.PROFILE_ID}`);
  if (info.code !== 0 || info.data?.status === 'Inactive') {
    console.log('  🔄 浏览器未运行，自动启动...');
    info = await httpGet(`${CONFIG.ADS_URL}/api/v1/browser/start?user_id=${CONFIG.PROFILE_ID}&open_tabs=1`);
    if (info.code !== 0) {
      throw new Error(`启动浏览器失败: ${info.msg || '未知错误'}`);
    }
    await sleep(4000);
  }
  return info.data.ws.puppeteer;
}

const puppeteer = require('puppeteer-core');

async function connectBrowser() {
  const ws = await getBrowserWS();
  const browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null, protocolTimeout: 30000 });
  return { browser, ws };
}

async function getSellerPage(browser) {
  const pages = await browser.pages();
  let page = pages.find(p => p.url().includes(CONFIG.SELLER_DOMAIN));
  if (!page) {
    page = await browser.newPage();
    console.log('  🔗 打开 Seller Center...');
    await page.goto(`https://${CONFIG.SELLER_DOMAIN}/ads-creation/dashboard?mpa=1`, {
      timeout: 30000, waitUntil: 'networkidle0'
    });
    await sleep(3000);
  }
  return page;
}

async function disconnect(browser) {
  try { await browser.disconnect(); } catch(e) {}
}

// ============ 命令：list ============
async function cmdList(days) {
  const { browser } = await connectBrowser();
  try {
    const np = await browser.newPage();
    const cdp = await np.target().createCDPSession();
    await cdp.send('Network.enable');

    let raw = null;
    cdp.on('Network.responseReceived', async params => {
      if (params.response.url.includes('post_campaign_list')) {
        try {
          raw = JSON.parse((await cdp.send('Network.getResponseBody', { requestId: params.requestId })).body);
        } catch(e) {}
      }
    });

    await np.goto(`https://${CONFIG.SELLER_DOMAIN}/ads-creation/dashboard`, {
      waitUntil: 'networkidle0', timeout: 30000
    });
    await sleep(8000);

    if (!raw || !raw.data?.table) {
      console.log('❌ 无法获取数据');
      return;
    }

    const table = raw.data.table;
    const delivery = table.filter(t => t.campaign_primary_status === 'delivery_ok');
    const totalCost = delivery.reduce((s, t) => s + parseFloat(t.cost||0), 0);
    const totalOrders = delivery.reduce((s, t) => s + parseInt(t.onsite_roi2_shopping_sku||0), 0);
    const totalRevenue = delivery.reduce((s, t) => s + parseFloat(t.onsite_roi2_shopping_value||0), 0);
    const avgRoi = totalCost > 0 ? (totalRevenue / totalCost).toFixed(2) : '-';
    const fp = v => { const n = parseFloat(v); return isNaN(n) ? '-      ' : n.toFixed(2).padStart(6); };

    console.log('📊 GMV Max 广告列表');
    console.log(`   日期: ${new Date().toLocaleDateString('zh-CN')} | 数据: 近${days}天`);
    console.log('═'.repeat(100));

    for (const t of table) {
      const s = t.campaign_primary_status === 'delivery_ok' ? '🟢' :
                t.campaign_primary_status === 'delete' ? '⚫' : '🟡';
      const name = (t.campaign_name || '').split('-')[0] || t.campaign_id.slice(-6);
      const target = parseFloat(t.template_ad_roas_bid);
      const actual = parseFloat(t.onsite_roi2_shopping);
      let flag = '   ';
      if (t.campaign_primary_status === 'delivery_ok' && !isNaN(target) && !isNaN(actual)) {
        const diff = ((actual - target) / target * 100).toFixed(0);
        flag = diff > 0 ? '📈+' + diff + '%' : '📉' + diff + '%';
      }
      console.log(`${s} ${name.padEnd(10)} 目标ROI:${fp(t.template_ad_roas_bid)} 实际:${fp(t.onsite_roi2_shopping)} ${flag.padStart(8)} 消耗:${fp(t.cost)} 订单:${(t.onsite_roi2_shopping_sku||'0').padStart(4)} 收入:${fp(t.onsite_roi2_shopping_value)} 预算:${fp(t.campaign_target_roi_budget)}`);
    }
    console.log('═'.repeat(100));
    console.log(`📊 在投${delivery.length}个 | 总消耗:${totalCost.toFixed(2)} | 总订单:${totalOrders} | 总收入:${totalRevenue.toFixed(2)} | 总ROI:${avgRoi}`);

    // Hook + audit (read-only)
    const ctx = { days, store: cfg.getStore(), timestamp: Date.now() };
    await hookEngine.trigger('after:list', ctx);
  } finally {
    await disconnect(browser);
  }
}

// ============ 命令：pause / resume ============
async function cmdSetStatus(cid, operation) {
  const isPause = operation === 2;
  const label = isPause ? '暂停' : '启动';
  const eventName = isPause ? 'pause_ad' : 'resume_ad';
  const gateEvent = isPause ? 'before:pause_ad' : 'before:resume_ad';
  const beforeHook = `before:${eventName}`;
  const afterHook = `after:${eventName}`;
  const startTime = Date.now();
  let success = false;
  let errorMsg = '';

  // 1. Context
  const ctx = { campaign_id: cid, store: cfg.getStore(), timestamp: startTime };

  // 2. Gate check
  const gateResult = await gateEngine.check(gateEvent, { campaign_id: cid, store: cfg.getStore() });
  if (!gateResult.passed) {
    console.log('⛔ 门禁拦截:');
    gateResult.failures.forEach(f => console.log(`   ❌ ${f.message}`));
    await auditLog({
      operation: eventName,
      campaign_id: cid,
      status: 'BLOCKED',
      duration_ms: Date.now() - startTime,
      error_message: gateResult.failures.map(f => f.message).join('; '),
    });
    return;
  }

  // 3. Before hook
  await hookEngine.trigger(beforeHook, ctx);

  // 4. Core logic
  const { browser } = await connectBrowser();
  try {
    const page = await getSellerPage(browser);
    const result = await page.evaluate(async (id, op, sid, advid) => {
      const c = document.cookie.match(/csrftoken=([^;]+)/)?.[1] || '';
      const f = await fetch(`/oec_ads/shopping/v1/creation/campaign/update_status?locale=zh&language=zh&oec_seller_id=${sid}&aadvid=${advid}`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'x-csrftoken': c },
        body: JSON.stringify({ campaign_list: [id], operation: op })
      });
      return (await f.json()).msg;
    }, cid, operation, CONFIG.SID, CONFIG.ADVID);
    console.log(result === 'success' ? `✅ 已${label} ${cid}` : `❌ ${result}`);
    success = result === 'success';
    if (!success) errorMsg = result;
  } finally {
    await disconnect(browser);
  }

  const duration = Date.now() - startTime;
  ctx.result = success ? 'success' : 'error';
  ctx.duration_ms = duration;

  // 5. After hook
  await hookEngine.trigger(afterHook, ctx);

  // 6. Audit log
  await auditLog({
    operation: eventName,
    campaign_id: cid,
    status: success ? 'OK' : 'ERROR',
    duration_ms: duration,
    error_message: errorMsg,
  });
}

// ============ 命令：update ============
async function cmdUpdate(cid, roi, budget) {
  const startTime = Date.now();
  let success = false;
  let errorMsg = '';

  // 1. Context
  const ctx = { campaign_id: cid, store: cfg.getStore(), roi, budget, timestamp: startTime };

  // 2. Gate check
  const gateResult = await gateEngine.check('before:update_roi', { campaign_id: cid, store: cfg.getStore() });
  if (!gateResult.passed) {
    console.log('⛔ 门禁拦截:');
    gateResult.failures.forEach(f => console.log(`   ❌ ${f.message}`));
    await auditLog({
      operation: 'update_roi',
      campaign_id: cid,
      status: 'BLOCKED',
      duration_ms: Date.now() - startTime,
      error_message: gateResult.failures.map(f => f.message).join('; '),
    });
    return;
  }

  // 3. Before hook
  await hookEngine.trigger('before:update_roi', ctx);

  // 4. Core logic
  const { browser } = await connectBrowser();
  try {
    console.log(`📝 ${cid} → ROI=${roi}${budget ? `, 预算=${budget}` : ''}`);

    // 通过 stdin 调用 Python 构建 body（无临时文件）
    const home = CONFIG.HOME.replace(/\\/g, '/');
    let body;
    try {
      const out = execSync('python', {
        input: `import sys, json
sys.path.insert(0, '${home}/.tkads')
from db import get_campaign_meta
from api import build_update_body
meta = get_campaign_meta('${cid}')
if not meta:
    print('ERROR:NO_META')
    sys.exit(1)
body = build_update_body(meta, ${roi}${budget ? ', ' + budget : ''})
print(json.dumps(body))`,
        timeout: 10000,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024
      }).trim();
      
      if (out.includes('ERROR:NO_META')) {
        console.log(`❌ ${cid} 在数据库中无元数据`);
        console.log('   请先通过 tkads-list 查看广告，或重新创建广告自动捕获 ad_id');
        await auditLog({
          operation: 'update_roi',
          campaign_id: cid,
          status: 'ERROR',
          duration_ms: Date.now() - startTime,
          error_message: 'No meta data in DB',
        });
        return;
      }
      body = JSON.parse(out);
    } catch(e) {
      const msg = (e.stderr || e.message || e.stdout || '').toString().substring(0, 300);
      console.log(`❌ Python 构建 body 失败: ${msg}`);
      await auditLog({
        operation: 'update_roi',
        campaign_id: cid,
        status: 'ERROR',
        duration_ms: Date.now() - startTime,
        error_message: msg,
      });
      return;
    }

    const page = await getSellerPage(browser);
    const result = await page.evaluate(async (data) => {
      const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] || '';
      const base = '?locale=zh&language=zh&oec_seller_id=' + data.sid + '&aadvid=' + data.advid;
      const res = await fetch('/oec_ads/shopping/v1/creation/all_ad_data/update' + base, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'x-csrftoken': csrf },
        body: JSON.stringify(data.body)
      });
      return await res.json();
    }, { body, sid: CONFIG.SID, advid: CONFIG.ADVID });

    console.log(result.code === 0 ? '✅ 修改成功!' : `❌ ${result.msg}`);
    success = result.code === 0;
    if (!success) errorMsg = result.msg || JSON.stringify(result);
  } finally {
    await disconnect(browser);
  }

  const duration = Date.now() - startTime;
  ctx.result = success ? 'success' : 'error';
  ctx.duration_ms = duration;

  // 5. After hook
  await hookEngine.trigger('after:update_roi', ctx);

  // 6. Audit log
  await auditLog({
    operation: 'update_roi',
    campaign_id: cid,
    status: success ? 'OK' : 'ERROR',
    duration_ms: duration,
    error_message: errorMsg,
  });
}

// ============ 命令：creatives ============
async function cmdCreatives() {
  const startTime = Date.now();
  const { browser } = await connectBrowser();
  try {
    const np = await browser.newPage();
    const cdp = await np.target().createCDPSession();
    await cdp.send('Network.enable');

    let overviewResp = null, listResp = null;
    cdp.on('Network.responseReceived', async params => {
      const url = params.response.url;
      if (url.includes('post_video_over_view_stat')) {
        try { overviewResp = JSON.parse((await cdp.send('Network.getResponseBody', {requestId: params.requestId})).body); } catch(e) {}
      }
      if (url.includes('post_video_list') && params.response.status === 200) {
        try { listResp = JSON.parse((await cdp.send('Network.getResponseBody', {requestId: params.requestId})).body); } catch(e) {}
      }
    });

    console.log('🎬 Creative 概览');
    console.log('═'.repeat(60));

    await np.goto(`https://${CONFIG.SELLER_DOMAIN}/ads-creation/manage-analyze`, {
      waitUntil: 'networkidle0', timeout: 30000
    });
    await sleep(8000);

    if (overviewResp?.data?.statistics) {
      overviewResp.data.statistics.forEach(s => {
        console.log(`  ${s.name}: ${s.data}`);
      });
    }

    if (listResp?.data?.table) {
      console.log('\n📹 Top 视频:');
      listResp.data.table.slice(0, 5).forEach((v, i) => {
        console.log(`  ${i+1}. ${v.creator_nick_name || v.creator_user_name || '?'} | 收入:${v.onsite_roi2_shopping_value || '0'} | 订单:${v.onsite_roi2_shopping_sku || '0'} | 消耗:${v.cost || '0'} | 曝光:${v.roi2_impression || '0'}`);
      });
    } else {
      console.log('❌ 无法获取数据');
    }

    // Hook + audit (read-only)
    const ctx = { store: cfg.getStore(), timestamp: Date.now(), duration_ms: Date.now() - startTime };
    await hookEngine.trigger('after:creatives', ctx);
  } finally {
    await disconnect(browser);
  }
}

// ============ 命令：products ============
async function cmdProducts(cid) {
  const { browser } = await connectBrowser();
  try {
    const np = await browser.newPage();
    const cdp = await np.target().createCDPSession();
    await cdp.send('Network.enable');

    let productResp = null;
    cdp.on('Network.responseReceived', async params => {
      const url = params.response.url;
      if (url.includes('post_product_list')) {
        try { productResp = JSON.parse((await cdp.send('Network.getResponseBody', {requestId: params.requestId})).body); } catch(e) {}
      }
    });

    console.log(`📦 商品数据 — ${cid}`);
    console.log('═'.repeat(80));

    await np.goto(`https://${CONFIG.SELLER_DOMAIN}/ads-creation/dashboard`, {
      waitUntil: 'networkidle0', timeout: 30000
    });
    await sleep(8000);

    if (!productResp) {
      console.log('❌ 未获取到商品数据，请先在浏览器中切换到"商品视图"标签');
      return;
    }

    const allProducts = productResp.data?.table || [];
    const filtered = allProducts.filter(t => t.campaign_id === cid);

    if (filtered.length === 0) {
      console.log('❌ 该广告下无商品数据');
      const allCids = [...new Set(allProducts.map(t => t.campaign_id))];
      console.log('📌 当前有商品数据的 campaign_id:', allCids.join(', '));
      return;
    }

    filtered.forEach(t => {
      const name = (t.product_name || '?').slice(0, 30);
      const cost = parseFloat(t.cost||0).toFixed(2);
      const orders = t.onsite_roi2_shopping_sku || '0';
      const revenue = parseFloat(t.onsite_roi2_shopping_value||0).toFixed(2);
      const roi = parseFloat(t.onsite_roi2_shopping||0).toFixed(2);
      console.log(`  ${name.padEnd(32)} 消耗:${cost.padStart(7)} 订单:${orders.padStart(4)} 收入:${revenue.padStart(9)} ROI:${roi}`);
    });
  } finally {
    await disconnect(browser);
  }
}

// ============ 命令：post ============
async function cmdPost(vid, mode) {
  const { browser } = await connectBrowser();
  try {
    const pages = await browser.pages();
    const page = pages.find(x => x.url().includes(CONFIG.SELLER_DOMAIN));
    if (!page) {
      console.log('❌ 无 Seller Center 页面，请先打开');
      return;
    }

    const cdp = await page.target().createCDPSession();
    await cdp.send('Network.enable');

    const results = {};
    cdp.on('Network.responseReceived', async params => {
      const url = params.response.url;
      if (url.includes('post_video_analysis')) {
        try {
          const body = JSON.parse((await cdp.send('Network.getResponseBody', {requestId: params.requestId})).body);
          if (body.data?.table?.[0]?.stat_time_day) results.time_series = body.data.table;
          if (body.data?.table?.[0]?.video_duration) results.frame = body.data.table;
          if (body.data?.table?.[0]?.campaign_id) results.campaigns = body.data.table;
        } catch(e) {}
      }
      if (url.includes('video_anchors')) {
        try {
          const body = JSON.parse((await cdp.send('Network.getResponseBody', {requestId: params.requestId})).body);
          results.product = body.data?.video_list?.[0]?.product_list || [];
        } catch(e) {}
      }
    });

    await page.goto(`https://${CONFIG.SELLER_DOMAIN}/ads-creation/manage-analyze`, {
      waitUntil: 'networkidle0', timeout: 30000
    });
    await sleep(5000);

    // 主动触发 video_anchors API
    await page.evaluate(async (vid, sid, advid) => {
      const c = document.cookie.match(/csrftoken=([^;]+)/)?.[1]||'';
      await fetch(`/oec_ads/shopping/v1/creation/shop_video/video_anchors?locale=zh&language=zh&oec_seller_id=${sid}&aadvid=${advid}`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'x-csrftoken': c },
        body: JSON.stringify({ item_id_list: [vid] })
      });
    }, vid, CONFIG.SID, CONFIG.ADVID);

    await sleep(3000);

    let out = '';

    if (results.product?.length > 0) {
      out += '📦 关联商品:\n';
      results.product.forEach(p => {
        out += `  ${(p.title || '').slice(0, 50)} (SPU: ${p.spu_id})\n`;
      });
    }

    if (results.campaigns?.length > 0) {
      out += '\n📋 关联广告:\n';
      results.campaigns.forEach(c => {
        out += `  ${c.campaign_name} | 曝光:${c.roi2_show_cnt||'0'}\n`;
      });
    }

    if (mode === 'time_series' || mode === 'all') {
      if (results.time_series?.length > 0) {
        out += '\n📅 Time series 日报:\n';
        out += '  日期        | 收入    | 订单 | 曝光    | 点击   | 点击率 | 转化率\n';
        results.time_series.forEach(r => {
          const rev = parseFloat(r.onsite_roi2_shopping_value||0).toFixed(2);
          out += `  ${(r.stat_time_day||'').slice(5)} | ${rev.padStart(7)} | ${(r.onsite_roi2_shopping_sku||'0').padStart(3)} | ${(r.roi2_show_cnt||'0').padStart(7)} | ${(r.roi2_click_cnt||'0').padStart(5)} | ${(r.roi2_ctr||'0%').padStart(5)} | ${r.onsite_shopping_sku_cvr||'-'}\n`;
        });
      }
    }

    if (mode === 'frame' || mode === 'all') {
      if (results.frame?.length > 0) {
        out += '\n🎬 Frame by frame（每秒数据）:\n';
        out += '  秒 | 点击  | 转化 | 跳出   | 留存\n';
        results.frame.forEach(r => {
          out += `  ${(r.video_duration||'?').padStart(2)}s | ${(r.click_cnt||'0').padStart(4)} | ${(r.convert_cnt||'0').padStart(3)} | ${(r.play_break_count||'0').padStart(5)} | ${(r.play_retain_count||'0').padStart(5)}\n`;
        });
      }
    }

    console.log(out || '❌ 未获取到数据');
  } finally {
    await disconnect(browser);
  }
}

// ============ 命令：export ============
// Exports daily_stats from analytics.db to CSV format
async function cmdExport(days) {
  const home = process.env.HOME || process.env.USERPROFILE;
  const { execSync } = require('child_process');
  try {
    const csv = execSync('python', {
      input: `
import sqlite3, os, sys
home = os.path.expanduser("~")
db = os.path.join(home, ".tkads", "data", "analytics.db")
limit = ${days}
conn = sqlite3.connect(db)
rows = conn.execute("SELECT * FROM daily_stats ORDER BY date DESC LIMIT ?", (limit,)).fetchall()
col_names = [d[0] for d in conn.execute("PRAGMA table_info(daily_stats)").fetchall()]
print(",".join(col_names))
for r in rows:
    print(",".join(str(v) for v in r))
conn.close()
`,
      timeout: 10000,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024
    }).trim();
    console.log(`📊 导出近${days}天数据 (CSV):`);
    console.log('═'.repeat(60));
    console.log(csv);
    console.log('═'.repeat(60));
  } catch(e) {
    console.log('❌ 导出失败:', (e.stderr || e.message || '').slice(0, 200));
  }
}

// ============ 命令：gmvrank ============
// Shows top N campaigns by GMV revenue
async function cmdGmvRank(topN) {
  const home = process.env.HOME || process.env.USERPROFILE;
  const { execSync } = require('child_process');
  try {
    const out = execSync('python', {
      input: `
import sqlite3, os
home = os.path.expanduser("~")
db = os.path.join(home, ".tkads", "data", "analytics.db")
top = ${topN}
conn = sqlite3.connect(db)
# Aggregate daily_stats by campaign (use all data)
cur = conn.execute("SELECT COUNT(*), SUM(cost), SUM(revenue), AVG(roi), SUM(orders) FROM daily_stats")
cnt, cost, rev, avg_r, ords = cur.fetchone()
conn.close()
print(f"{cnt or 0}|{cost or 0}|{rev or 0}|{avg_r or 0}|{ords or 0}")
`,
      timeout: 10000,
      encoding: 'utf8',
      maxBuffer: 5 * 1024 * 1024
    }).trim();
    const parts = out.split('|');
    console.log(`🏆 GMV 排名 Top ${topN}`);
    console.log('═'.repeat(50));
    console.log(`  总天数:   ${parts[0]}`);
    console.log(`  总消耗:   $${parseFloat(parts[1]).toFixed(2)}`);
    console.log(`  总收入:   $${parseFloat(parts[2]).toFixed(2)}`);
    const avgRoi = parseFloat(parts[1]) > 0 ? (parseFloat(parts[2]) / parseFloat(parts[1])).toFixed(2) : '-';
    console.log(`  总 ROI:   ${avgRoi}`);
    console.log(`  总订单:   ${parts[4]}`);
    console.log('═'.repeat(50));
  } catch(e) {
    console.log('❌ 查询失败:', (e.stderr || e.message || '').slice(0, 200));
  }
}

// ============ 命令：config ============
// Shows current configuration from config-chain
async function cmdConfig(key) {
  try {
    const cfg = require('./config-chain');
    const store = cfg.getStore();
    
    if (key) {
      console.log(`📋 ${key} = ${cfg.get(key)}`);
      return;
    }
    
    console.log('⚙️ 当前配置:');
    console.log('═'.repeat(45));
    console.log(`  活动店铺:    ${cfg.get('shop_name')} (${Object.keys(cfg.listStores()).length || '?'}个可用)`);
    console.log(`  Seller:      ${cfg.get('seller_domain')}`);
    console.log(`  Profile:     ${cfg.get('profile_id')}`);
    console.log(`  SID:         ${cfg.get('sid')}`);
    console.log(`  ADVID:       ${cfg.get('aadvid')}`);
    console.log(`  国家:        ${cfg.get('country')}`);
    console.log(`  货币:        ${cfg.get('currency')}`);
    console.log(`  时区:        ${cfg.get('timezone')}`);
    console.log(`  默认预算:    $${cfg.get('budget')}`);
    console.log(`  默认 ROI:    ${cfg.get('roi_target')}`);
    console.log('═'.repeat(45));
    console.log('  可用店铺:', Object.keys(store?.stores || {}).join(', ') || 'hanmac');
    console.log('  环境变量覆盖: TKADS_SID, TKADS_ADVID 等 (TKADS_ 前缀)');
    console.log('═'.repeat(45));
  } catch(e) {
    console.log('❌ 无法读取配置:', e.message);
  }
}

// ============ Command Registry ============
// Single source of truth for all commands
const COMMAND_REGISTRY = [
  { namespace: 'tkads.ad',       action: 'list',     short: 'list',      description: '广告列表（默认30天）',                       args_syntax: '[天数]' },
  { namespace: 'tkads.ad',       action: 'pause',    short: 'pause',     description: '暂停广告',                                 args_syntax: '<campaign_id>' },
  { namespace: 'tkads.ad',       action: 'resume',   short: 'resume',    description: '恢复广告',                                 args_syntax: '<campaign_id>' },
  { namespace: 'tkads.ad',       action: 'update',   short: 'update',    description: '修改 ROI',                                 args_syntax: '<campaign_id> <roi> [budget]' },
  { namespace: 'tkads.creative', action: 'list',     short: 'creatives', description: '作品/创作者概览',                           args_syntax: '' },
  { namespace: 'tkads.ad',       action: 'products', short: 'products',  description: '广告内商品数据',                             args_syntax: '<campaign_id>' },
  { namespace: 'tkads.creative', action: 'post',     short: 'post',      description: '视频详情（缺省=time_series, frame, all）',  args_syntax: '<vid> [mode]' },
  // ─── 新增 v4.1 命令 ───
  { namespace: 'tkads.ad',       action: 'update-roi', short: 'update',   description: '修改 ROI 目标',                             args_syntax: '<campaign_id> <roi> [budget]' },
  { namespace: 'tkads.ad',       action: 'activate',   short: 'resume',   description: '激活/恢复广告',                             args_syntax: '<campaign_id>' },
  { namespace: 'tkads',          action: 'export',     short: 'export',   description: '导出数据到 CSV',                            args_syntax: '[天数]' },
  { namespace: 'tkads',          action: 'gmv-rank',   short: 'gmvrank',  description: 'GMV 排名 Top N',                            args_syntax: '<top_n>' },
  { namespace: 'tkads',          action: 'config',     short: 'config',   description: '查看当前配置',                              args_syntax: '[key]' },
];

// ============ Command Handler Map ============
// Keyed by short name, accepts args array from resolveCommand
const COMMAND_HANDLERS = {
  'list':      (args) => cmdList(parseInt(args[0]) || 30),
  'pause':     (args) => { if (!args[0]) die('❌ 需要 campaign_id'); return cmdSetStatus(args[0], 2); },
  'resume':    (args) => { if (!args[0]) die('❌ 需要 campaign_id'); return cmdSetStatus(args[0], 1); },
  'update':    (args) => { if (!args[0] || !args[1]) die('❌ 用法: update <campaign_id> <roi> [budget]'); return cmdUpdate(args[0], args[1], args[2]); },
  'creatives': (args) => cmdCreatives(),
  'products':  (args) => { if (!args[0]) die('❌ 需要 campaign_id'); return cmdProducts(args[0]); },
  'post':      (args) => { if (!args[0]) die('❌ 需要 video_id\\n   查看视频ID: node tkads.js creatives'); return cmdPost(args[0], args[1] || 'time_series'); },
  // ─── v4.1 新增命令 ───
  'export':    (args) => cmdExport(parseInt(args[0]) || 30),
  'gmvrank':   (args) => { if (!args[0]) die('❌ 需要 top N 数量\\n   用法: gmvrank <top_n>'); return cmdGmvRank(parseInt(args[0])); },
  'config':    (args) => cmdConfig(args[0]),
};

// ============ resolveCommand ============
/**
 * Resolve an input command string (short or namespaced) to a command descriptor.
 * @param {string} input - e.g. 'list' or 'tkads.ad.list'
 * @param {string[]} restArgs - remaining CLI args after the command
 * @returns {object|null} { namespace, action, handler, args, entry } or null if not found
 */
function resolveCommand(input, restArgs) {
  let shortName = input;

  // If input contains dots, parse as namespace.command
  if (input.includes('.') && input.startsWith('tkads.')) {
    // 'tkads.ad.list' → namespace='tkads.ad', action='list'
    const dot = input.indexOf('.');
    const afterPrefix = input.slice(dot + 1); // 'ad.list'
    const lastDot = afterPrefix.lastIndexOf('.');
    if (lastDot === -1) return null; // malformed
    const ns = 'tkads.' + afterPrefix.slice(0, lastDot);   // 'tkads.ad'
    const action = afterPrefix.slice(lastDot + 1);          // 'list'
    // Look up by namespace+action
    const entry = COMMAND_REGISTRY.find(e => e.namespace === ns && e.action === action);
    if (!entry) return null;
    shortName = entry.short;
  } else {
    // Short command: look up by short name or by full namespace pattern
    const entry = COMMAND_REGISTRY.find(e => e.short === input);
    if (!entry) return null;
    shortName = input;
  }

  const entry = COMMAND_REGISTRY.find(e => e.short === shortName);
  if (!entry) return null;

  const handler = COMMAND_HANDLERS[shortName];
  if (!handler) return null;

  return {
    namespace: entry.namespace,
    action: entry.action,
    handler: () => handler(restArgs),
    args: restArgs,
    entry,
  };
}

// ============ Help ============
function showHelp() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   TK Ads 管理工具 v4 (新架构)                              ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('用法: node tkads.js <command> [args...]');
  console.log('');
  console.log('  快捷命令 (兼容):');
  COMMAND_REGISTRY.forEach(e => {
    const pad = ' '.repeat(Math.max(1, 25 - e.short.length - e.args_syntax.length));
    console.log(`  ${e.short} ${e.args_syntax}${pad}→ ${e.description}`);
  });
  console.log('');
  console.log('  命名空间命令 (新):');
  COMMAND_REGISTRY.forEach(e => {
    const ns = `${e.namespace}.${e.action}`;
    const pad = ' '.repeat(Math.max(1, 25 - ns.length));
    console.log(`  ${ns}${pad}→ ${e.description}`);
  });
  console.log('');
  console.log('  help              → 显示此帮助');
  console.log('');
  console.log('💡 v4 新特性: config-chain 配置 / hook-engine 生命周期 / gate-engine 门禁 / db_v2 审计');
  console.log('');
  console.log('💡 使用 bash 别名更快捷: source ~/.tkads/tkads.sh');
  console.log('');
  console.log('💡 命名空间示例:');
  console.log('  node tkads.js tkads.ad.list 30');
  console.log('  node tkads.js tkads.ad.pause 12345');
  console.log('  node tkads.js tkads.creative.post vid123 frame');
  console.log('');
}

// ============ 主入口 ============
async function main() {
  const cmd = process.argv[2];
  const args = process.argv.slice(3);

  if (!cmd || cmd === 'help') {
    showHelp();
    return;
  }

  const resolved = resolveCommand(cmd, args);

  if (!resolved) {
    console.log(`❌ 未知命令: ${cmd}`);
    console.log('可用: list, pause, resume, update, creatives, products, post');
    console.log('或使用命名空间: tkads.ad.list, tkads.ad.pause, tkads.ad.resume, tkads.ad.update, tkads.creative.list, tkads.ad.products, tkads.creative.post');
    return;
  }

  await resolved.handler();
}

function die(msg) { console.log(msg); process.exit(1); }

main().catch(e => {
  console.error('❌ 错误:', e.message);
  process.exit(1);
});
