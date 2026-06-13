#!/usr/bin/env node
/**
 * tkads-puppeteer.js — GMV Max 自动化 v3.0 (B方案)
 * 
 * 基于 Puppeteer + CDP 直接控制浏览器，比 Network 拦截更稳定。
 * 
 * 使用方式：
 *   1. node tkads-puppeteer.js open          # 打开 Hanmac 浏览器
 *   2. node tkads-puppeteer.js list           # 列出广告系列
 *   3. node tkads-puppeteer.js update <id> <roi> [budget]  # 修改 ROI/预算
 *   4. node tkads-puppeteer.js pause <id>     # 暂停广告
 *   5. node tkads-puppeteer.js resume <id>    # 启动广告
 *   6. node tkads-puppeteer.js create          # 创建新 GMV Max (交互式)
 */

const puppeteer = require('puppeteer-core');
const http = require('http');

const PROFILE_ID = 'k1456ta2';  // 马来-TK-Hanmac企业店
const ADSPOWER_API = 'http://127.0.0.1:50325';
const SELLER_BASE = 'https://seller-my.tiktok.com';
const SELLER_ID = '7494105016200037977';
const AADVID = '7569565674088136705';

// ===== 浏览器管理 =====

async function openBrowser() {
  const url = `${ADSPOWER_API}/api/v1/browser/start?user_id=${PROFILE_ID}&open_urls=${encodeURIComponent(SELLER_BASE)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.code !== 0) throw new Error(`AdsPower error: ${JSON.stringify(data)}`);
  
  const wsUrl = data.data.ws.puppeteer;
  console.log(`✅ 浏览器已打开`);
  console.log(`   CDP: ${wsUrl}`);
  console.log(`   Debug port: ${data.data.debug_port}`);
  return wsUrl;
}

async function getBrowser() {
  // 检查是否已有打开的浏览器
  try {
    const res = await fetch(`http://127.0.0.1:63098/json/version`);
    if (res.ok) {
      const info = await res.json();
      console.log(`✅ 浏览器已在运行: ${info.Browser}`);
      return 'ws://127.0.0.1:63098/devtools/browser/8d5aa1fe-c7d4-47a6-a58e-595ec3d66443';
    }
  } catch(e) {}
  
  // 没有则打开
  return await openBrowser();
}

async function ensurePage(browser) {
  const pages = await browser.pages();
  // 找 seller center 页面
  for (const p of pages) {
    const url = p.url();
    if (url.includes('seller-my.tiktok.com')) {
      console.log(`   使用已有 Seller Center 页面`);
      return p;
    }
  }
  // 新建页面并导航
  const page = await browser.newPage();
  await page.goto(SELLER_BASE, { waitUntil: 'networkidle0', timeout: 30000 });
  console.log(`   已导航到 Seller Center`);
  return page;
}

// ===== Seller Center API 调用 =====

async function apiCall(page, endpoint, method = 'POST', body = null) {
  const result = await page.evaluate(async (opts) => {
    const url = `${opts.endpoint}?locale=zh&language=zh&oec_seller_id=${opts.sellerId}&aadvid=${opts.aadvid}`;
    const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] || '';
    
    const res = await fetch(url, {
      method: opts.method,
      credentials: 'include',
      headers: {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json; charset=UTF-8',
        'x-csrftoken': csrf,
        'origin': 'https://seller-my.tiktok.com',
        'referer': window.location.href
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    
    const data = await res.json();
    return { status: res.status, data };
  }, { endpoint, method, body, sellerId: SELLER_ID, aadvid: AADVID });
  
  return result;
}

async function getCampaignList(page) {
  const r = await apiCall(page, 
    '/oec_ads/shopping/v1/oec/stat/post_campaign_list', 'POST',
    { page: 1, page_size: 50, filter: [], sort_field: 'create_time', sort_order: 'DESC' }
  );
  return r;
}

async function updateCampaign(page, body) {
  const r = await apiCall(page,
    '/oec_ads/shopping/v1/creation/all_ad_data/update', 'POST', body
  );
  return r;
}

async function toggleCampaign(page, campaignId, op) {
  const r = await apiCall(page,
    '/oec_ads/shopping/v1/creation/campaign/update_status', 'POST',
    { campaign_id: campaignId, op }
  );
  return r;
}

// ===== 数据库操作 =====

function getMeta(campaignId) {
  try {
    const db = require('./db.js');
    return db.get_campaign_meta?.(campaignId) || null;
  } catch(e) {
    return null;
  }
}

function getAllMeta() {
  try {
    const db = require('./db.js');
    return db.get_all_meta?.() || [];
  } catch(e) {
    return [];
  }
}

// ===== 主命令处理 =====

async function main() {
  const cmd = process.argv[2];
  
  if (!cmd || cmd === 'open') {
    const wsUrl = await openBrowser();
    console.log(`\n连接命令: node tkads-puppeteer.js list`);
    return;
  }
  
  // 连接到已打开的浏览器
  const wsUrl = await getBrowser();
  const browser = await puppeteer.connect({ browserWSEndpoint: wsUrl });
  
  try {
    if (cmd === 'list') {
      const page = await ensurePage(browser);
      console.log('\n获取广告列表...');
      const r = await getCampaignList(page);
      if (r.data?.code === 0) {
        const list = r.data.data?.campaign_list || [];
        console.log(`\n📊 GMV Max 广告列表 (${list.length} 个):`);
        console.log('='.repeat(90));
        for (const c of list) {
          const roi = c.roas_bid || '-';
          const budget = c.budget || '-';
          const status = c.campaign_primary_status || c.status || '-';
          console.log(`  ID: ${c.campaign_id}\n    ${c.campaign_name}\n    ROI: ${roi} | 预算: ${budget} | 状态: ${status}\n`);
        }
      } else {
        console.log('API 返回:', JSON.stringify(r.data));
      }
    }
    
    else if (cmd === 'update') {
      const campaignId = process.argv[3];
      const roi = process.argv[4];
      const budget = process.argv[5];
      if (!campaignId || !roi) {
        console.log('用法: node tkads-puppeteer.js update <campaign_id> <roi> [budget]');
        return;
      }
      
      // 从数据库获取元数据
      const meta = getMeta(campaignId);
      if (!meta) {
        console.log(`⚠️ 未找到 campaign_id=${campaignId} 的元数据`);
        console.log('   需要先采集元数据或手动提供参数。');
        const page = await ensurePage(browser);
        console.log('\n尝试直接从 API 获取...');
        const r = await getCampaignList(page);
        console.log(JSON.stringify(r.data, null, 2).substring(0, 1000));
        return;
      }
      
      const page = await ensurePage(browser);
      console.log(`\n修改广告: ${meta.product_name}`);
      console.log(`  ROI: ${roi}${budget ? ` | 预算: ${budget}` : ''}`);
      
      // 构建 body - 复用 API 逻辑
      const { build_update_body } = require('./api.py'); // 不能直接 require python
      // 手动构建
      const adjRoi = Math.round(parseFloat(roi) * 0.9 * 10) / 10;
      const body = buildBody(meta, roi, budget);
      
      const r = await updateCampaign(page, body);
      if (r.data?.code === 0) {
        console.log(`✅ 修改成功!`);
      } else {
        console.log(`❌ 失败:`, JSON.stringify(r.data));
      }
    }
    
    else if (cmd === 'pause' || cmd === 'resume') {
      const campaignId = process.argv[3];
      if (!campaignId) {
        console.log(`用法: node tkads-puppeteer.js ${cmd} <campaign_id>`);
        return;
      }
      const op = cmd === 'pause' ? 2 : 1;
      const page = await ensurePage(browser);
      console.log(`${cmd === 'pause' ? '暂停' : '启动'}广告: ${campaignId}`);
      const r = await toggleCampaign(page, campaignId, op);
      console.log(r.data?.code === 0 ? '✅ 成功!' : `❌ 失败: ${JSON.stringify(r.data)}`);
    }
    
    else {
      console.log('未知命令。可用命令: open, list, update, pause, resume');
    }
    
  } finally {
    await browser.disconnect();
  }
}

function buildBody(meta, roi, budget) {
  const adjRoi = Math.round(parseFloat(roi) * 0.9 * 10) / 10;
  const b = budget ? parseFloat(budget) : parseFloat(meta.budget || 200);
  return {
    campaign_info: {
      campaign_id: meta.campaign_id,
      campaign_name: meta.product_name,
      budget_mode: -1,
      budget: b.toFixed(2),
      shop_automation_type: 2,
      shop_image_aigc_mode: 0
    },
    ad_info: {
      name: meta.product_name,
      campaign_id: meta.campaign_id,
      ad_id: meta.ad_id || '',
      inventory_flow_type: 0,
      inventory_flow: [3000, 9000],
      inventory_type: [11180001, 11180007, 11180532, 11180533, 11233001, 11233007, 11233532, 11233533, 900000000],
      shopping_inventory_type: 1,
      external_type: 0,
      schedule_type: 1,
      start_time: meta.start_time || '',
      budget_mode: 0,
      budget: b.toFixed(2),
      product_video_selection_type: 1,
      pricing: 9,
      optimize_goal: 111,
      external_action: 0,
      deep_bid_type: 108,
      roas_bid: String(roi),
      product_platform_id: '0',
      country: 'MY',
      shop_id: '7494105016200037977',
      shop_authorized_bc: '7545376144372318224',
      promotion_flow_type: 5,
      product_source: 2,
      product_bid_type: 0,
      custom_tz_id: meta.custom_tz_id || '7473424031757336583',
      custom_tz_type: meta.custom_tz_type || 1,
      promotion_days_setting: {
        is_enable: true, automode_enable: true,
        roas_bid_multiplier: 90, budget_multiplier: 150,
        adjusted_budget: Math.round(b * 1.5),
        adjusted_roas_bid: String(adjRoi),
        benchmark_roas_bid: parseFloat(roi),
        custom_schedules: []
      },
      compensation_activity_type: 3,
      gmax_budget_adjust_setting: {
        auto_budget_switch: false,
        effective_budget: b,
        current_adjust_times: 0,
        strategy: 2,
        promotion_day_adjust_config: { adjust_ratio: 0.5, max_daily_adjust_times: 10 }
      },
      audience: { brand_safety: 1 },
      product_list: [{ spu_id: meta.spu_id || '' }],
      product_specific_type: 3,
      identity_list: [{ tt_uid: '7550180591812412432', identity_type: 8 }],
      custom_anchor_videos: [],
      shop_aca_mode: 1,
      enable_shop_video_exclusion_filter: true,
      shop_video_filters: [],
      shop_new_creative_exploration: 1,
      pre_item_list: []
    },
    risk_info: {
      cookie_enabled: true, screen_width: 1707, screen_height: 1067,
      browser_language: 'en-US', browser_platform: 'Win32',
      browser_name: 'Mozilla',
      browser_version: '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
      browser_online: true, timezone_name: 'Asia/Kuala_Lumpur'
    }
  };
}

main().catch(err => {
  console.error('❌ 错误:', err.message);
  process.exit(1);
});
