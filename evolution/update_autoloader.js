#!/usr/bin/env node
/**
 * AutoLoader C方案 — 全量技能扫描 + 自动化更新
 *
 * 1. 扫描所有实际存在的 SKILL.md
 * 2. 对比 usage.json，补充缺失
 * 3. 标记废弃，修复 bug，重写 usage.json
 */

const fs = require('fs');
const path = require('path');

const HERMES_SKILLS = path.join(
  process.env.HOME || process.env.USERPROFILE,
  '.hermes', 'skills'
);
const EVOLUTION_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE,
  '.tkads', 'evolution'
);
const USAGE_FILE = path.join(EVOLUTION_DIR, 'usage.json');
const AUTOLOAD_SCRIPT = path.join(EVOLUTION_DIR, 'autoload.sh');
const SCHEMA_VERSION = '1.1';

// ── Scan all actual skills on disk ──
function scanActualSkills() {
  const skills = {};
  
  function walk(dir, category) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const skillName = entry.name;
        const skillMd = path.join(fullPath, 'SKILL.md');
        if (fs.existsSync(skillMd)) {
          // This is a skill — use flat SkillDirName as ID
          skills[skillName] = { name: skillName, category, path: fullPath, skillMd };
        } else {
          walk(fullPath, skillName);
        }
      }
    }
  }
  
  const topDirs = fs.readdirSync(HERMES_SKILLS, { withFileTypes: true });
  for (const d of topDirs) {
    if (d.isDirectory() && d.name !== '.archive') {
      walk(path.join(HERMES_SKILLS, d.name), d.name);
    }
  }
  
  return skills;
}

// ── Get description from SKILL.md ──
function getDescription(skillPath) {
  try {
    const content = fs.readFileSync(path.join(skillPath, 'SKILL.md'), 'utf-8');
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('# ')) return trimmed.slice(2).trim();
      if (trimmed.startsWith('name:')) return trimmed.slice(5).trim();
      if (trimmed.startsWith('description:')) return trimmed.slice(12).trim();
    }
    return path.basename(skillPath);
  } catch {
    return path.basename(skillPath);
  }
}

// ── Main ──
const actualSkills = scanActualSkills();
console.log(`磁盘上现有技能: ${Object.keys(actualSkills).length} 个`);

// Load existing usage.json
let existing = { schema_version: SCHEMA_VERSION, updated_at: '', skills: {}, auto_load_list: [] };
try {
  const raw = fs.readFileSync(USAGE_FILE, 'utf-8');
  existing = JSON.parse(raw);
  
  // Fix: if tkads-api-architecture is at root, move it into skills
  if (existing['tkads-api-architecture'] && !existing.skills['tkads-api-architecture']) {
    const buggy = existing['tkads-api-architecture'];
    delete existing['tkads-api-architecture'];
    existing.skills['tkads-api-architecture'] = {
      name: buggy.description || 'TK广告API架构',
      usage_count: buggy.uses || 0,
      last_used: buggy.last_use || '',
      auto_load: buggy.auto_load || false,
      created: buggy.created || ''
    };
    console.log('修复bug: tkads-api-architecture 已移入 skills 字典');
  }
  
  // Ensure skills key exists
  if (!existing.skills) existing.skills = {};
  if (!Array.isArray(existing.auto_load_list)) existing.auto_load_list = [];
  
} catch {
  console.log('新建 usage.json');
}

const now = new Date().toISOString().slice(0, 10);

// Merge: keep existing counts, add new skills
let newCount = 0;
const alreadyInUsage = new Set(Object.keys(existing.skills));

for (const [id, info] of Object.entries(actualSkills)) {
  if (!existing.skills[id]) {
    existing.skills[id] = {
      name: getDescription(info.path),
      usage_count: 0,
      last_used: '',
      auto_load: false,
      category: info.category,
      added: now
    };
    newCount++;
  }
}

console.log(`已有记录: ${alreadyInUsage.size} 个`);
console.log(`新增技能: ${newCount} 个`);
console.log('新增列表:');
for (const [id, info] of Object.entries(actualSkills)) {
  if (!alreadyInUsage.has(id)) {
    console.log(`  + ${id} [${info.category}]`);
  }
}

// Auto-load decisions
const autoLoadList = [];
let deprecatedCount = 0;

for (const [id, skill] of Object.entries(existing.skills)) {
  const lastUsed = skill.last_used || '';
  const usageCount = skill.usage_count || 0;
  const daysSince = lastUsed ? Math.floor((new Date() - new Date(lastUsed)) / (1000*60*60*24)) : 999;
  const isFrequent = usageCount >= 10;
  const isRecent = daysSince <= 7;
  const isBorderline = daysSince <= 30 && daysSince > 7;
  
  if (isFrequent || isRecent) {
    skill.auto_load = true;
    autoLoadList.push(id);
  } else if (daysSince >= 30 && !isFrequent) {
    skill.auto_load = false;
    deprecatedCount++;
  } else if (isBorderline) {
    // used within 30 days, keep auto-load
    skill.auto_load = true;
    autoLoadList.push(id);
  } else {
    skill.auto_load = false;
  }
}

// Also add some high-value ecommerce skills even if not yet used
const forceLoad = ['tkads-api-architecture'];
for (const id of forceLoad) {
  if (existing.skills[id] && !autoLoadList.includes(id)) {
    existing.skills[id].auto_load = true;
    autoLoadList.push(id);
  }
}

existing.schema_version = SCHEMA_VERSION;
existing.updated_at = now;
existing.auto_load_list = autoLoadList;

// Write updated usage.json
fs.writeFileSync(USAGE_FILE, JSON.stringify(existing, null, 2));
console.log(`\n写入 usage.json 完成`);
console.log(`共 ${Object.keys(existing.skills).length} 个技能`);
console.log(`自动加载: ${autoLoadList.length} 个`);
const untrackedCount = Object.values(existing.skills).filter(s => !s.last_used && !s.auto_load).length;
console.log(`新加入未使用: ${untrackedCount} 个`);
console.log(`已废弃(>30天未用): ${deprecatedCount} 个`);

// Generate autoload.sh (documentation-only since hermes CLI not in PATH)
const sh = `#!/usr/bin/env bash
# Auto-generated by auto-scan.js (v${SCHEMA_VERSION})
# Generated: ${now}
# Total skills tracked: ${Object.keys(existing.skills).length}
# Auto-load: ${autoLoadList.length} skills
# Deprecated (30d+ unused): ${deprecatedCount}
#
# NOTE: hermes CLI is not available from bash on this Windows setup.
# Skill loading happens via the Hermes Agent's internal session init.
# This script is for documentation and manual reference only.
#

echo "=== Auto-Load Skills (${autoLoadList.length}) ==="
${autoLoadList.map(id => `echo "  [LOAD] ${id}"`).join('\n')}

echo ""
echo "=== Deprecated Skills (${deprecatedCount}) ==="
${Object.entries(existing.skills).filter(([_, s]) => !s.auto_load).map(([id, s]) => {
  const daysSince = s.last_used ? Math.floor((new Date() - new Date(s.last_used)) / (1000*60*60*24)) : '?';
  return `echo "  [SKIP] ${id} (last: ${s.last_used || 'never'}, ${daysSince}d ago)"`;
}).join('\n')}
`;

fs.writeFileSync(AUTOLOAD_SCRIPT, sh);
console.log(`\n生成 autoload.sh 完成`);

// Print summary
console.log('\n========================================');
console.log('  AutoLoader C方案 — 完成');
console.log('========================================');
console.log(`已有技能: ${Object.keys(existing.skills).length} 个`);
console.log(`新增技能: ${newCount} 个`);
console.log(`自动加载: ${autoLoadList.length} 个`);
console.log(`新加入清单(未使用): ${untrackedCount} 个`);
console.log(`废弃(>30天不活跃): ${deprecatedCount} 个`);
console.log('BUG修复: tkads-api-architecture bug 已修复');
console.log(`Schema: ${SCHEMA_VERSION}`);
console.log(`Updated: ${now}`);
