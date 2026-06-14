#!/usr/bin/env node
/**
 * gmvmax/manager.js — GMV Max 广告管理工具（不含采集）
 *
 * 独立 CLI 工具，无需外部模块（config-chain/hook-engine/gate-engine/db_v2）
 * 通过 CDP 拦截 + page.evaluate fetch() 直接调用卖家中心 API
 *
 * 用法:
 *   node gmvmax/manager.js list              # 列出活动广告
 *   node gmvmax/manager.js pause <id>        # 暂停广告
 *   node gmvmax/manager.js resume <id>       # 恢复广告
 *   node gmvmax/manager.js update <id> <roi> [budget]  # 修改ROI/预算
 *   node gmvmax/manager.js help              # 帮助
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ============ 硬编码配置（可从 stores.json 覆盖） ============
const HOME = process.env.HOME || process.env.USERPROFILE || '~';
const TKADS_DIR = path.resolve(HOME, '.tkads');
const STORES_PATH = path.join(TKADS_DIR, 'stores.json');

// 默认配置（hanmac 店铺）
let CONFIG = {
  ADS_URL: 'http://local.adspower.net:50325',
  SERIAL_NUMBER: '27',
  SELLER_DOMAIN: 'seller-my.tiktok.com',
  SELLER_ID: '7494105016200037977',
  ADV_ID: '7569565674088136705',
  API_BASE: 'https://seller-my.tiktok.com/oec_ads/shopping/v1',
};

// 尝试从 stores.json 读取配置
try {
  if (fs.existsSync(STORES_PATH)) {
    const stores = JSON.parse(fs.readFileSync(STORES_PATH, 'utf8'));
    const store = stores.stores && stores.stores.hanmac;
    if (store) {
      if (store.seller_domain) CONFIG.SELLER_DOMAIN = store.seller_domain;
      if (store.sid) CONFIG.SELLER_ID = store.sid;
      if (store.aadvid) CONFIG.ADV_ID = store.aadvid;
      if (store.ads_url) CONFIG.ADS_URL = store.ads_url;
      CONFIG.API_BASE = `https://${CONFIG.SELLER_DOMAIN}/oec_ads/shopping/v1`;
      CONFIG.STORES_CONFIG = store;
    }
  }
} catch (e) {
  // stores.json 读取失败则使用硬编码配置
}

// ============ 工具函数 ============
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({ raw: d }); } });
    }).on('error', reject);
  });
}

function help() {
  console.log(`
📦 GMV Max 广告管理工具

用法:
  node gmvmax/manager.js list              列出活动广告
  node gmvmax/manager.js pause <id>        暂停广告
  node gmvmax/manager.js resume <id>       恢复广告
  node gmvmax/manager.js update <id> <roi> [budget]  修改ROI/预算
  node gmvmax/manager.js help              显示此帮助

示例:
  node gmvmax/manager.js list
  node gmvmax/manager.js pause 1234567890
  node gmvmax/manager.js resume 1234567890
  node gmvmax/manager.js update 1234567890 2.5
  node gmvmax/manager.js update 1234567890 2.5 30
`);
}

// ============ 浏览器管理（serial_number 方式，与 store_health.js 一致） ============
async function getBrowserWS() {
  const url = `${CONFIG.ADS_URL}/api/v1/browser/start?serial_number=${CONFIG.SERIAL_NUMBER}&open_tabs=1`;
  const info = await httpGet(url);
  if (info.code !== 0 || !info.data?.ws?.puppeteer) {
    throw new Error(`启动浏览器失败: ${info.msg || JSON.stringify(info)}`);
  }
  return info.data.ws.puppeteer;
}

async function connectBrowser() {
  const ws = await getBrowserWS();
  const puppeteer = require('puppeteer-core');
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
  try { await browser.disconnect(); } catch(e) { /* ignore */ }
}

// ============ 命令：list ============
async function cmdList() {
  console.log('📊 正在获取广告列表...');
  const { browser } = await connectBrowser();
  try {
    const np = await browser.newPage();
    const cdp = await np.target().createCDPSession();
    await cdp.send('Network.enable');

    let raw = null;
    cdp.on('Network.responseReceived', async params => {
      if (params.response.url.includes('post_campaign_list')) {
        try {
          raw = JSON.parse(
            (await cdp.send('Network.getResponseBody', { requestId: params.requestId })).body
          );
        } catch(e) { /* ignore parse failure */ }
      }
    });

    await np.goto(`https://${CONFIG.SELLER_DOMAIN}/ads-creation/dashboard`, {
      waitUntil: 'networkidle0', timeout: 30000
    });
    await sleep(8000);

    if (!raw || !raw.data?.table) {
      console.log('❌ 无法获取数据');
      console.log('   提示：请检查是否已登录 Seller Center');
      return;
    }

    const table = raw.data.table;
    const delivery = table.filter(t => t.campaign_primary_status === 'delivery_ok');
    const totalCost = delivery.reduce((s, t) => s + parseFloat(t.cost || 0), 0);
    const totalOrders = delivery.reduce((s, t) => s + parseInt(t.onsite_roi2_shopping_sku || 0), 0);
    const totalRevenue = delivery.reduce((s, t) => s + parseFloat(t.onsite_roi2_shopping_value || 0), 0);
    const avgROI = totalCost > 0 ? (totalRevenue / totalCost).toFixed(2) : '-';

    const fp = v => {
      const n = parseFloat(v);
      return isNaN(n) ? '-      ' : n.toFixed(2).padStart(6);
    };

    console.log('');
    console.log('📊 GMV Max 广告列表');
    console.log(`   日期: ${new Date().toLocaleDateString('zh-CN')}`);
    console.log('═'.repeat(110));

    for (const t of table) {
      const statusIcon = t.campaign_primary_status === 'delivery_ok' ? '🟢' :
                         t.campaign_primary_status === 'delete' ? '⚫' : '🟡';
      const name = (t.campaign_name || '').split('-')[0] || t.campaign_id.slice(-6);
      const target = parseFloat(t.template_ad_roas_bid);
      const actual = parseFloat(t.onsite_roi2_shopping);
      let flag = '   ';
      if (t.campaign_primary_status === 'delivery_ok' && !isNaN(target) && !isNaN(actual)) {
        const diff = ((actual - target) / target * 100).toFixed(0);
        flag = diff > 0 ? '📈+' + diff + '%' : '📉' + diff + '%';
      }
      const budget = parseFloat(t.campaign_target_roi_budget);
      const budgetStr = !isNaN(budget) && budget > 0 ? budget.toFixed(2) : '-';

      console.log(
        `${statusIcon} ${name.padEnd(12)} ` +
        `ID:${t.campaign_id.padEnd(16)} ` +
        `目标ROI:${fp(t.template_ad_roas_bid)} ` +
        `实际ROI:${fp(t.onsite_roi2_shopping)} ` +
        `${flag.padStart(8)} ` +
        `消耗:${fp(t.cost)} ` +
        `订单:${(t.onsite_roi2_shopping_sku || '0').padStart(5)} ` +
        `收入:${fp(t.onsite_roi2_shopping_value)} ` +
        `预算:${budgetStr}`
      );
    }

    console.log('═'.repeat(110));
    console.log(
      `📊 在投 ${delivery.length} 个 | ` +
      `总消耗: ${totalCost.toFixed(2)} | ` +
      `总订单: ${totalOrders} | ` +
      `总收入: ${totalRevenue.toFixed(2)} | ` +
      `总ROI: ${avgROI}`
    );
    console.log('');
  } finally {
    await disconnect(browser);
  }
}

// ============ 命令：pause / resume ============
async function cmdSetStatus(cid, operation) {
  const isPause = operation === 2;
  const label = isPause ? '暂停' : '恢复';
  console.log(`🔄 正在${label}广告 ${cid}...`);

  const { browser } = await connectBrowser();
  try {
    const page = await getSellerPage(browser);
    const result = await page.evaluate(async (id, op, sid, advid) => {
      const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] || '';
      const base = `?locale=zh&language=zh&oec_seller_id=${sid}&aadvid=${advid}`;
      try {
        const res = await fetch(
          `/oec_ads/shopping/v1/creation/campaign/update_status${base}`,
          {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/json',
              'x-csrftoken': csrf,
            },
            body: JSON.stringify({ campaign_list: [id], operation: op }),
          }
        );
        return await res.json();
      } catch (e) {
        return { code: -1, msg: e.message };
      }
    }, cid, operation, CONFIG.SELLER_ID, CONFIG.ADV_ID);

    if (result.code === 0 || result.msg === 'success') {
      console.log(`✅ 已${label} ${cid}`);
    } else {
      console.log(`❌ ${label}失败: ${result.msg || JSON.stringify(result)}`);
    }
  } finally {
    await disconnect(browser);
  }
}

// ============ 命令：update ============
async function cmdUpdate(cid, roi, budget) {
  console.log(`📝 修改广告 ${cid} → ROI=${roi}${budget ? `, 预算=${budget}` : ''}`);

  // 通过 Python 从 DB 获取元数据并构建 body
  const home = TKADS_DIR.replace(/\\/g, '/');
  let body;
  try {
    const pyCode = `
import sys, json
sys.path.insert(0, '${home}')
from db import get_campaign_meta
from api import build_update_body
meta = get_campaign_meta('${cid}')
if not meta:
    print('ERROR:NO_META')
    sys.exit(1)
body = build_update_body(meta, ${roi}${budget ? ', ' + budget : ''})
print(json.dumps(body))
`;
    const out = execSync('python', {
      input: pyCode,
      timeout: 10000,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    }).trim();

    if (out.includes('ERROR:NO_META')) {
      console.log(`❌ ${cid} 在数据库中无元数据`);
      console.log('   请先执行 list 命令查看广告，或确认广告已创建并被系统捕获。');
      return;
    }
    body = JSON.parse(out);
  } catch (e) {
    const msg = (e.stderr || e.message || e.stdout || '').toString().substring(0, 300);
    console.log(`❌ 构建 body 失败: ${msg}`);
    return;
  }

  // 发送 update API
  console.log('  📤 发送修改请求...');
  const { browser } = await connectBrowser();
  try {
    const page = await getSellerPage(browser);
    const result = await page.evaluate(async (data) => {
      const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] || '';
      const base = `?locale=zh&language=zh&oec_seller_id=${data.sid}&aadvid=${data.advid}`;
      try {
        const res = await fetch(
          `/oec_ads/shopping/v1/creation/all_ad_data/update${base}`,
          {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/json',
              'x-csrftoken': csrf,
            },
            body: JSON.stringify(data.body),
          }
        );
        return await res.json();
      } catch (e) {
        return { code: -1, msg: e.message };
      }
    }, { body, sid: CONFIG.SELLER_ID, advid: CONFIG.ADV_ID });

    if (result.code === 0) {
      console.log(`✅ 修改成功！${cid} → ROI=${roi}${budget ? `, 预算=${budget}` : ''}`);
    } else {
      console.log(`❌ 修改失败: ${result.msg || JSON.stringify(result)}`);
    }
  } finally {
    await disconnect(browser);
  }
}

// ============ CLI 入口 ============
(async () => {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    help();
    return;
  }

  switch (cmd) {
    case 'list':
      await cmdList();
      break;

    case 'pause': {
      const id = args[1];
      if (!id) { console.log('❌ 请指定 campaign_id\n用法: node gmvmax/manager.js pause <id>'); return; }
      await cmdSetStatus(id, 2);
      break;
    }

    case 'resume': {
      const id = args[1];
      if (!id) { console.log('❌ 请指定 campaign_id\n用法: node gmvmax/manager.js resume <id>'); return; }
      await cmdSetStatus(id, 1);
      break;
    }

    case 'update': {
      const id = args[1];
      const roi = args[2];
      const budget = args[3];
      if (!id || !roi) {
        console.log('❌ 用法: node gmvmax/manager.js update <id> <roi> [budget]');
        return;
      }
      if (isNaN(parseFloat(roi))) {
        console.log('❌ ROI 必须为数字');
        return;
      }
      await cmdUpdate(id, parseFloat(roi), budget ? parseFloat(budget) : null);
      break;
    }

    default:
      console.log(`❌ 未知命令: ${cmd}`);
      help();
      process.exit(1);
  }
})().catch(e => {
  console.error(`\n❌ [FATAL] ${e.message}`);
  process.exit(1);
});
