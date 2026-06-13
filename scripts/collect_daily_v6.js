#!/usr/bin/env node
/**
 * 每日素材达人采集 v6 — puppeteer请求拦截实现单日
 * Posts: DOM提取(含cost/ROI) | Creators: API捕获(日期被拦截器修改为单日)
 * 用法: node collect_daily_v6.js [date]
 */
const puppeteer = require('puppeteer-core');
const http = require('http');
const { execSync } = require('child_process');
const HOME = process.env.HOME || '~';
const TKADS = HOME + '/.tkads';

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({raw: d}); } }); }).on('error', reject);
  });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const cn = v => parseFloat(String(v).replace(/[^0-9.\-]/g,'')) || 0;
const ci = v => parseInt(String(v).replace(/[^0-9]/g,'')) || 0;
const fp = v => { const n = typeof v === 'string' ? cn(v) : (v||0); return n.toFixed(2); };

async function main() {
  const targetDate = process.argv[2] || (() => { const d = new Date(); d.setDate(d.getDate()-1); return d.toISOString().slice(0,10); })();
  console.log('📅 目标日期: ' + targetDate);

  const info = await httpGet('http://local.adspower.net:50325/api/v1/browser/active?user_id=k1456ta2');
  const b = await puppeteer.connect({browserWSEndpoint: info.data.ws.puppeteer, defaultViewport: null});
  const p = await b.newPage();

  // 设置请求拦截（先设拦截再导航）
  await p.setRequestInterception(true);
  p.on('request', request => {
    if (request.method() === 'POST' && request.url().includes('post_creator_list')) {
      try {
        const data = JSON.parse(request.postData());
        if (data.common_req) {
          data.common_req.st = targetDate;
          data.common_req.et = targetDate;
        }
        request.continue({postData: JSON.stringify(data)});
        return;
      } catch(e) {}
    }
    // 也拦截 post_video_list
    if (request.method() === 'POST' && request.url().includes('post_video_list')) {
      try {
        const data = JSON.parse(request.postData());
        if (data.common_req) {
          data.common_req.st = targetDate;
          data.common_req.et = targetDate;
        }
        request.continue({postData: JSON.stringify(data)});
        return;
      } catch(e) {}
    }
    request.continue();
  });

  await p.goto('https://seller-my.tiktok.com/ads-creation/manage-analyze', { waitUntil: 'networkidle0', timeout: 60000 });
  await sleep(8000);

  // 切换 Posts 标签触发新的API请求（拦截器会修改日期为单日）
  console.log('🔄 触发Posts刷新...');
  await p.evaluate(() => {
    for (const el of document.querySelectorAll('[role=tab], div, span')) {
      const t = (el.textContent||'').trim();
      if (t === '作品' || t === 'Posts' || t === 'Posts') { el.click(); return; }
    }
  });
  await sleep(8000);

  // ===== 1. Posts DOM提取 =====
  console.log('\n═══ 1. Posts 素材数据 ═══');
  const posts = await p.evaluate(() => {
    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      const rows = table.querySelectorAll('tbody tr');
      if (rows.length <= 3) continue;
      return Array.from(rows).map(row => {
        const cells = row.querySelectorAll('td');
        const m = (row.textContent||'').match(/(\d{19})/);
        return {
          postId: m ? m[1] : (cells[1]?.textContent?.trim()||''),
          username: cells[2]?.textContent?.trim()||'',
          revenue: cells[6]?.textContent?.trim()||'0',
          orders: cells[8]?.textContent?.trim()||'0',
          cost: cells[9]?.textContent?.trim()||'0',
          roi: cells[11]?.textContent?.trim()||'0',
          impressions: (cells[12]?.textContent?.trim()||'0').replace(/,/g,'')
        };
      });
    }
    return [];
  });

  console.log('共 ' + posts.length + ' 条');
  const sortedP = [...posts].sort((a,b)=>cn(b.revenue)-cn(a.revenue));
  sortedP.slice(0,10).forEach((v,i) => {
    console.log('  ' + (i+1) + '. ' + v.postId.slice(-8) + ' 收入=' + v.revenue + ' 成本=' + v.cost + ' ROI=' + v.roi);
  });

  // ===== 2. Creators =====
  console.log('\n═══ 2. Creators 达人数据 ═══');
  const creatorsPromise = p.waitForResponse(
    r => r.url().includes('post_creator_list') && r.url().includes('oec_seller_id=7494105016'),
    { timeout: 30000 }
  );

  await p.evaluate(() => {
    for (const el of document.querySelectorAll('[role=tab], div, span')) {
      const t = (el.textContent||'').trim();
      if ((t === '达人' || t === 'Creators') && el.offsetParent !== null) { el.click(); return; }
    }
  });
  console.log('切换达人标签: ✅');

  let creators = [];
  try {
    const body = await (await creatorsPromise).json();
    if (body.code === 0 && body.data?.table?.length) {
      creators = body.data.table.map(c => ({
        creatorId: c.tt_oec_uid || '',
        username: c.creator_user_name || c.creator_nick_name || '',
        revenue: fp(c.onsite_roi2_shopping_value),
        orders: ci(c.onsite_roi2_shopping_sku),
        impressions: ci(c.roi2_show_cnt),
        clicks: ci(c.roi2_click_cnt)
      }));
    }
  } catch(e) {
    console.log('  ⚠️ API:' + e.message.slice(0,40));
  }
  await sleep(2000);

  console.log('共 ' + creators.length + ' 位达人');
  [...creators].sort((a,b)=>cn(b.revenue)-cn(a.revenue)).slice(0,15).forEach((c,i) => {
    console.log('  ' + (i+1).toString().padStart(2) + '. ' + c.username.slice(0,16).padEnd(18) + ' 收入=' + c.revenue + ' 订单=' + c.orders + ' id=' + (c.creatorId.slice(-6)||'无'));
  });
  const withId = creators.filter(c => c.creatorId).length;
  console.log('  🆔 有ID: ' + withId + '/' + creators.length);

  // ===== 3. 入库 =====
  console.log('\n═══ 3. 入库 ═══');
  try {
    const out = execSync('python ' + TKADS + '/save_30d.py', {
      input: JSON.stringify({
        dataRange: targetDate, campaigns: [],
        posts: posts.map(p => ({ postId: p.postId, username: p.username, revenue: cn(p.revenue), orders: ci(p.orders), cost: cn(p.cost), roi: cn(p.roi), impressions: ci(p.impressions) })),
        creators
      }),
      timeout: 15000, encoding: 'utf8'
    });
    console.log(out.trim());
  } catch(e) {
    console.log('❌ 入库失败:', (e.stderr||e.message).substring(0,200));
  }

  await p.close();
  b.disconnect();
  console.log('\n✅ 完成: ' + targetDate);
}

main().catch(e => console.error('❌', e.message));
