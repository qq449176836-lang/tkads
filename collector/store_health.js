#!/usr/bin/env node
/**
 * collect/store_health.js — 店铺健康/评分/违规逐日采集器
 * 
 * 采集3个API：
 *   1. violation/overview/get  → 违规总分+4维度
 *   2. performance/list        → 12项表现指标
 *   3. shop_limit_status/get   → 店铺限制状态
 * 
 * 用法:
 *   node collect/store_health.js                # 采昨天
 *   node collect/store_health.js --date 2026-06-14
 *   node collect/store_health.js --force         # 覆盖已有数据
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ADSPOWER_API = 'http://local.adspower.net:50325';
const PROFILE_SN = '27';
const HOME = process.env.HOME || process.env.USERPROFILE || '~';
const DB_PATH = path.join(HOME, '.tkads', 'data', 'analytics.db');
const SELLER_ID = '7494105016200037977';

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
          else reject(new Error(j.msg || JSON.stringify(j)));
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function parseArgs() {
  const args = process.argv.slice(2);
  let date, force = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--date') date = args[i + 1];
    if (args[i] === '--force') force = true;
  }
  if (!date) {
    const d = new Date(Date.now() - 86400000);
    date = d.toISOString().split('T')[0];
  }
  return { date, force };
}

// SQLite helper (inline, no external deps)
function runSql(sql, params = []) {
  const sqlite3 = require('child_process');
  // We'll use Python to run SQL since node sqlite3 isn't guaranteed
  const { execSync } = require('child_process');
  const pyCode = `
import sqlite3, json, sys
conn = sqlite3.connect(r'${DB_PATH.replace(/\\/g, '\\\\')}')
cur = conn.cursor()
try:
    cur.execute(${JSON.stringify(sql)}, ${JSON.stringify(params)})
    conn.commit()
    if sql.strip().upper().startswith('SELECT'):
        rows = cur.fetchall()
        print(json.dumps([dict(zip([d[0] for d in cur.description], r)) for r in rows]))
    else:
        print('OK:' + str(cur.rowcount))
except Exception as e:
    print('ERR:' + str(e))
finally:
    conn.close()
`;
  try {
    const r = execSync('python3 -c ' + JSON.stringify(pyCode), { timeout: 10, encoding: 'utf8' });
    const out = r.trim();
    if (out.startsWith('ERR:')) return { error: out.slice(4) };
    if (out.startsWith('OK:')) return { affected: parseInt(out.slice(3)) || 0 };
    try { return JSON.parse(out); } catch(e) { return { error: out }; }
  } catch (e) { return { error: e.message }; }
}

function dbInsert(date, data) {
  // Check if exists
  const existing = runSql("SELECT id FROM store_health_daily WHERE collect_date = ?", [date]);
  if (Array.isArray(existing) && existing.length > 0) {
    return { skipped: true, msg: `已有 ${date} 数据` };
  }

  const cols = [
    'collect_date', 'violation_score', 'risk_level', 'has_new_violation',
    'unread_violation_number', 'policy_compliance_count', 'policy_compliance_score',
    'order_fulfillment_count', 'order_fulfillment_score', 'service_metrics_count',
    'service_metrics_score', 'critical_count', 'critical_score',
    'next_day_delivery_rate', 'fast_dispatch_rate', 'late_dispatch_rate',
    'seller_cancellation_rate', 'instant_late_dispatch_rate', 'same_day_late_dispatch_rate',
    'negative_review_rate', 'service_negative_review_rate', 'seller_fault_rr_rate',
    'response_rate_12h', 'avg_response_time_hours', 'chat_satisfaction_rate',
    'shop_limited', 'today_order_count', 'raw_violation', 'raw_performance', 'raw_shop_limit'
  ];
  const vals = [
    date, data.violation_score, data.risk_level, data.has_new_violation ? 1 : 0,
    data.unread_violation_number, data.policy_compliance_count, data.policy_compliance_score,
    data.order_fulfillment_count, data.order_fulfillment_score, data.service_metrics_count,
    data.service_metrics_score, data.critical_count, data.critical_score,
    data.next_day_delivery_rate, data.fast_dispatch_rate, data.late_dispatch_rate,
    data.seller_cancellation_rate, data.instant_late_dispatch_rate, data.same_day_late_dispatch_rate,
    data.negative_review_rate, data.service_negative_review_rate, data.seller_fault_rr_rate,
    data.response_rate_12h, data.avg_response_time_hours, data.chat_satisfaction_rate,
    data.shop_limited ? 1 : 0, data.today_order_count,
    data.raw_violation, data.raw_performance, data.raw_shop_limit
  ];

  const sql = `INSERT INTO store_health_daily (${cols.join(',')}) VALUES (${vals.map(() => '?').join(',')})`;
  return runSql(sql, vals);
}

(async () => {
  const { date, force } = parseArgs();
  console.log(`📊 店铺健康采集 — ${date}`);

  // 1. 连接浏览器
  console.log('[1/4] 连接 AdsPower 浏览器...');
  const ws = await getWs();
  const puppeteer = require('puppeteer-core');
  const b = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null });
  const p = await b.newPage();

  // 2. 导航到卖家中心建立会话
  console.log('[2/4] 建立会话...');
  await p.goto('https://seller-my.tiktok.com/account/health?shop_region=MY&lang=en', {
    waitUntil: 'domcontentloaded', timeout: 60000
  });
  await sleep(3000);

  // 3. 调用3个API
  console.log('[3/4] 采集数据...');

  const apiBase = 'https://seller-my.tiktok.com/api/v1/seller';
  const locale = `locale=en-GB&language=en-GB&oec_seller_id=${SELLER_ID}&seller_id=${SELLER_ID}`;

  // API 1: 违规总览
  console.log('  ⚠️  违规总览...');
  const violResp = await p.evaluate(async (url) => {
    try {
      const r = await fetch(url, { method: 'GET', credentials: 'include' });
      return await r.json();
    } catch(e) { return { error: e.message }; }
  }, `${apiBase}/growth_center/violation/overview/get?${locale}`);

  // API 2: 表现指标
  console.log('  📋 表现指标...');
  const perfResp = await p.evaluate(async (url) => {
    try {
      const r = await fetch(url, { method: 'GET', credentials: 'include' });
      return await r.json();
    } catch(e) { return { error: e.message }; }
  }, `${apiBase}/growth_center/performance/list?${locale}`);

  // API 3: 店铺限制
  console.log('  🏪 店铺限制...');
  const limitResp = await p.evaluate(async (url) => {
    try {
      const r = await fetch(url, { method: 'GET', credentials: 'include' });
      return await r.json();
    } catch(e) { return { error: e.message }; }
  }, `${apiBase}/shop_limit_status/get?${locale}`);

  // Check for errors
  const errors = [];
  if (violResp.error) errors.push(`violation: ${violResp.error}`);
  if (perfResp.error) errors.push(`performance: ${perfResp.error}`);
  if (limitResp.error) errors.push(`shop_limit: ${limitResp.error}`);
  if (errors.length) {
    console.error('❌ API 错误:', errors.join('; '));
    await p.close(); b.disconnect();
    process.exit(1);
  }

  // 4. 解析数据
  console.log('[4/4] 解析 & 入库...');

  // 违规总览解析
  const viol = violResp.data || {};
  const violationPoints = {};
  (viol.violation_points_v2 || []).forEach(vp => {
    const key = vp.violation_type_key || '';
    if (key.includes('policy_compliance')) {
      violationPoints.policy_compliance_count = vp.count;
      violationPoints.policy_compliance_score = vp.violation_score;
    } else if (key.includes('order_fulfillment')) {
      violationPoints.order_fulfillment_count = vp.count;
      violationPoints.order_fulfillment_score = vp.violation_score;
    } else if (key.includes('service_metrics')) {
      violationPoints.service_metrics_count = vp.count;
      violationPoints.service_metrics_score = vp.violation_score;
    } else if (key.includes('risk_fraud') || key.includes('critical')) {
      violationPoints.critical_count = vp.count;
      violationPoints.critical_score = vp.violation_score;
    }
  });

  // 表现指标解析
  const indicators = {};
  (perfResp.data?.indicators || []).forEach(ind => {
    const name = ind.name || '';
    if (name.includes('fast_dispatch_rate_s37d') && !name.includes('pre_cot')) {
      indicators.fast_dispatch_rate = ind.value;
    } else if (name.includes('pre_cot_fast_dispatch_rate')) {
      indicators.next_day_delivery_rate = ind.value;
    } else if (name.includes('late_dispatch_s7d') && !name.includes('instant') && !name.includes('sameday')) {
      indicators.late_dispatch_rate = ind.value;
    } else if (name.includes('liable_cancel_rate')) {
      indicators.seller_cancellation_rate = ind.value;
    } else if (name.includes('late_dispatch_instant')) {
      indicators.instant_late_dispatch_rate = ind.value;
    } else if (name.includes('late_dispatch_sameday')) {
      indicators.same_day_late_dispatch_rate = ind.value;
    } else if (name.includes('negative_review_rate') && name.includes('seller_fault')) {
      indicators.negative_review_rate = ind.value;
    } else if (name.includes('service_issue_negative_review_rate')) {
      indicators.service_negative_review_rate = ind.value;
    } else if (name.includes('quality_refund_rate')) {
      indicators.seller_fault_rr_rate = ind.value;
    } else if (name.includes('valid_mcs_reply_rate')) {
      indicators.response_rate_12h = ind.value;
    } else if (name.includes('IMART_hour')) {
      indicators.avg_response_time_hours = ind.value;
    } else if (name.includes('csat') || name.includes('chat_satisfaction')) {
      indicators.chat_satisfaction_rate = ind.value;
    }
  });

  // 店铺限制解析
  const limit = limitResp.data || {};

  // 风险等级从 section_infos 按分数区间取
  let riskLevel = null;
  const score = viol.violation_score ?? 0;
  if (viol.section_infos && Array.isArray(viol.section_infos)) {
    for (const sec of viol.section_infos) {
      if (sec.left_node !== undefined && sec.right_node !== undefined) {
        if (score >= sec.left_node && score < sec.right_node) {
          riskLevel = sec.risk_level;
          break;
        }
      }
    }
    // 正好在边界上
    if (!riskLevel && viol.section_infos.length > 0) {
      const last = viol.section_infos[viol.section_infos.length - 1];
      if (score >= last.left_node) riskLevel = last.risk_level;
    }
  }

  const result = {
    // 违规
    violation_score: viol.violation_score ?? null,
    risk_level: riskLevel,
    has_new_violation: viol.has_new_violation ?? null,
    unread_violation_number: viol.unread_violation_number ?? null,
    policy_compliance_count: violationPoints.policy_compliance_count ?? null,
    policy_compliance_score: violationPoints.policy_compliance_score ?? null,
    order_fulfillment_count: violationPoints.order_fulfillment_count ?? null,
    order_fulfillment_score: violationPoints.order_fulfillment_score ?? null,
    service_metrics_count: violationPoints.service_metrics_count ?? null,
    service_metrics_score: violationPoints.service_metrics_score ?? null,
    critical_count: violationPoints.critical_count ?? null,
    critical_score: violationPoints.critical_score ?? null,
    // 表现
    next_day_delivery_rate: indicators.next_day_delivery_rate ?? null,
    fast_dispatch_rate: indicators.fast_dispatch_rate ?? null,
    late_dispatch_rate: indicators.late_dispatch_rate ?? null,
    seller_cancellation_rate: indicators.seller_cancellation_rate ?? null,
    instant_late_dispatch_rate: indicators.instant_late_dispatch_rate ?? null,
    same_day_late_dispatch_rate: indicators.same_day_late_dispatch_rate ?? null,
    negative_review_rate: indicators.negative_review_rate ?? null,
    service_negative_review_rate: indicators.service_negative_review_rate ?? null,
    seller_fault_rr_rate: indicators.seller_fault_rr_rate ?? null,
    response_rate_12h: indicators.response_rate_12h ?? null,
    avg_response_time_hours: indicators.avg_response_time_hours ?? null,
    chat_satisfaction_rate: indicators.chat_satisfaction_rate ?? null,
    // 限制
    shop_limited: limit.shop_limited ?? null,
    today_order_count: limit.today_order_count ?? null,
    // 原始
    raw_violation: JSON.stringify(violResp),
    raw_performance: JSON.stringify(perfResp),
    raw_shop_limit: JSON.stringify(limitResp),
  };

  // Fix typo in field name
  if (result.violation_score === null && violResp.data) {
    result.violation_score = violResp.data.violation_score ?? null;
  }

  // 5. 写入JSON文件
  const outDir = path.join(HOME, '.tkads', 'data');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `store_health_${date}.json`);
  const outData = { date, ...result, force: !!force };
  fs.writeFileSync(outFile, JSON.stringify(outData, null, 2));
  console.log(`  📄 已保存: ${outFile}`);

  // 提示入库命令
  const importCmd = `python3 "${path.join(__dirname, 'store_health_import.py')}" "${outFile}"`;
  console.log(`  💡 入库: ${importCmd}`);

  // 6. 输出摘要
  console.log('\n══════ 采集摘要 ══════');
  console.log(`  违规分: ${result.violation_score ?? '-'} | 风险等级: ${result.risk_level || '-'}`);
  console.log(`  次日发货率: ${result.next_day_delivery_rate != null ? (result.next_day_delivery_rate * 100).toFixed(1) + '%' : '-'}`);
  console.log(`  快速发货率: ${result.fast_dispatch_rate != null ? (result.fast_dispatch_rate * 100).toFixed(1) + '%' : '-'}`);
  console.log(`  卖家取消率: ${result.seller_cancellation_rate != null ? (result.seller_cancellation_rate * 100).toFixed(2) + '%' : '-'}`);
  console.log(`  差评率: ${result.negative_review_rate != null ? (result.negative_review_rate * 100).toFixed(2) + '%' : '-'}`);
  console.log(`  12h响应率: ${result.response_rate_12h != null ? (result.response_rate_12h * 100).toFixed(1) + '%' : '-'}`);
  console.log(`  聊天满意度: ${result.chat_satisfaction_rate != null ? (result.chat_satisfaction_rate * 100).toFixed(1) + '%' : '-'}`);
  console.log(`  店铺限制: ${result.shop_limited ? '是' : '否'} | 今日订单: ${result.today_order_count ?? '-'}`);
  console.log('═══════════════════════');

  await p.close();
  b.disconnect();
  console.log('\n✅ 采集完成');
})().catch(e => {
  console.error('\n❌ [FATAL]', e.message);
  process.exit(1);
});
