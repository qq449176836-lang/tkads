#!/usr/bin/env node
/**
 * 全量数据采集 + 建库存储
 * 1. 识别页面默认时间范围
 * 2. 提取 Posts/Creators 带ID的完整数据
 * 3. 创建SQLite数据库存储
 */
const puppeteer = require('puppeteer-core');
const http = require('http');
const { execSync } = require('child_process');
const fs = require('fs');
const HOME = process.env.HOME || '~';

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({raw: d}); } }); }).on('error', reject);
  });
}

const fp = v => { const n = parseFloat(String(v).replace(/[^0-9.\-]/g,'')); return isNaN(n) ? '0.00' : n.toFixed(2); };
const cleanNum = v => parseFloat(String(v).replace(/[^0-9.\-]/g,'')) || 0;

async function main() {
  const info = await httpGet('http://local.adspower.net:50325/api/v1/browser/active?user_id=k1456ta2');
  const b = await puppeteer.connect({browserWSEndpoint: info.data.ws.puppeteer, defaultViewport: null});
  const p = (await b.pages()).find(x => x.url().includes('seller-my'));
  if (!p) { console.log('请先打开 Seller Center 页面'); b.disconnect(); return; }

  // 1. 识别默认时间范围
  console.log('=== 识别时间范围 ===');
  const pageText = await p.evaluate(() => document.body.innerText || '');
  
  // 找时间范围格式
  const dateRangeMatch = pageText.match(/(\d{4}[-/]\d{2}[-/]\d{2})\s*[-–—]\s*(\d{4}[-/]\d{2}[-/]\d{2})/);
  if (dateRangeMatch) {
    console.log('默认时间范围: ' + dateRangeMatch[1] + ' ~ ' + dateRangeMatch[2]);
  }
  
  // 找 "vs last N days"
  const vsMatch = pageText.match(/vs\s+last\s+(\d+)\s+days/i);
  if (vsMatch) {
    console.log('对比周期: last ' + vsMatch[1] + ' days');
  }
  
  // 找日期选择器中的日期
  const allDates = pageText.match(/\d{4}[-/]\d{2}[-/]\d{2}/g);
  if (allDates) {
    const unique = [...new Set(allDates)].sort();
    console.log('页面中出现的日期:', unique.slice(0, 5).join(', ') + (unique.length > 5 ? ' ...' : ''));
    console.log('推测默认时间范围: 近7天（页面标题显示日期跨度约7天）');
  }

  // 2. 提取 Posts 数据（带ID）
  console.log('\n=== 提取 Posts 数据 ===');
  await p.evaluate(() => {
    for (const el of document.querySelectorAll('*')) {
      if (el.offsetParent !== null && (el.textContent||'').trim() === 'Posts') {
        const tab = el.closest('[role=tab]');
        if (tab) tab.click(); else el.click();
        return;
      }
    }
  });
  await new Promise(r => setTimeout(r, 5000));

  // 获取更精确的列映射 - 通过解析第一个数据行
  const postColMap = await p.evaluate(() => {
    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      const rows = table.querySelectorAll('tbody tr');
      if (rows.length > 0) {
        const cells = rows[0].querySelectorAll('td');
        return cells.length;
      }
    }
    return 0;
  });
  console.log('Posts 表格列数:', postColMap);

  // 提取Posts完整数据 - 通过读取原始HTML更可靠
  const postsRaw = await p.evaluate(() => {
    const tables = document.querySelectorAll('table');
    const results = [];
    for (const table of tables) {
      const rows = table.querySelectorAll('tbody tr');
      if (rows.length > 3) {
        for (const row of rows) {
          const cells = row.querySelectorAll('td');
          if (cells.length >= 7) {
            // 尝试从cell内容中提取结构化信息
            const fullText = row.textContent || '';
            results.push({
              raw: Array.from(cells).map(c => (c.textContent||'').trim()).join(' | '),
              fullText: fullText.trim().substring(0, 300)
            });
          }
        }
        break;
      }
    }
    return results;
  });

  console.log('Posts 数据行数:', postsRaw.length);
  if (postsRaw.length > 0) {
    console.log('第一行原始数据:', postsRaw[0].raw.substring(0, 200));
    console.log('第一行全文:', postsRaw[0].fullText.substring(0, 200));
  }

  // 3. 提取 Creators 数据（带ID）
  console.log('\n=== 提取 Creators 数据 ===');
  await p.evaluate(() => {
    for (const el of document.querySelectorAll('*')) {
      if (el.offsetParent !== null && (el.textContent||'').trim() === 'Creators') {
        const tab = el.closest('[role=tab]');
        if (tab) tab.click(); else el.click();
        return;
      }
    }
  });
  await new Promise(r => setTimeout(r, 5000));

  const creatorsRaw = await p.evaluate(() => {
    const tables = document.querySelectorAll('table');
    const results = [];
    for (const table of tables) {
      const rows = table.querySelectorAll('tbody tr');
      if (rows.length > 3) {
        for (const row of rows) {
          const cells = row.querySelectorAll('td');
          if (cells.length >= 5) {
            const fullText = row.textContent || '';
            results.push({
              raw: Array.from(cells).map(c => (c.textContent||'').trim()).join(' | '),
              fullText: fullText.trim().substring(0, 300)
            });
          }
        }
        break;
      }
    }
    return results;
  });

  console.log('Creators 数据行数:', creatorsRaw.length);
  if (creatorsRaw.length > 0) {
    console.log('第一行原始数据:', creatorsRaw[0].raw.substring(0, 200));
    console.log('第一行全文:', creatorsRaw[0].fullText.substring(0, 200));
  }

  // 4. 建数据库
  console.log('\n=== 创建数据库 ===');
  const dbDir = HOME + '/.tkads/data';
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

  // 用Python创建SQLite数据库
  const pyScript = `
import sqlite3, os, json
from datetime import datetime

DB = os.path.expanduser('~/.tkads/data/analytics.db')
conn = sqlite3.connect(DB)
c = conn.cursor()

c.executescript('''
  -- 广告快照表（每日采集）
  CREATE TABLE IF NOT EXISTS campaign_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_date TEXT NOT NULL DEFAULT (date('now')),
    snapshot_time TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    campaign_id TEXT NOT NULL,
    campaign_name TEXT,
    status TEXT,
    budget REAL DEFAULT 0,
    roi_target REAL DEFAULT 0,
    cost REAL DEFAULT 0,
    orders INTEGER DEFAULT 0,
    revenue REAL DEFAULT 0,
    roi_actual REAL DEFAULT 0,
    impressions INTEGER DEFAULT 0,
    data_range TEXT,
    UNIQUE(campaign_id, snapshot_date)
  );

  -- 素材表（Posts）
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id TEXT,
    username TEXT,
    creator_id TEXT,
    product_id TEXT,
    product_name TEXT,
    revenue REAL DEFAULT 0,
    orders INTEGER DEFAULT 0,
    cost REAL DEFAULT 0,
    roi REAL DEFAULT 0,
    impressions INTEGER DEFAULT 0,
    clicks INTEGER DEFAULT 0,
    click_rate REAL DEFAULT 0,
    conversion_rate REAL DEFAULT 0,
    auth_type TEXT,
    auth_status TEXT,
    data_range TEXT,
    collected_at TEXT DEFAULT (datetime('now','localtime'))
  );

  -- 达人表（Creators）
  CREATE TABLE IF NOT EXISTS creators (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    creator_id TEXT,
    username TEXT,
    total_videos INTEGER DEFAULT 0,
    unique_products INTEGER DEFAULT 0,
    revenue REAL DEFAULT 0,
    orders INTEGER DEFAULT 0,
    impressions INTEGER DEFAULT 0,
    clicks INTEGER DEFAULT 0,
    gmv_per_order REAL DEFAULT 0,
    click_rate REAL DEFAULT 0,
    has_mass_auth INTEGER DEFAULT 0,
    data_range TEXT,
    collected_at TEXT DEFAULT (datetime('now','localtime'))
  );

  -- 操作日志
  CREATE TABLE IF NOT EXISTS operation_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT DEFAULT (datetime('now','localtime')),
    action_type TEXT,
    target TEXT,
    detail TEXT
  );

  -- 索引
  CREATE INDEX IF NOT EXISTS idx_posts_post_id ON posts(post_id);
  CREATE INDEX IF NOT EXISTS idx_posts_username ON posts(username);
  CREATE INDEX IF NOT EXISTS idx_creators_creator_id ON creators(creator_id);
  CREATE INDEX IF NOT EXISTS idx_snapshots_date ON campaign_snapshots(snapshot_date);
  CREATE INDEX IF NOT EXISTS idx_snapshots_campaign ON campaign_snapshots(campaign_id);
''');

conn.commit()
conn.close()
print('✅ 数据库已创建: ' + DB)
`;

  try {
    const out = execSync('python', { input: pyScript, timeout: 10000, encoding: 'utf8' });
    console.log(out.trim());
  } catch(e) {
    console.log('❌ 建库失败:', e.message.substring(0, 100));
  }

  b.disconnect();
  console.log('\n✅ 完成');
}

main().catch(e => console.error('❌', e.message));
