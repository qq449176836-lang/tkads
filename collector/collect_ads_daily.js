#!/usr/bin/env node
/**
 * collect_ads_daily.js — 统一广告逐日数据采集器
 * 
 * ⚡ 铁律：每次只采一天！每个日期独立调用！
 * 
 * 采集范围：
 *   1. 商品层 → 每个Campaign的当天累计数据
 *   2. 店铺层 → 全店当天数据
 *   3. 活动级 → 所有Campaign当天汇总
 *   4. 内容层 → 视频/直播/商品卡当天GMV拆分
 *   5. 小时级内容趋势 → LIVE/Video/Product Card按小时拆分
 *   6. 视频素材概览 → Top视频列表
 *   7. 达人数据概览 → Top达人列表
 * 
 * 用法：node collect_ads_daily.js            # 采昨天（默认）
 *       node collect_ads_daily.js --date 2026-06-11   # 采指定日期
 * 
 * 保存：scripts/ads_daily_{date}.json
 */

const puppeteer = require('puppeteer-core');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ADSPOWER_API = 'http://local.adspower.net:50325';
const PROFILE_SN = '27';
const SCRIPTS_DIR = __dirname;
const SELLER_ID = '7494105016200037977';
const ADV_ID = '7569565674088136705';
const API_BASE = '/oec_ads/shopping/v1/oec/stat';
const URL_SUFFIX = `?locale=en&language=en&oec_seller_id=${SELLER_ID}&aadvid=${ADV_ID}`;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getWs() {
  return new Promise((resolve, reject) => {
    http.get(`${ADSPOWER_API}/api/v1/browser/start?serial_number=${PROFILE_SN}&open_tabs=1`, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (j.code === 0 && j.data?.ws?.puppeteer) resolve(j.data.ws.puppeteer);
          else reject(new Error(j.msg || d));
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function apiPost(page, endpoint, body) {
  return await page.evaluate(async ({ ep, suf, body }) => {
    try {
      const r = await fetch(ep + suf, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      return await r.json();
    } catch (e) { return { error: e.message }; }
  }, { ep: endpoint, suf: URL_SUFFIX, body });
}

function parseArgs() {
  const args = process.argv.slice(2);
  let date;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--date') date = args[i + 1];
  }
  if (date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      console.error('❌ 日期格式错误，请使用 YYYY-MM-DD');
      process.exit(1);
    }
    return date;
  }
  // 默认采昨天
  return new Date(Date.now() - 86400000).toISOString().split('T')[0];
}

function parseAmount(val) {
  if (!val) return 0;
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    try {
      const p = JSON.parse(val);
      if (typeof p === 'number') return p;
      if (p && typeof p === 'object') return parseFloat(p.amount) || parseFloat(p.value) || 0;
      return parseFloat(p) || 0;
    } catch (e) { return parseFloat(val) || 0; }
  }
  return 0;
}

(async () => {
  const targetDate = parseArgs();
  console.log('='.repeat(60));
  console.log('📢 统一广告逐日采集');
  console.log('  日期:', targetDate);
  console.log('='.repeat(60));

  const ws = await getWs();
  const browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null });
  const page = await browser.newPage();

  // 加载Dashboard建立会话
  console.log('\n[1/7] 加载GMV Max面板...');
  await page.goto('https://seller-my.tiktok.com/ads-creation/dashboard?shop_region=MY&lang=en', {
    waitUntil: 'networkidle0', timeout: 60000
  });
  await sleep(5000);

  const startTime = Date.now();
  const result = {
    date: targetDate,
    collected_at: new Date().toISOString(),
    campaigns: null,          // 商品层：Campaign列表（截止当天的累计）
    shop_daily: null,         // 店铺层：当天数据
    activity_total: null,     // 活动级：当天汇总
    content_breakdown: null,  // 内容层：当天拆分
    hourly_trend: null,       // 小时级内容趋势
    video_overview: null,     // 视频素材概览
    video_list: null,         // Top视频列表
    creator_overview: null,   // 达人概览
    creator_list: null        // Top达人列表
  };

  // ═══════════════════════════════════════════
  // 1. 商品层：Campaign完整数据（截止当天的累计值）
  // ═══════════════════════════════════════════
  console.log('\n[2/7] 商品层：Campaign列表...');
  const campBody = {
    query_list: [
      "campaign_id", "campaign_name", "campaign_primary_status", "campaign_status",
      "campaign_target_roi_budget", "template_ad_roas_bid", "template_ad_start_time", "template_ad_end_time",
      "cost", "onsite_roi2_shopping_sku", "onsite_roi2_shopping_value", "onsite_roi2_shopping",
      "cost_per_onsite_roi2_shopping_sku", "billed_cost", "basic_cost", "creative_nobid_cost", "all_boost_cost",
      "compensation_info", "campaign_budget_mode", "campaign_no_bid_budget", "campaign_additional_budget",
      "auto_increase_budget_effective_budget", "gmax_advance_mode", "current_optimization_mode",
      "template_ad_schedule_type", "campaign_opt_status", "campaign_eligible_status",
      "campaign_eligible_roi", "campaign_eligible_reject_reason"
    ],
    start_time: '2026-01-01', end_time: targetDate,
    order_field: 'cost', order_type: 1, page: 1,
    campaign_status: ['no_delete'],
    campaign_shop_automation_type: 2,
    external_type_list: ['304', '307']
  };

  const campRes = await apiPost(page, API_BASE + '/post_campaign_list', campBody);
  if (campRes.code === 0 && campRes.data?.table) {
    result.campaigns = campRes.data.table.map(c => {
      let productId = null;
      const m = (c.campaign_name || '').match(/-(d{19})$/);
      if (m) productId = m[1];
      return {
        campaign_id: c.campaign_id,
        campaign_name: c.campaign_name,
        product_id: productId,
        status: c.campaign_primary_status,
        schedule_type: c.template_ad_schedule_type,
        start_time: c.template_ad_start_time,
        end_time: c.template_ad_end_time,
        daily_budget: parseFloat(c.campaign_target_roi_budget) || 0,
        target_roas: parseFloat(c.template_ad_roas_bid) || 0,
        auto_budget_cap: parseFloat(c.auto_increase_budget_effective_budget) || 0,
        budget_mode: c.campaign_budget_mode,
        no_bid_budget: parseFloat(c.campaign_no_bid_budget) || 0,
        additional_budget: parseFloat(c.campaign_additional_budget) || 0,
        cost: parseFloat(c.cost) || 0,
        billed_cost: parseFloat(c.billed_cost) || 0,
        basic_cost: parseFloat(c.basic_cost) || 0,
        no_bid_cost: parseFloat(c.creative_nobid_cost) || 0,
        boost_cost: parseFloat(c.all_boost_cost) || 0,
        gmv: parseFloat(c.onsite_roi2_shopping_value) || 0,
        orders: parseInt(c.onsite_roi2_shopping_sku) || 0,
        roas: parseFloat(c.onsite_roi2_shopping) || 0,
        cpa: parseFloat(c.cost_per_onsite_roi2_shopping_sku) || 0,
        gmax_advance_mode: c.gmax_advance_mode,
        optimization_mode: c.current_optimization_mode
      };
    });
    console.log(`  ✅ ${result.campaigns.length} 个Campaign`);
    const tc = result.campaigns.reduce((s, c) => s + c.cost, 0);
    const tg = result.campaigns.reduce((s, c) => s + c.gmv, 0);
    const to = result.campaigns.reduce((s, c) => s + c.orders, 0);
    console.log(`     总消耗: RM${tc.toFixed(2)} | 总GMV: RM${tg.toFixed(2)} | 总订单: ${to} | ROAS: ${tc > 0 ? (tg / tc).toFixed(2) : '-'}`);
  } else {
    console.log('  ❌', campRes.msg || campRes.message || '未知错误');
  }

  // ═══════════════════════════════════════════
  // 2. 店铺层 + 活动级：当天逐日数据
  // ═══════════════════════════════════════════
  console.log('\n[3/7] 店铺层 + 活动级：当天数据...');

  // 使用单日范围：start=targetDate, end=targetDate+7天
  // （API固定8天窗口，但只取targetDate那天的数据）
  const rangeEnd = new Date(new Date(targetDate).getTime() + 7 * 86400000).toISOString().split('T')[0];

  // 店铺层
  const shop = await apiPost(page, API_BASE + '/post_shop_overview_stat', {
    query_list: [
      "overall_onsite_shopping_value", "overall_onsite_shopping_value_usd",
      "dollar_cost", "overall_onsite_order_count", "overall_onsite_roas"
    ],
    start_time: targetDate, end_time: rangeEnd
  });
  if (shop.code === 0 && shop.data) {
    result.shop_daily = { date: targetDate, data: shop.data };
    console.log(`  ✅ 店铺层`);
  }

  // 活动级
  const overview = await apiPost(page, API_BASE + '/post_overview_stat', {
    query_list: [
      "cost", "onsite_roi2_shopping_sku", "cost_per_onsite_roi2_shopping_sku",
      "onsite_roi2_shopping_value", "onsite_roi2_shopping"
    ],
    start_time: targetDate, end_time: rangeEnd,
    campaign_shop_automation_type: 2,
    external_type_list: ['307', '304', '305']
  });
  if (overview.code === 0 && overview.data) {
    result.activity_total = { date: targetDate, data: overview.data };
    console.log(`  ✅ 活动级`);
  }

  // ═══════════════════════════════════════════
  // 3. 内容层：当天内容类型拆分
  // ═══════════════════════════════════════════
  console.log('\n[4/7] 内容层：当天内容类型拆分...');

  const prevDate = new Date(new Date(targetDate).getTime() - 86400000).toISOString().split('T')[0];
  const cp = await browser.newPage();
  await cp.goto('https://seller-my.tiktok.com/compass/content-analysis?shop_region=MY&lang=en', {
    waitUntil: 'networkidle0', timeout: 60000
  });
  await sleep(5000);

  const cdata = await cp.evaluate(async ({ date, prev }) => {
    const sr = await fetch('/api/v2/insights/seller/unified/query/us_overview_stats', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query_condition: [{
          query_time: { start: date, end: date, timezone_offset: 28800 },
          compare_to_time: { start: prev, end: prev },
          date_completion: { enabled: true, granularity: 0 },
          where_filter: { ready_time: { value_list: [prev] } },
          group_by: [],
          metrics: [
            { metric_id: 4024, metric_type: 201, abilities: [{ ability_code: "CompareAbility" }] },
            { metric_id: 4027, metric_type: 1, abilities: [{ ability_code: "CompareAbility" }] },
            { metric_id: 4022, metric_type: 1, abilities: [{ ability_code: "CompareAbility" }] },
            { metric_id: 4037, metric_type: 201, abilities: [{ ability_code: "CompareAbility" }] },
            { metric_id: 4033, metric_type: 201, abilities: [{ ability_code: "CompareAbility" }] },
            { metric_id: 4029, metric_type: 201, abilities: [{ ability_code: "CompareAbility" }] }
          ]
        }]
      })
    });
    const statsJson = await sr.json();
    return { overview_stats: statsJson };
  }, { date: targetDate, prev: prevDate });

  result.content_breakdown = cdata;
  const dataLen = cdata?.overview_stats?.data?.length || 0;
  console.log(`  ✅ ${dataLen} 条`);

  await cp.close();

  // ═══════════════════════════════════════════
  // 4. 小时级内容趋势（从content_daily合并）
  // ═══════════════════════════════════════════
  console.log('\n[5/7] 小时级内容趋势（LIVE/Video/商品卡拆分）...');

  const hp = await browser.newPage();
  await hp.setViewport({ width: 1920, height: 1080 });
  const cdp = await hp.target().createCDPSession();
  await cdp.send('Network.enable');

  let hourTrendData = null;

  cdp.on('Network.responseReceived', async (ev) => {
    const url = ev.response?.url || '';
    const status = ev.response?.status || 0;
    if (status !== 200) return;
    try {
      const resp = await cdp.send('Network.getResponseBody', { requestId: ev.requestId });
      const body = resp.base64Encoded ? Buffer.from(resp.body, 'base64').toString('utf8') : resp.body;
      if (!body.startsWith('{') && !body.startsWith('[')) return;
      if (url.includes('hour_trend')) hourTrendData = JSON.parse(body);
    } catch (e) { /* CDP read race, skip */ }
  });

  await hp.goto('about:blank');
  await cdp.send('Network.clearBrowserCache');
  await sleep(1000);

  await hp.goto('https://seller-my.tiktok.com/compass/data-overview?shop_region=MY&lang=en&_t=' + Date.now(), {
    waitUntil: 'networkidle0', timeout: 60000
  });
  await sleep(10000);

  // Parse hourly trend data
  const hourlyResult = {
    hourly: [],
    content_breakdown: {
      live: { gmv: 0, direct_gmv: 0, indirect_gmv: 0, affiliate_gmv: 0, seller_gmv: 0 },
      video: { gmv: 0, direct_gmv: 0, indirect_gmv: 0, affiliate_gmv: 0, seller_gmv: 0 },
      product_card: { gmv: 0, affiliate_gmv: 0, seller_search_gmv: 0, seller_shoptab_gmv: 0 }
    },
    summary: {}
  };

  if (hourTrendData?.data?.[0]?.intervals) {
    const intervals = hourTrendData.data[0].intervals;
    for (const interval of intervals) {
      const row = interval.rows?.[0]?.values || {};
      const date = row.date || interval.start_date?.split(' ')[0] || targetDate;
      const hour = row.hour || interval.start_date?.split(' ')[1]?.split(':')[0] || '00';

      const entry = {
        datetime: `${date} ${hour}:00`,
        date, hour,
        live_gmv: parseAmount(row.flow_con_cl_live_pay_amt),
        live_direct: parseAmount(row.livecon_attr_directcon_pay_amt),
        live_indirect: parseAmount(row.livecon_attr_indirectcon_pay_amt),
        live_affiliate: parseAmount(row.flow_con_cl_live_affiliate_pay_amt),
        live_seller: parseAmount(row.self_operated_live_pay_amt),
        video_gmv: parseAmount(row.flow_con_cl_video_pay_amt),
        video_direct: parseAmount(row.videocon_attr_directcon_pay_amt),
        video_indirect: parseAmount(row.videocon_attr_indirectcon_pay_amt),
        video_affiliate: parseAmount(row.flow_con_cl_video_affiliate_pay_amt),
        video_seller: parseAmount(row.self_operated_video_pay_amt),
        product_card_gmv: parseAmount(row.product_card_pay_amt),
        pc_affiliate: parseAmount(row.affiliate_content_documentary_product_card_payment_amount),
        pc_seller_search: parseAmount(row.self_prodcardcon_attr_search_pay_amt_1d),
        pc_seller_shoptab: parseAmount(row.self_prodcardcon_attr_shoptab_pay_amt_1d),
        total_gmv: parseAmount(row.cl_pay_amt),
        orders: parseInt(row.cl_pay_sku_order_cnt) || 0,
        customers: parseInt(row.cl_pay_order_ucnt) || 0,
        product_views: parseInt(row.product_show_cnt) || 0,
        product_clicks: parseInt(row.product_click_cnt) || 0
      };

      hourlyResult.hourly.push(entry);

      const c = hourlyResult.content_breakdown;
      c.live.gmv += entry.live_gmv;
      c.live.direct_gmv += entry.live_direct;
      c.live.indirect_gmv += entry.live_indirect;
      c.live.affiliate_gmv += entry.live_affiliate;
      c.live.seller_gmv += entry.live_seller;
      c.video.gmv += entry.video_gmv;
      c.video.direct_gmv += entry.video_direct;
      c.video.indirect_gmv += entry.video_indirect;
      c.video.affiliate_gmv += entry.video_affiliate;
      c.video.seller_gmv += entry.video_seller;
      c.product_card.gmv += entry.product_card_gmv;
      c.product_card.affiliate_gmv += entry.pc_affiliate;
      c.product_card.seller_search_gmv += entry.pc_seller_search;
      c.product_card.seller_shoptab_gmv += entry.pc_seller_shoptab;
    }

    const totalGmv = hourlyResult.hourly.reduce((s, h) => s + h.total_gmv, 0);
    const totalOrders = hourlyResult.hourly.reduce((s, h) => s + h.orders, 0);
    const totalCustomers = hourlyResult.hourly.reduce((s, h) => s + h.customers, 0);

    hourlyResult.summary = {
      hourly_intervals: intervals.length,
      total_gmv: totalGmv,
      total_orders: totalOrders,
      total_customers: totalCustomers
    };

    const c = hourlyResult.content_breakdown;
    console.log(`  ✅ 小时趋势: ${intervals.length} 个时间段`);
    console.log(`     LIVE: RM ${c.live.gmv.toFixed(2)} | Video: RM ${c.video.gmv.toFixed(2)} | 商品卡: RM ${c.product_card.gmv.toFixed(2)}`);
  } else {
    console.log('  ⚠️ 未获取到小时趋势数据');
  }

  result.hourly_trend = hourlyResult;
  await hp.close();

  // ═══════════════════════════════════════════
  // 5. 视频素材概览
  // ═══════════════════════════════════════════
  console.log('\n[6/7] 视频素材概览...');

  const videoOverview = await apiPost(page, API_BASE + '/post_video_over_view_stat', {
    query_list: [
      "total_video_cnt", "live_video_cnt", "non_live_video_cnt",
      "total_video_gmv_amt", "live_video_gmv_amt", "non_live_video_gmv_amt",
      "total_video_order_cnt", "live_video_order_cnt", "non_live_video_order_cnt",
      "total_video_cost", "live_video_cost", "non_live_video_cost"
    ],
    start_time: targetDate, end_time: rangeEnd,
    campaign_shop_automation_type: 2,
    external_type_list: ['307', '304', '305']
  });
  if (videoOverview.code === 0 && videoOverview.data) {
    result.video_overview = videoOverview.data;
    console.log(`  ✅ 视频概览`);
  } else {
    console.log('  ⚠️ 视频概览:', videoOverview.msg || videoOverview.message || '无数据');
  }

  const videoList = await apiPost(page, API_BASE + '/post_video_list', {
    query_list: [
      "video_id", "video_title", "author_name", "author_id",
      "cost", "onsite_roi2_shopping_value", "onsite_roi2_shopping_sku",
      "impression", "click", "ctr"
    ],
    start_time: targetDate, end_time: rangeEnd,
    page: 1, page_size: 20,
    order_field: 'onsite_roi2_shopping_value', order_type: 1,
    campaign_shop_automation_type: 2,
    external_type_list: ['307', '304', '305']
  });
  if (videoList.code === 0 && videoList.data?.table) {
    result.video_list = videoList.data.table.map(v => ({
      video_id: v.video_id,
      video_title: v.video_title,
      author_name: v.author_name,
      author_id: v.author_id,
      cost: parseFloat(v.cost) || 0,
      gmv: parseFloat(v.onsite_roi2_shopping_value) || 0,
      orders: parseInt(v.onsite_roi2_shopping_sku) || 0,
      impression: parseInt(v.impression) || 0,
      click: parseInt(v.click) || 0,
      ctr: parseFloat(v.ctr) || 0
    }));
    console.log(`  ✅ ${result.video_list.length} 条视频`);
  } else {
    console.log('  ⚠️ 视频列表:', videoList.msg || videoList.message || '无数据');
  }

  // ═══════════════════════════════════════════
  // 6. 达人数据概览
  // ═══════════════════════════════════════════
  console.log('\n[7/7] 达人数据概览...');

  const creatorOverview = await apiPost(page, API_BASE + '/post_creator_over_view_stat', {
    query_list: [
      "total_creator_cnt", "active_creator_cnt",
      "total_creator_gmv_amt", "total_creator_order_cnt",
      "top_creator_gmv_amt", "top_creator_cost"
    ],
    start_time: targetDate, end_time: rangeEnd,
    campaign_shop_automation_type: 2,
    external_type_list: ['307', '304', '305']
  });
  if (creatorOverview.code === 0 && creatorOverview.data) {
    result.creator_overview = creatorOverview.data;
    console.log(`  ✅ 达人概览`);
  } else {
    console.log('  ⚠️ 达人概览:', creatorOverview.msg || creatorOverview.message || '无数据');
  }

  const creatorList = await apiPost(page, API_BASE + '/post_creator_list', {
    query_list: [
      "author_id", "author_name", "author_follower_cnt",
      "cost", "onsite_roi2_shopping_value", "onsite_roi2_shopping_sku",
      "impression", "click"
    ],
    start_time: targetDate, end_time: rangeEnd,
    page: 1, page_size: 20,
    order_field: 'onsite_roi2_shopping_value', order_type: 1,
    campaign_shop_automation_type: 2,
    external_type_list: ['307', '304', '305']
  });
  if (creatorList.code === 0 && creatorList.data?.table) {
    result.creator_list = creatorList.data.table.map(c => ({
      author_id: c.author_id,
      author_name: c.author_name,
      followers: parseInt(c.author_follower_cnt) || 0,
      cost: parseFloat(c.cost) || 0,
      gmv: parseFloat(c.onsite_roi2_shopping_value) || 0,
      orders: parseInt(c.onsite_roi2_shopping_sku) || 0,
      impression: parseInt(c.impression) || 0,
      click: parseInt(c.click) || 0
    }));
    console.log(`  ✅ ${result.creator_list.length} 条达人`);
  } else {
    console.log('  ⚠️ 达人列表:', creatorList.msg || creatorList.message || '无数据');
  }

  // ═══════════════════════════════════════════
  // 保存结果
  // ═══════════════════════════════════════════
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);

  const outFile = path.join(SCRIPTS_DIR, `ads_daily_${targetDate}.json`);
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2));

  console.log(`\n${'='.repeat(60)}`);
  console.log('📊 统一广告采集报告');
  console.log(`${'='.repeat(60)}`);
  console.log(`耗时: ${elapsed}s | 日期: ${targetDate}`);

  console.log(`\n📢 【商品层 Campaign】${result.campaigns?.length || 0}个`);
  if (result.campaigns) {
    for (const c of result.campaigns) {
      const pTag = c.product_id ? `→${c.product_id.slice(-6)}` : '';
      const roasStr = c.roas > 0 ? c.roas.toFixed(2) : '-';
      console.log(`  ${c.campaign_name.substring(0, 28).padEnd(30)} | 消耗RM${c.cost} | GMV RM${c.gmv} | ROAS ${roasStr} ${pTag}`);
    }
  }

  if (result.shop_daily?.data?.statistics) {
    const s = result.shop_daily.data.statistics;
    console.log(`\n📢 【店铺层】GMV: RM${parseFloat(s.overall_onsite_shopping_value).toFixed(2)} | 订单: ${s.overall_onsite_order_count} | 消耗: RM${parseFloat(s.dollar_cost).toFixed(2)} | ROAS: ${parseFloat(s.overall_onsite_roas).toFixed(2)}`);
  }

  if (result.hourly_trend?.hourly?.length) {
    const ht = result.hourly_trend;
    console.log(`\n📢 【小时趋势】${ht.hourly.length}个时间段 ` +
      `| LIVE: RM${ht.content_breakdown.live.gmv.toFixed(2)} ` +
      `| Video: RM${ht.content_breakdown.video.gmv.toFixed(2)} ` +
      `| 商品卡: RM${ht.content_breakdown.product_card.gmv.toFixed(2)}`);
  }

  if (result.video_list?.length) {
    console.log(`\n📢 【视频素材】Top${Math.min(result.video_list.length, 5)}:`);
    for (const v of result.video_list.slice(0, 5)) {
      console.log(`  ${(v.video_title || '(无标题)').substring(0, 24).padEnd(26)} | 达人: ${v.author_name || '-'} | GMV RM${v.gmv} | 消耗 RM${v.cost}`);
    }
  }

  if (result.creator_list?.length) {
    console.log(`\n📢 【达人】Top${Math.min(result.creator_list.length, 5)}:`);
    for (const c of result.creator_list.slice(0, 5)) {
      console.log(`  ${(c.author_name || '-').padEnd(20)} | GMV RM${c.gmv} | 订单 ${c.orders} | 粉丝 ${c.followers}`);
    }
  }

  console.log(`\n📂 ${outFile}`);

  await page.close();
  await browser.disconnect();
  console.log(`\n✅ 完成 (${elapsed}s)`);
})().catch(e => {
  console.error('\n❌ [FATAL]', e.message);
  process.exit(1);
});
