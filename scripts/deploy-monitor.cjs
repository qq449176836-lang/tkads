#!/usr/bin/env node
/**
 * 全能守护者 — 一键部署脚本
 * 用法: node deploy-monitor.cjs
 * 
 * 给别的 Hermes 一句话: 把文件复制到 ~/.hermes/scripts/ 目录，然后 node ~/.hermes/scripts/deploy-monitor.cjs
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const HOME = os.homedir();
const SCRIPTS_DIR = path.join(HOME, '.hermes', 'scripts');
const HERMES_HOME = path.join(
  process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'),
  'cn.org.hermesagent.desktop', 'runtime', 'hermes-home', 'scripts'
);
const MONITOR_PY_URL = 'https://raw.githubusercontent.com/qq449176836-lang/hermes/main/scripts/monitor.py';

function print(m) { console.log(m); }

async function main() {
  print('');
  print('╔══════════════════════════════════════════╗');
  print('║      🤖 全能守护者 — 一键部署           ║');
  print('╚══════════════════════════════════════════╝');
  print('');

  // ========== 第1步：检查环境 ==========
  print('🔍 [1/5] 检查环境...');
  
  // 找到 Hermes exe
  let hermesExe = null;
  const versionsDir = path.join(process.env.APPDATA || '', 'cn.org.hermesagent.desktop', 'runtime', 'versions');
  if (fs.existsSync(versionsDir)) {
    const dirs = fs.readdirSync(versionsDir);
    for (const d of dirs.sort().reverse()) {
      const exe = path.join(versionsDir, d, 'hermes-agent-cn-runtime-win32-x64.exe');
      if (fs.existsSync(exe)) { hermesExe = exe; break; }
    }
  }
  if (!hermesExe) {
    print('❌ 未找到 Hermes 可执行文件！请确认 Hermes 已安装');
    process.exit(1);
  }
  print(`  ✅ Hermes: ${hermesExe}`);

  // 检查 Python
  try {
    execSync('python --version', { stdio: 'pipe' });
    print('  ✅ Python 可用');
  } catch {
    print('❌ 未找到 Python，请先安装 Python 3');
    process.exit(1);
  }

  // 检查 Node.js
  try {
    execSync('node --version', { stdio: 'pipe' });
    print('  ✅ Node.js 可用');
  } catch {
    print('❌ 未找到 Node.js');
    process.exit(1);
  }

  // ========== 第2步：获取 Webhook ==========
  print('');
  print('🔗 [2/5] 飞书 Webhook 配置');
  print('  请提供一个飞书群机器人 Webhook URL');
  print('  格式: https://open.feishu.cn/open-apis/bot/v2/hook/xxx');
  print('');

  // 尝试从环境变量读取
  let webhook = process.env.FEISHU_BOT_WEBHOOK || '';
  
  if (!webhook) {
    // 检查已有的 .report_webhook
    const existingWebhook = path.join(SCRIPTS_DIR, '.report_webhook');
    if (fs.existsSync(existingWebhook)) {
      webhook = fs.readFileSync(existingWebhook, 'utf8').trim();
      print(`  📋 发现已有 Webhook: ${webhook.substring(0, 40)}...`);
    }
    
    if (!webhook) {
      print('  ⚠️ 未设置 FEISHU_BOT_WEBHOOK 环境变量');
      print('  部署完成后请手动创建文件:');
      print(`  echo "你的webhook地址" > ${path.join(SCRIPTS_DIR, '.report_webhook')}`);
      print('');
    }
  }

  // ========== 第3步：创建脚本文件 ==========
  print('📁 [3/5] 创建监控脚本...');

  // 确保目录存在
  for (const dir of [SCRIPTS_DIR, HERMES_HOME]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  // 下载 monitor.py
  print('  ⏳ 下载 monitor.py...');
  try {
    const https = require('https');
    const pyContent = await new Promise((resolve, reject) => {
      https.get(MONITOR_PY_URL, res => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });
    
    // 写入两个位置
    for (const dir of [SCRIPTS_DIR, HERMES_HOME]) {
      fs.writeFileSync(path.join(dir, 'monitor.py'), pyContent);
    }
    print('  ✅ monitor.py 已下载');
  } catch (e) {
    print(`  ⚠️ 下载失败 (${e.message})，尝试从本地复制...`);
    // 从自身目录复制
    const localPy = path.join(__dirname, 'monitor.py');
    if (fs.existsSync(localPy)) {
      for (const dir of [SCRIPTS_DIR, HERMES_HOME]) {
        fs.copyFileSync(localPy, path.join(dir, 'monitor.py'));
      }
      print('  ✅ 已从本地复制 monitor.py');
    } else {
      print('  ❌ 无法获取 monitor.py！请确认网络连接或手动复制');
      process.exit(1);
    }
  }

  // 创建 .bat 包装
  const batFiles = {
    'monitor-fast.bat': `@echo off\npython "${path.join(HERMES_HOME, 'monitor.py').replace(/\\/g, '\\\\')}" --fast %*\n`,
    'cron-guardian.bat': `@echo off\npython "${path.join(HERMES_HOME, 'monitor.py').replace(/\\/g, '\\\\')}" --full %*\n`,
  };

  for (const [name, content] of Object.entries(batFiles)) {
    for (const dir of [SCRIPTS_DIR, HERMES_HOME]) {
      fs.writeFileSync(path.join(dir, name), content);
    }
    print(`  ✅ ${name}`);
  }

  // 保存 Webhook
  if (webhook) {
    fs.writeFileSync(path.join(SCRIPTS_DIR, '.report_webhook'), webhook + '\n');
    // 也写入 hermes-home
    fs.writeFileSync(path.join(HERMES_HOME, '.report_webhook'), webhook + '\n');
    print('  ✅ Webhook 已保存');
  }

  // ========== 第4步：清理旧监控任务 ==========
  print('');
  print('🧹 [4/5] 清理旧监控任务...');
  
  try {
    const listOutput = execSync(`"${hermesExe}" cron list`, { encoding: 'utf8', timeout: 15000 });
    
    // 查找旧的监控相关任务ID
    const oldTasks = [
      { name: 'cron-guardian', id: null },
      { name: 'monitor-fast', id: null },
    ];
    
    const lines = listOutput.split('\n');
    let currentId = null;
    for (const line of lines) {
      const idMatch = line.match(/^\s+([a-f0-9]+)\s+\[(\w+)\]/);
      if (idMatch) currentId = idMatch[1];
      for (const task of oldTasks) {
        if (line.includes(`Name:      ${task.name}`)) task.id = currentId;
      }
    }
    
    for (const task of oldTasks) {
      if (task.id) {
        try {
          execSync(`"${hermesExe}" cron remove ${task.id}`, { stdio: 'pipe', timeout: 10000 });
          print(`  ✅ 已删除旧任务: ${task.name}`);
        } catch (e) {
          print(`  ⚠️ 删除 ${task.name} 失败: ${e.message}`);
        }
      }
    }
  } catch (e) {
    print(`  ⚠️ 获取任务列表失败: ${e.message}`);
  }

  // ========== 第5步：注册新定时任务 ==========
  print('');
  print('⏰ [5/5] 注册定时任务...');

  const newJobs = [
    { name: 'monitor-fast', script: 'monitor-fast.bat', schedule: 'every 30m', deliver: 'feishu' },
    { name: 'cron-guardian', script: 'cron-guardian.bat', schedule: 'every 120m', deliver: 'feishu' },
  ];

  for (const job of newJobs) {
    try {
      const cmd = `"${hermesExe}" cron create --name ${job.name} --deliver ${job.deliver} --script ${job.script} --no-agent "${job.schedule}"`;
      const out = execSync(cmd, { encoding: 'utf8', timeout: 15000 });
      print(`  ✅ ${job.name}: ${out.trim().split('\n')[0]}`);
    } catch (e) {
      print(`  ❌ 注册 ${job.name} 失败: ${e.message}`);
    }
  }

  // ========== 完成 ==========
  print('');
  print('╔══════════════════════════════════════════╗');
  print('║      ✅ 部署完成！                       ║');
  print('╚══════════════════════════════════════════╝');
  print('');
  print('📋 已安装的监控任务:');
  print('  🔍 monitor-fast     — 每30分钟 (快速探针，仅变化时通知)');
  print('  🩺 cron-guardian    — 每2小时 (完整体检 + 健康报告带IP)');
  print('');
  print('🔧 检测维度: Hermes进程 | 浏览器 | 磁盘 | 数据库 | 网络 | 定时任务');
  print('📊 告警分级: P0 🔴 进程挂 → 飞书@all + 自动重启');
  print('              P1 🟠 浏览器/DB/cron异常 → 飞书通知 + 自动恢复');
  print('              P2 🟡 磁盘/网络波动 → 飞书通知');
  print('');
  print('📝 手动配置（如果需要）:');
  if (!webhook) print(`  echo "你的webhook地址" > ${path.join(SCRIPTS_DIR, '.report_webhook')}`);
  print('');
  print('🚀 测试运行: python ' + path.join(HERMES_HOME, 'monitor.py') + ' --full');
  print('');
}

main().catch(e => {
  console.error('❌ 部署失败:', e.message);
  process.exit(1);
});
