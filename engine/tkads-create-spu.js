#!/usr/bin/env node
/**
 * tkads-create-spu.js — 创建单个SPU的 GMV Max 广告
 * 
 * 用法: node tkads-create-spu.js --spu <SPU_ID> --roi <ROI> --budget <预算> [--name <名称>]
 * 
 * 流程: 连接浏览器 → 打开创建页 → 设置ROI/名称 → 选择指定SPU → 发布 → 捕获ad_id → 存库
 */
const puppeteer = require('puppeteer-core');
const http = require('http');
const { execSync, exec } = require('child_process');
const HOME = process.env.HOME || '~';
const TKADS = HOME + '/.tkads';

const ADS_URL = 'http://local.adspower.net:50325';
const PROFILE_ID = 'k1456ta2';
const SID = '7494105016200037977';
const ADVID = '7569565674088136705';

// 解析参数
const args = {};
process.argv.slice(2).forEach((arg, i, arr) => {
  if (arg.startsWith('--')) {
    const key = arg.slice(2);
    if (arr[i+1] && !arr[i+1].startsWith('--')) args[key] = arr[i+1];
    else args[key] = true;
  }
});

const SPU = args.spu || '';
const ROI = args.roi || '7.0';
const BUDGET = args.budget || '20';
const NAME = args.name || `自动化-${SPU}`;

if (!SPU) { console.log('❌ 用法: node tkads-create-spu.js --spu <SPU_ID> --roi 7.0 --budget 30'); process.exit(1); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({raw: d}); } });
    }).on('error', reject);
  });
}

function saveToDb(meta) {
  return new Promise((resolve, reject) => {
    const child = exec('python ' + TKADS + '/save_meta.py', { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) { console.log('   ⚠️ 保存失败:', stderr || err.message); resolve(false); }
      else resolve(stdout.trim());
    });
    child.stdin.write(JSON.stringify(meta));
    child.stdin.end();
  });
}

async function main() {
  console.log(`🚀 创建单品 GMV Max: ${NAME}`);
  console.log(`   SPU=${SPU}  ROI=${ROI}  预算=${BUDGET}`);

  // 1. 连接浏览器
  let info = await httpGet(`${ADS_URL}/api/v1/browser/active?user_id=${PROFILE_ID}`);
  if (info.code !== 0 || info.data?.status === 'Inactive') {
    info = await httpGet(`${ADS_URL}/api/v1/browser/start?user_id=${PROFILE_ID}&open_tabs=1`);
    if (info.code !== 0) throw new Error('启动失败');
    await sleep(4000);
  }
  const browser = await puppeteer.connect({ browserWSEndpoint: info.data.ws.puppeteer, defaultViewport: null, protocolTimeout: 30000 });

  try {
    // 清理页面
    const existingPages = await browser.pages();
    for (const p of existingPages) { try { await p.close(); } catch(e) {} }
    const page = await browser.newPage();

    // 最大化
    const cdp = await page.target().createCDPSession();
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } });

    // 注入 fetch 拦截器捕获 create 响应
    await page.evaluateOnNewDocument(() => {
      window.__capturedCreateAdId = null;
      const origFetch = window.fetch;
      window.fetch = async function(...args) {
        const url = (typeof args[0] === 'string' ? args[0] : args[0]?.url || '').toString();
        let result;
        try { result = await origFetch.apply(this, args); } catch(e) { throw e; }
        if (url.includes('all_ad_data/create')) {
          try {
            const clone = result.clone();
            const text = await clone.text();
            const resp = JSON.parse(text);
            if (resp.code === 0 && resp.data) {
              window.__capturedCreateAdId = {
                ad_id: resp.data.ad_id || resp.data.adId || '',
                campaign_id: resp.data.campaign_id || resp.data.campaignId || ''
              };
            }
          } catch(e) {}
        }
        return result;
      };
    });

    // 2. 打开创建页
    console.log('   加载创建页...');
    await page.goto('https://seller-my.tiktok.com/ads-creation/creation?campaign_type=PRODUCT_GMV_MAX&mpa=1&shop_region=MY', {
      waitUntil: 'domcontentloaded', timeout: 60000
    });
    await sleep(8000);

    // 3. 设置 ROI
    console.log(`   设置 ROI=${ROI}...`);
    const roiSet = await page.evaluate((val) => {
      const radios = document.querySelectorAll('input[type="radio"]');
      for (const r of radios) {
        if (r.value === val || parseFloat(r.value) === parseFloat(val)) {
          const label = r.closest('label');
          if (label) { label.click(); return true; }
          r.click(); return true;
        }
      }
      return false;
    }, ROI);
    if (!roiSet) console.log('   ⚠️ 未找到ROI预设按钮，继续...');
    await sleep(2000);

    // 4. 设置名称
    console.log(`   设置名称="${NAME}"...`);
    await page.evaluate((name) => {
      const inp = document.querySelector('input[placeholder*="campaign name"], input[placeholder*="名称"]');
      if (inp) {
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(inp, name);
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        inp.dispatchEvent(new Event('blur', { bubbles: true }));
      }
    }, NAME);
    await sleep(1000);

    // 5. 打开商品选择抽屉
    console.log('   选择商品...');
    await page.evaluate(() => {
      for (const b of document.querySelectorAll('button')) {
        if (b.offsetParent !== null && (b.textContent || '').trim().includes('Add product')) {
          b.click(); return;
        }
      }
    });
    await sleep(8000);

    // 6. 查找并选择指定 SPU
    console.log('   等待商品列表加载...');
    await sleep(5000);
    
    const productInfo = await page.evaluate((spuId) => {
      const drawer = document.querySelector('.theme-arco-drawer-content');
      if (!drawer) return { found: false, reason: 'no_drawer' };
      
      // 找所有商品行
      const rows = drawer.querySelectorAll('tr.core-table-tr');
      for (const row of rows) {
        const txt = (row.textContent || '').trim();
        if (txt.includes(spuId)) {
          // 找到匹配的SPU，勾选它的checkbox
          const checkbox = row.querySelector('label[data-tid="m4b_checkbox"]');
          if (checkbox) {
            checkbox.click();
            return { found: true, name: txt.substring(0, 80), bySpu: true };
          }
        }
      }
      
      // 如果没找到匹配的SPU，选第一个可用的
      for (const row of rows) {
        const checkbox = row.querySelector('label[data-tid="m4b_checkbox"]');
        if (checkbox && checkbox.offsetParent !== null) {
          checkbox.click();
          return { found: true, name: (row.textContent || '').trim().substring(0, 80), bySpu: false };
        }
      }
      return { found: false, reason: 'no_match' };
    }, SPU);
    
    if (!productInfo.found) {
      console.log(`   ❌ 未找到商品（SPU=${SPU}）`);
      await page.screenshot({ path: HOME + '/create-error.png' });
      await cdp.detach(); await browser.disconnect();
      process.exit(1);
    }
    console.log(`   ✅ 已选择: ${productInfo.name}`);
    await sleep(3000);

    // 7. 点确认
    const confirmClicked = await page.evaluate(() => {
      for (const b of document.querySelectorAll('button')) {
        const t = (b.textContent || '').trim();
        if ((t === 'Confirm' || t === '确认') && b.offsetParent !== null) {
          b.click(); return true;
        }
      }
      return false;
    });
    if (confirmClicked) { console.log('   ✅ 已确认'); await sleep(3000); }

    // 8. 发布
    console.log('   发布...');
    const publishOk = await page.evaluate(() => {
      for (const b of document.querySelectorAll('button')) {
        if ((b.textContent || '').trim() === 'Publish' && !b.disabled && b.offsetParent !== null) {
          b.click(); return true;
        }
      }
      return false;
    });
    if (!publishOk) {
      console.log('   ❌ 发布按钮不可用');
      await page.screenshot({ path: HOME + '/create-error.png' });
      await cdp.detach(); await browser.disconnect();
      process.exit(1);
    }
    console.log('   ✅ 已点击发布');
    await sleep(5000);

    // 9. 处理政治弹窗
    for (const confirmText of ['Confirm', '确认']) {
      const r = await page.evaluate((ct) => {
        const labels = document.querySelectorAll('label[data-tid="m4b_checkbox"]');
        for (const l of labels) {
          const modal = l.closest('[class*="modal"]');
          if (modal && modal.offsetParent !== null) {
            l.click();
            const btns = modal.querySelectorAll('button');
            for (const b of btns) {
              if ((b.textContent || '').trim() === ct) { b.click(); return true; }
            }
          }
        }
        return false;
      }, confirmText);
      if (r) { console.log('   ✅ 弹窗已处理'); break; }
    }
    await sleep(5000);

    // 10. 提取创建的 ad_id
    const captured = await page.evaluate(() => window.__capturedCreateAdId);
    let newAdId = captured?.ad_id || '';
    let newCampaignId = captured?.campaign_id || '';

    // 如果没截取到，从列表查
    if (!newCampaignId) {
      const csrf = await page.evaluate(() => document.cookie.match(/csrftoken=([^;]+)/)?.[1]||'');
      const listResult = await page.evaluate(async (name, csrf, sid, advid) => {
        const res = await fetch('/oec_ads/shopping/v1/oec/stat/post_campaign_list?locale=zh&language=zh&oec_seller_id=' + sid + '&aadvid=' + advid, {
          method: 'POST', credentials: 'include',
          headers: {'Content-Type':'application/json','x-csrftoken':csrf},
          body: JSON.stringify({
            query_list: ['campaign_id','campaign_name','template_ad_roas_bid','campaign_target_roi_budget'],
            page: 1, page_size: 50,
            campaign_status: ['no_delete'],
            start_time: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
            end_time: new Date(Date.now() + 86400000).toISOString().slice(0, 10)
          })
        });
        const d = await res.json();
        const match = (d.data?.table || []).find(c => c.campaign_name === name);
        return match ? { campaign_id: match.campaign_id, roi: match.template_ad_roas_bid, budget: match.campaign_target_roi_budget } : null;
      }, NAME, csrf, SID, ADVID);
      if (listResult) newCampaignId = listResult.campaign_id;
    }

    if (!newCampaignId) {
      console.log('   ⚠️ 广告已创建但无法捕获ID');
      await page.screenshot({ path: HOME + '/create-result.png' });
    } else {
      console.log(`\n✅ 创建成功!`);
      console.log(`   campaign_id: ${newCampaignId}`);
      console.log(`   ad_id:       ${newAdId || '(需稍后补充)'}`);

      // 存库
      const saveResult = await saveToDb({
        campaign_id: newCampaignId,
        ad_id: newAdId,
        start_time: new Date().toISOString().replace('T', ' ').slice(0, 19),
        custom_tz_id: '7473424031757336583',
        custom_tz_type: 1,
        spu_id: SPU,
        product_name: NAME,
        roi_target: parseFloat(ROI),
        budget: parseFloat(BUDGET)
      });
      console.log(`   数据库: ${saveResult || '✅ 已保存'}`);
    }

    await page.screenshot({ path: HOME + '/create-result.png' });
    await cdp.detach();
    await browser.disconnect();
    console.log('🎉 完成');
  } catch(e) {
    console.error('❌ 错误:', e.message);
    try { await browser.disconnect(); } catch(ee) {}
    process.exit(1);
  }
}

main();
