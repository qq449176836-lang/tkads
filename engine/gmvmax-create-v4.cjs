#!/usr/bin/env node
/**
 * GMV Max 广告创建助手 + 元数据捕获 - v4.0
 * 在 UI 自动化创建的同时拦截 API 响应，提取 ad_id/campaign_id/start_time
 * 
 * 用法: node gmvmax-create.cjs --roi 7.5 --budget 100 --name "广告名"
 */
const puppeteer = require('puppeteer-core');
const http = require('http');
const { execSync, exec } = require('child_process');
const HOME = process.env.HOME || '~';
const TKADS = HOME + '/.tkads';

const ADS_URL = 'http://local.adspower.net:50325';
const PROFILE_ID = 'k1456ta2';

const args = {};
process.argv.slice(2).forEach((arg, i, arr) => {
  if (arg.startsWith('--')) {
    const key = arg.slice(2);
    const val = arr[i + 1];
    if (val && !val.startsWith('--')) args[key] = val;
    else args[key] = true;
  }
});

const ROI_PRESETS = ['3.4', '5.6', '7.5'];
const ROI = args.roi || '5.6';
const BUDGET = args.budget || '';
const NAME = args.name || `Hanmac_Auto_${Date.now()}`;

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

/** 调用 Python 保存广告元数据到数据库 */
function saveToDb(meta) {
  return new Promise((resolve, reject) => {
    const child = exec('python ' + TKADS + '/save_meta.py', { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) { console.log('   ⚠️ 保存元数据失败:', stderr || err.message); resolve(false); }
      else resolve(stdout.trim());
    });
    child.stdin.write(JSON.stringify(meta));
    child.stdin.end();
  });
}

/** 查询新广告的 campaign_id 和 start_time */
async function getNewCampaignId(page, campaignName) {
  await sleep(3000);
  const result = await page.evaluate(async () => {
    const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] || '';
    const res = await fetch('/oec_ads/shopping/v1/oec/stat/post_campaign_list?locale=zh&language=zh&oec_seller_id=7494105016200037977&aadvid=7569565674088136705', {
      method: 'POST', credentials: 'include',
      headers: {'Content-Type': 'application/json', 'x-csrftoken': csrf},
      body: JSON.stringify({
        query_list: ['campaign_id','campaign_name','campaign_primary_status',
                     'template_ad_start_time','template_ad_roas_bid',
                     'campaign_target_roi_budget'],
        page: 1, page_size: 50,
        campaign_shop_automation_type: 2,
        external_type_list: ['304','307'],
        start_time: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
        end_time: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
        campaign_status: ['no_delete']
      })
    });
    return await res.json();
  });
  
  const camps = result.data?.table || [];
  // 查找名称最匹配的（刚创建的那个）
  const match = camps.find(c => c.campaign_name === campaignName);
  if (match) {
    // 从名称提取 spu_id (最后一段)
    const parts = campaignName.split('-');
    const spuId = parts.length >= 2 ? parts[parts.length - 1] : '';
    return {
      campaign_id: match.campaign_id,
      start_time: match.template_ad_start_time,
      roi_target: parseFloat(match.template_ad_roas_bid || '0'),
      budget: parseFloat(match.campaign_target_roi_budget || '0'),
      spu_id: spuId
    };
  }
  return null;
}

async function main() {
  console.log('🚀 GMV Max 全自动创建 v4.0 (含 ad_id 捕获)');
  console.log(`   ROI=${ROI}  预算=${BUDGET || '(自动)'}  名称="${NAME}"\n`);

  // 1. 连接 AdsPower
  console.log('1. 连接 AdsPower...');
  let info = await httpGet(ADS_URL + '/api/v1/browser/active?user_id=' + PROFILE_ID);
  if (info.code !== 0 || info.data?.status === 'Inactive') {
    info = await httpGet(ADS_URL + '/api/v1/browser/start?user_id=' + PROFILE_ID + '&open_tabs=1');
  }
  if (info.code !== 0) { console.log('❌ 启动失败'); process.exit(1); }

  const ws = info.data.ws.puppeteer;
  const browser = await puppeteer.connect({
    browserWSEndpoint: ws,
    defaultViewport: { width: 1920, height: 1080 },
    protocolTimeout: 30000
  });
  
  // 清理页面 - 关闭所有并新建
  const existingPages = await browser.pages();
  for (const p of existingPages) { try { await p.close(); } catch(e) {} }
  const page = await browser.newPage();

  // 2. 最大化窗口
  console.log('   ✅ 已连接，最大化窗口...');
  const cdp = await page.target().createCDPSession();
  const { windowId } = await cdp.send('Browser.getWindowForTarget');
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } });

  // 3. 注入 API 拦截器（在导航前注入）
  console.log('3. 注入 API 拦截器...');
  await page.evaluateOnNewDocument(() => {
    window.__capturedCreateResponses = [];
    const origFetch = window.fetch;
    window.fetch = async function(...args) {
      const url = (typeof args[0] === 'string' ? args[0] : args[0]?.url || '').toString();
      let result;
      try {
        result = await origFetch.apply(this, args);
      } catch(e) { throw e; }
      
      if (url.includes('all_ad_data/create')) {
        let respBody = '';
        try {
          const clone = result.clone();
          respBody = await clone.text();
        } catch(e) {}
        window.__capturedCreateResponses.push({
          url: url,
          method: (args[1]?.method || 'GET'),
          response: respBody,
          time: Date.now()
        });
        console.log('[CREATE]', url.slice(0, 80));
      }
      return result;
    };
  });

  // 4. 导航到创建页
  console.log('4. 加载 GMV Max 创建页...');
  await page.goto('https://seller-my.tiktok.com/ads-creation/creation?campaign_type=PRODUCT_GMV_MAX&mpa=1&shop_region=MY', {
    waitUntil: 'domcontentloaded', timeout: 60000
  });
  await sleep(10000);
  console.log('   ✅ 加载完成');

  // 5. 设置 ROI
  if (ROI_PRESETS.includes(ROI)) {
    console.log(`5. 设置 ROI=${ROI} (单选按钮)...`);
    await page.evaluate((val) => {
      const radios = document.querySelectorAll('input[type="radio"]');
      for (const r of radios) {
        if (r.value === val) {
          const label = r.closest('label');
          if (label) { label.click(); return; }
          r.click(); return;
        }
      }
    }, ROI);
    await sleep(2000);
    console.log('   ✅ OK');
  }

  // 6. 设置名称
  console.log(`6. 设置名称="${NAME}"...`);
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
  const nameCheck = await page.evaluate(() => {
    const inp = document.querySelector('input[placeholder*="campaign name"], input[placeholder*="名称"]');
    return inp ? inp.value : 'not found';
  });
  console.log(`   ✅ 名称="${nameCheck}"`);

  // 7. 选产品
  console.log('7. 选择商品...');
  await page.evaluate(() => {
    for (const b of document.querySelectorAll('button')) {
      if (b.offsetParent !== null && (b.textContent || '').trim().includes('Add product')) {
        b.click(); return;
      }
    }
  });
  await sleep(8000);

  // 检查并选择
  const hasProducts = await page.evaluate(() => {
    const drawer = document.querySelector('[class*=drawer]');
    if (!drawer) return false;
    const trs = drawer.querySelectorAll('tr');
    for (const tr of trs) {
      if (tr.querySelector('td')) {
        const txt = (tr.textContent || '').trim();
        if (txt.length > 10 && !txt.includes('No') && !txt.includes('暂无')) return true;
      }
    }
    return false;
  });

  if (!hasProducts) {
    console.log('   ⚠️ 无可用的商品');
  } else {
    const productName = await page.evaluate(() => {
      const drawer = document.querySelector('[class*=drawer]');
      if (!drawer) return null;
      const trs = drawer.querySelectorAll('tr');
      for (const tr of trs) {
        if (tr.querySelector('td')) {
          const label = tr.querySelector('label');
          if (label) {
            const txt = (tr.textContent || '').trim();
            label.click();
            return txt.substring(0, 60);
          }
        }
      }
      return null;
    });

    if (productName) {
      console.log(`   ✅ 已选择: ${productName}`);
    }
    await sleep(3000);

    const confirmClicked = await page.evaluate(() => {
      for (const b of document.querySelectorAll('button')) {
        const t = (b.textContent || '').trim();
        if ((t === 'Confirm' || t === '确认') && b.offsetParent !== null) {
          b.click(); return true;
        }
      }
      return false;
    });
    if (confirmClicked) {
      console.log('   ✅ 已确认');
      await sleep(3000);
    }
  }

  // 8. 发布
  console.log('8. 发布...');
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
    await page.screenshot({ path: HOME + '/gmvmax-error.png' });
    await cdp.detach(); await browser.disconnect();
    process.exit(1);
  }
  console.log('   ✅ 已点击');

  // 9. 政治弹窗
  await sleep(5000);
  console.log('9. 处理弹窗...');
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

  // 10. 检查结果
  const url = page.url();
  const success = !url.includes('ads-creation') || url.includes('dashboard');
  console.log('\n' + '='.repeat(50));
  if (success) {
    console.log('🎉 广告创建成功！');
  } else {
    console.log('❌ 仍在创建页');
    await page.screenshot({ path: HOME + '/gmvmax-error.png' });
  }
  console.log('='.repeat(50));

  // === 11. 捕获 ad_id 和 campaign_id ===
  console.log('\n📥 捕获广告元数据...');
  
  // 先从拦截器获取创建 API 响应
  const captured = await page.evaluate(() => window.__capturedCreateResponses || []);
  let adId = '';
  let campId = '';
  
  // 解析创建 API 响应
  if (captured.length > 0) {
    for (const cap of captured) {
      try {
        const resp = JSON.parse(cap.response);
        if (resp.code === 0 && resp.data) {
          // 尝试不同路径
          campId = resp.data.campaign_id || resp.data.campaignId || '';
          adId = resp.data.ad_id || resp.data.adId || '';
          
          // 有时在嵌套对象中
          if (!adId && resp.data.ad_info) {
            adId = resp.data.ad_info.ad_id || '';
          }
          if (!campId && resp.data.campaign_info) {
            campId = resp.data.campaign_info.campaign_id || '';
          }
          
          if (campId || adId) break;
        }
      } catch(e) {}
    }
  }

  // 如果没从 API 获取到，就查询 post_campaign_list
  let meta = null;
  if (!campId) {
    meta = await getNewCampaignId(page, NAME);
  } else {
    // 已经拿到 campaign_id，只需补 start_time
    const more = await getNewCampaignId(page, NAME);
    if (more) {
      if (!campId) campId = more.campaign_id;
      if (!meta) meta = more;
    }
  }
  
  if (!meta && !campId) {
    console.log('   ⚠️ 无法获取新广告 ID');
  } else {
    const campaignId = campId || meta?.campaign_id || '';
    const startTime = meta?.start_time || '';
    const spuId = meta?.spu_id || (NAME.includes('-') ? NAME.split('-').pop() : '');
    
    console.log(`   campaign_id: ${campaignId}`);
    console.log(`   ad_id:       ${adId || '(未捕获 - 需手动补充)'}`);
    console.log(`   start_time:  ${startTime}`);
    console.log(`   spu_id:      ${spuId}`);
    
    if (campaignId) {
      // 保存到数据库
      const saveResult = await saveToDb({
        campaign_id: campaignId,
        ad_id: adId,
        start_time: startTime,
        custom_tz_id: '7473424031757336583',
        custom_tz_type: 1,
        spu_id: spuId,
        product_name: NAME,
        roi_target: parseFloat(ROI),
        budget: parseFloat(BUDGET || '200')
      });
      console.log(`   数据库: ${saveResult || '✅ 已保存'}`);
      
      if (adId && startTime) {
        console.log('\n✅✅✅ 完整元数据已捕获！此广告以后可全自动修改 ROI！');
      } else if (adId) {
        console.log('\n⚠️ ad_id 已捕获，但 start_time 缺失。下次数据采集时会补全。');
      } else if (startTime) {
        console.log('\n⚠️ start_time 已捕获，但 ad_id 未捕获。');
      }
    }
  }

  await page.screenshot({ path: HOME + '/gmvmax-result.png' });
  await cdp.detach();
  await browser.disconnect();
}

main().catch(e => {
  console.error('❌ 错误:', e.message);
  process.exit(1);
});
