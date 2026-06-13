#!/usr/bin/env node
/**
 * tkads 每日数据采集 + 报表生成
 * 用法: node ~/.tkads/tkads_daily.js [--report daily|weekly|monthly]
 * 
 * 每次运行创建新页面，确保干净的 API 上下文
 */
const puppeteer = require('puppeteer-core');
const http = require('http');
const fs = require('fs');
const { execSync, exec } = require('child_process');

const PROFILE_ID = 'k1456ta2';
const SELLER_DOMAIN = 'seller-my.tiktok.com';
const HOME = process.env.HOME || '~';
const TKADS = HOME + '/.tkads';

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({raw: d}); } });
    }).on('error', reject);
  });
}

async function connect() {
  let info = await httpGet('http://local.adspower.net:50325/api/v1/browser/active?user_id=' + PROFILE_ID);
  if (info.code !== 0 || info.data?.status === 'Inactive') {
    console.log('   浏览器未运行，正在启动...');
    info = await httpGet('http://local.adspower.net:50325/api/v1/browser/start?user_id=' + PROFILE_ID + '&open_tabs=1');
    if (info.code !== 0) throw new Error('启动浏览器失败: ' + info.msg);
  }
  
  const browser = await puppeteer.connect({ browserWSEndpoint: info.data.ws.puppeteer, defaultViewport: null });
  // 关闭所有现有页面，确保干净上下文
  const pages = await browser.pages();
  for (const p of pages) { try { await p.close(); } catch(e) {} }
  const page = await browser.newPage();
  return { browser, page };
}

function saveSnapshots(campaigns) {
  // 通过 stdin 传给 Python
  const pyScript = TKADS + '/save_snapshot.py';
  const input = JSON.stringify({ campaigns: campaigns });
  
  return new Promise((resolve, reject) => {
    const child = exec('python ' + pyScript, { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve(stdout.trim());
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}

function genReport(type) {
  try {
    const out = execSync('python ' + TKADS + '/report_gen.py ' + type, { encoding: 'utf8', timeout: 10000 });
    return out.trim();
  } catch(e) {
    return '报告生成失败';
  }
}

async function collectData() {
  console.log('1. 采集广告数据...');
  const { browser, page } = await connect();
  
  try {
    await page.goto('https://' + SELLER_DOMAIN + '/ads-creation/dashboard?mpa=1', {
      timeout: 30000, waitUntil: 'networkidle0'
    });
    await new Promise(r => setTimeout(r, 6000));
    console.log('   页面: ' + page.url().slice(0, 100));
    
    // 最终方案：在页面内直接 navigatio 到 GMV Max 创建页的 dashboard 上下文
    // 等待 SPA 加载完成后，尝试劫持页面已有的数据
    const listFromDOM = await page.evaluate(() => {
      const tables = document.querySelectorAll('table');
      for (const t of tables) {
        const rows = t.querySelectorAll('tr');
        if (rows.length > 1) {
          return Array.from(rows).slice(1).map(tr => {
            const tds = tr.querySelectorAll('td');
            if (tds.length < 2) return null;
            return {
              campaign_name: (tds[1]?.textContent || '').trim(),
              status: (tds[2]?.textContent || '').trim().slice(0, 20),
              budget: (tds[3]?.textContent || '').trim(),
              cost: (tds[4]?.textContent || '').trim()
            };
          }).filter(Boolean);
        }
      }
      return [];
    });
    
    // 调用 API - 用正确参数（不传 budget 字段）
    const result = await page.evaluate(async () => {
      const csrf = document.cookie.match(/csrftoken=([^;]+)/)?.[1] || '';
      const sellerId = '7494105016200037977';
      const aadvid = '7569565674088136705';
      const url = '/oec_ads/shopping/v1/oec/stat/post_campaign_list?locale=zh&language=zh&oec_seller_id=' + sellerId + '&aadvid=' + aadvid;
      const res = await fetch(url, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'x-csrftoken': csrf },
        body: JSON.stringify({
          query_list: ['campaign_name','campaign_primary_status','campaign_id',
                       'cost','campaign_target_roi_budget','create_time',
                       'template_ad_start_time','template_ad_roas_bid'],
          page: 1, page_size: 200
        })
      });
      return await res.json();
    });
    
    if (result.code === 0 && result.data?.table?.length > 0) {
      const camps = result.data.table;
      console.log('   采集 ' + camps.length + ' 个广告');
      
      const saveResult = await saveSnapshots(camps);
      console.log('   数据库: ' + saveResult);
      return { success: true, campaigns: camps };
    } else {
      console.log('   获取失败: ' + (result.msg || JSON.stringify(result).slice(0, 100)));
      return { success: false, campaigns: [] };
    }
  } catch(e) {
    console.log('   错误: ' + e.message);
    return { success: false, campaigns: [] };
  } finally {
    try { await page.close(); } catch(e) {}
    try { await browser.disconnect(); } catch(e) {}
  }
}

async function main() {
  const args = {};
  process.argv.slice(2).forEach((arg, i, arr) => {
    if (arg.startsWith('--')) { args[arg.slice(2)] = arr[i+1] && !arr[i+1].startsWith('--') ? arr[i+1] : true; }
  });
  
  const reportType = args.report || 'daily';
  
  console.log('='.repeat(50));
  console.log('  TK Ads ' + reportType + ' 采集');
  console.log('='.repeat(50));
  
  const result = await collectData();
  
  const report = genReport(reportType);
  console.log('\n' + report);
  
  // 保存报告
  const reportDir = HOME + '/.tkads/reports';
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
  const dateStr = new Date().toISOString().slice(0, 10);
  const filename = reportDir + '/' + reportType + '-' + dateStr + '.md';
  fs.writeFileSync(filename, report, 'utf8');
  console.log('\n报告已保存: ' + filename);
  
  return report;
}

main().catch(e => console.error('错误:', e.message));
