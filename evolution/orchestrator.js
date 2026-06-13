#!/usr/bin/env node
/**
 * hermes-evolution-engine — 自进化引擎总编排器
 * 
 * 每日运行一次，执行完整进化循环：
 *   1. Explorer — 搜索外部新东西
 *   2. AutoLoader — 检查使用频率，升级技能
 *   3. Reviewer — 蒸馏今日经验
 *   4. 汇总报告
 * 
 * Usage: node orchestrator.js [--check-only]
 *   --check-only: 只检查不写文件
 */
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');

const EVOLUTION_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || '.',
  '.tkads', 'evolution'
);

function runScript(scriptName, args = []) {
  const scriptPath = path.join(EVOLUTION_DIR, scriptName);
  if (!fs.existsSync(scriptPath)) {
    return { success: false, error: `文件不存在: ${scriptPath}` };
  }
  const result = spawnSync('node', [scriptPath, ...args], {
    cwd: EVOLUTION_DIR,
    timeout: 60000,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    success: result.status === 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
    error: result.error ? result.error.message : null,
  };
}

function sendToFeishu(message) {
  const webhookPath = path.join(
    process.env.HOME || process.env.USERPROFILE || '.',
    '.hermes', 'scripts', '.report_webhook'
  );
  try {
    if (fs.existsSync(webhookPath)) {
      const url = fs.readFileSync(webhookPath, 'utf8').trim();
      const payload = JSON.stringify({
        msg_type: 'text',
        content: { text: message }
      });
      const isHttps = url.startsWith('https');
      const transport = isHttps ? https : http;
      const urlObj = new URL(url);
      const req = transport.request({
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      }, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {});
      });
      req.on('error', () => {});
      req.write(payload);
      req.end();
    }
  } catch(e) {}
}

async function main() {
  const checkOnly = process.argv.includes('--check-only');
  const startTime = Date.now();
  
  console.log('╔══════════════════════════════════════╗');
  console.log('║  🌱 hermes-evolution-engine           ║');
  console.log(`║  ${new Date().toISOString().slice(0,19).replace('T',' ')}            ║`);
  console.log('╚══════════════════════════════════════╝');
  console.log('');

  // ─── Phase 1: Explorer ───
  console.log('📡 Phase 1: Explorer — 搜索外部新资源...');
  const explorerResult = runScript('explorer.js', checkOnly ? ['--dry-run'] : []);
  if (explorerResult.success) {
    const findings = explorerResult.stdout.trim().split('\n').filter(l => l.trim());
    console.log(`  ✅ 找到了 ${findings.length} 个结果`);
    // Print top 3 findings
    const topFindings = findings.slice(0, 3);
    topFindings.forEach(f => {
      try {
        const obj = JSON.parse(f);
        console.log(`  ★ ${obj.score}/10 — ${obj.title} (${obj.url})`);
      } catch(e) {
        console.log(`  ${f.slice(0, 100)}`);
      }
    });
  } else {
    console.log(`  ⚠️  Explorer 失败: ${explorerResult.error || explorerResult.stderr.slice(0, 200)}`);
  }
  console.log('');

  // ─── Phase 2: AutoLoader ───
  console.log('📊 Phase 2: AutoLoader — 技能使用分析...');
  const autoloadResult = runScript('autoloader.js', checkOnly ? ['--dry-run'] : []);
  if (autoloadResult.success) {
    const lines = autoloadResult.stdout.trim().split('\n').filter(l => l.trim());
    lines.slice(0, 10).forEach(l => console.log(`  ${l}`));
  } else {
    console.log(`  ⚠️  AutoLoader 失败: ${autoloadResult.error || autoloadResult.stderr.slice(0, 200)}`);
  }
  console.log('');

  // ─── Phase 3: Reviewer ───
  console.log('📝 Phase 3: Reviewer — 蒸馏今日经验...');
  const today = new Date().toISOString().slice(0, 10);
  const reviewerResult = runScript('reviewer.js', [checkOnly ? '' : '--auto-save', '--date', today].filter(Boolean));
  if (reviewerResult.success) {
    const lines = reviewerResult.stdout.trim().split('\n').filter(l => l.trim());
    // Find key insights
    const capabilities = lines.filter(l => l.includes('new_capabilities') || l.includes('能力'));
    const patterns = lines.filter(l => l.includes('patterns_learned') || l.includes('模式'));
    const errors = lines.filter(l => l.includes('errors_fixed') || l.includes('错误'));
    if (capabilities.length) capabilities.forEach(l => console.log(`  📌 ${l.slice(0, 120)}`));
    if (patterns.length) patterns.forEach(l => console.log(`  🧠 ${l.slice(0, 120)}`));
    if (errors.length) errors.forEach(l => console.log(`  🔧 ${l.slice(0, 120)}`));
    if (!capabilities.length && !patterns.length && !errors.length) {
      console.log(`  ✅ 已完成，输出 ${lines.length} 行`);
    }
  } else {
    console.log(`  ⚠️  Reviewer 失败: ${reviewerResult.error || reviewerResult.stderr.slice(0, 200)}`);
  }
  console.log('');

  // ─── Phase 3.5: 循环A状态检查 ───
  console.log('🔄 Phase 3.5: 自进化循环A — 检查最近自检结果...');
  const evolveLogPath = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.tkads', 'operation_log');
  if (fs.existsSync(evolveLogPath)) {
    const today = new Date().toISOString().slice(0, 10);
    const logFile = path.join(evolveLogPath, today + '.jsonl');
    if (fs.existsSync(logFile)) {
      const lines = fs.readFileSync(logFile, 'utf-8').trim().split('\n').filter(l => l.trim());
      const evolveEntries = lines.filter(l => l.includes('self_evolve'));
      console.log(`  ✅ 今日自检记录: ${evolveEntries.length} 次`);
    } else {
      console.log(`  ⚠️ 今日尚未运行自进化循环A`);
    }
  } else {
    console.log(`  ⚠️ E层日志系统尚未初始化`);
  }
  console.log('');

  // ─── Phase 4: Summary ───
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('═'.repeat(40));
  console.log(`✅ 进化循环完成 (${duration}s)`);

  if (!checkOnly) {
    // Check cycle A status for summary
    let cycleAStatus = '⚪ 未运行';
    try {
      const opLogPath = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.tkads', 'operation_log');
      const todayFile = path.join(opLogPath, new Date().toISOString().slice(0, 10) + '.jsonl');
      if (fs.existsSync(todayFile)) {
        const logData = fs.readFileSync(todayFile, 'utf-8');
        const evolveLines = logData.split('\n').filter(l => l.includes('self_evolve'));
        cycleAStatus = evolveLines.length > 0 ? `✅ ${evolveLines.length}次` : '⚪ 未运行';
      }
    } catch(e) { cycleAStatus = '⚪ 未运行'; }

    const summary = [
      `🌱 hermes-evolution-engine 每日进化报告`,
      `━━━━━━━━━━━━━━━━━━━━━━`,
      `📡 Explorer: ${explorerResult.success ? '✅' : '❌'}`,
      `📊 AutoLoader: ${autoloadResult.success ? '✅' : '❌'}`,
      `📝 Reviewer: ${reviewerResult.success ? '✅' : '❌'}`,
      `🔄 循环A: ${cycleAStatus}`,
      `⏱ 耗时: ${duration}s`,
      `━━━━━━━━━━━━━━━━━━━━━━`,
    ].join('\n');
    sendToFeishu(summary);
  }
}

main().catch(e => {
  console.error('❌ Orchestrator 错误:', e.message);
  process.exit(1);
});
