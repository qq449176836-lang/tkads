#!/usr/bin/env node
/**
 * reviewer.js — Hermes Evolution Engine: Session Artifact Reviewer
 *
 * Reads today's session artifacts, distills key insights, generates a
 * structured summary, and identifies memory-worthy facts.
 *
 * Usage:
 *   node reviewer.js                        # Review today (stdout output)
 *   node reviewer.js --date 2026-06-11     # Review a specific date
 *   node reviewer.js --auto-save           # Write memory facts to file
 *   node reviewer.js --output report.json  # Write full report to file
 *
 * Sources:
 *   ~/.tkads/data/analytics.db → operation_log_v2
 *   ~/.tkads/tkads-catalog.json
 *   ~/.tkads/evolution/usage.json
 *   ~/.tkads/evolution/        — existing reviewer/explorer/autoloader outputs
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const os = require('os');

// ─── Path resolution ──────────────────────────────────────────────────────────

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const TKADS_DIR = path.join(HOME, '.tkads');
const DATA_DIR = path.join(TKADS_DIR, 'data');
const EVOLUTION_DIR = path.join(TKADS_DIR, 'evolution');
const REVIEWS_DIR = path.join(EVOLUTION_DIR, 'reviews');
const ANALYTICS_DB = path.join(DATA_DIR, 'analytics.db');
const CATALOG_PATH = path.join(TKADS_DIR, 'tkads-catalog.json');
const USAGE_PATH = path.join(EVOLUTION_DIR, 'usage.json');
const EXPLORER_CACHE = path.join(EVOLUTION_DIR, 'explorer_cache.json');

// ─── Arg parsing ──────────────────────────────────────────────────────────────

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--date' && i + 1 < process.argv.length) {
    args.date = process.argv[++i];
  } else if (a === '--auto-save') {
    args.autoSave = true;
  } else if (a === '--output' && i + 1 < process.argv.length) {
    args.output = process.argv[++i];
  } else {
    args[a.replace(/^--/, '')] = true;
  }
}

const TODAY = args.date || new Date().toISOString().slice(0, 10);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function log(...msg) {
  console.error('[reviewer]', ...msg);
}

function readJSON(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    log(`Warning: could not read ${filePath}: ${e.message}`);
    return null;
  }
}

function writeJSON(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// ─── SQLite query via Python child_process ────────────────────────────────────

function queryDB(sql, params = []) {
  const dbQueryPy = path.join(EVOLUTION_DIR, 'db_query.py');
  if (!fs.existsSync(dbQueryPy)) {
    log(`Warning: db_query.py not found at ${dbQueryPy}`);
    return [];
  }

  const args = [dbQueryPy, sql, ...params.map(p => {
    if (p === null || p === undefined) return 'None';
    return String(p);
  })];

  // On Windows, use 'python' (since python3.exe doesn't exist); on Unix use 'python3'
  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
  const result = spawnSync(pythonCmd, args, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    cwd: HOME
  });

  if (result.error) {
    log(`Python error: ${result.error.message}`);
    return [];
  }
  if (result.stderr && result.stderr.trim()) {
    const stderr = result.stderr.trim();
    if (!stderr.includes('error')) {
      log(`Python stderr: ${stderr}`);
    }
  }
  try {
    const parsed = JSON.parse(result.stdout);
    if (parsed.error) {
      log(`DB query error: ${parsed.error}`);
      return [];
    }
    return parsed;
  } catch (e) {
    log(`JSON parse error: ${e.message}, stdout: ${result.stdout.slice(0, 300)}`);
    return [];
  }
}

// ─── Data collectors ──────────────────────────────────────────────────────────

function collectOperationLog() {
  log(`Querying operation_log_v2 for date: ${TODAY}`);
  const entries = queryDB(
    `SELECT * FROM operation_log_v2 WHERE date(created_at) = date(?) ORDER BY created_at`,
    [TODAY]
  );
  log(`Found ${entries.length} operation_log_v2 entries for ${TODAY}`);
  return entries;
}

function collectOperationLogLegacy() {
  const entries = queryDB(
    `SELECT * FROM operation_log WHERE date(timestamp) = date(?) ORDER BY timestamp`,
    [TODAY]
  );
  if (entries.length > 0) log(`Found ${entries.length} legacy operation_log entries for ${TODAY}`);
  return entries;
}

function collectDailyStats() {
  const entries = queryDB(
    `SELECT * FROM daily_stats WHERE date = ? ORDER BY date`,
    [TODAY]
  );
  if (entries.length > 0) log(`Found ${entries.length} daily_stats entries for ${TODAY}`);
  return entries;
}

function collectAllTimeStats() {
  const rows = queryDB(
    `SELECT operation, status, COUNT(*) as cnt FROM operation_log_v2 GROUP BY operation, status ORDER BY cnt DESC`
  );
  return rows;
}

function readCatalog() {
  const catalog = readJSON(CATALOG_PATH);
  if (!catalog) {
    log('Warning: tkads-catalog.json not found');
    return null;
  }
  return catalog;
}

function readUsage() {
  return readJSON(USAGE_PATH);
}

function readExplorerCache() {
  return readJSON(EXPLORER_CACHE);
}

function checkEvolutionFiles() {
  const insights = [];
  try {
    const files = fs.readdirSync(EVOLUTION_DIR);
    for (const f of files) {
      const fp = path.join(EVOLUTION_DIR, f);
      const stat = fs.statSync(fp);
      const mtime = stat.mtime.toISOString().slice(0, 10);
      if (mtime === TODAY && f.endsWith('.json') && f !== 'explorer_cache.json') {
        const data = readJSON(fp);
        if (data) insights.push({ file: f, data });
      }
    }
  } catch (e) {
    log(`Could not scan evolution dir: ${e.message}`);
  }
  return insights;
}

// ─── Analysis engine ──────────────────────────────────────────────────────────

function analyzeOperations(entries) {
  const newCapabilities = [];
  const errorsFixed = [];
  const configChanges = [];
  const patternsLearned = [];
  const memorySaves = [];

  for (const e of entries) {
    const op = e.operation || '';
    const status = e.status || '';
    const errorMsg = e.error_message || '';
    const actualResult = e.actual_result || '';
    const namespace = e.namespace || '';
    const storeId = e.store_id || '';

    // --- New capabilities ---
    if (op === 'create_ad' && status === 'OK') {
      const insight = `Created ad ${e.campaign_id || ''} with ROI=${e.expected_roi || '?'}`.trim();
      if (!newCapabilities.includes(insight)) newCapabilities.push(insight);
    }

    // New skills / first-time operations
    if (op === 'self_evolve' && status === 'OK' && actualResult) {
      const summary = `Self-evolution cycle: ${actualResult}`;
      if (!newCapabilities.includes(summary)) newCapabilities.push(summary);
    }

    // --- Errors and fixes ---
    if (errorMsg && errorMsg.length > 0) {
      const errKey = `${op}: ${errorMsg.slice(0, 120)}`;
      const fixed = !!(status === 'OK' || status === 'fixed' || status === 'retry_ok');
      errorsFixed.push({
        operation: op,
        error: errorMsg,
        fixed: fixed,
        store: storeId
      });
    }

    // --- Config changes ---
    if (op.startsWith('config') || op.startsWith('update_') || op === 'change_config') {
      configChanges.push({
        operation: op,
        detail: actualResult || request_body || '',
        store: storeId
      });
    }

    // --- Patterns learned ---
    if (status === 'OK' && op && !e.error_message) {
      const pattern = `Operation "${op}" completed successfully in namespace "${namespace}"`;
      if (!patternsLearned.find(p => p.includes(op))) {
        patternsLearned.push(pattern);
      }
    }

    // --- Memory-worthy: bugs and their root causes ---
    if (errorMsg && errorMsg.length > 0 && status !== 'OK') {
      memorySaves.push({
        type: 'bug_root_cause',
        description: `Bug in ${op}: ${errorMsg.slice(0, 200)}`,
        source: `operation_log_v2 entry #${e.id || '?'} on ${TODAY}`
      });
    }
  }

  // Deduplicate patterns
  const uniquePatterns = [...new Set(patternsLearned)];

  return {
    newCapabilities: [...new Set(newCapabilities)],
    errorsFixed,
    configChanges,
    patternsLearned: uniquePatterns,
    memorySaves
  };
}

function analyzeCatalog(catalog, prevCatalog) {
  if (!catalog) return { changes: [], suggestions: [], memorySaves: [] };

  const changes = [];
  const memorySaves = [];

  // Check version changes
  if (prevCatalog && prevCatalog.tkads_version !== catalog.tkads_version) {
    changes.push(`tkads_version: ${prevCatalog.tkads_version} → ${catalog.tkads_version}`);
    memorySaves.push({
      type: 'version_change',
      description: `tkads version changed from ${prevCatalog.tkads_version} to ${catalog.tkads_version}`,
      source: 'tkads-catalog.json'
    });
  }

  // Check component version changes
  if (prevCatalog && prevCatalog.versions) {
    for (const [comp, ver] of Object.entries(catalog.versions || {})) {
      const prevVer = prevCatalog.versions[comp];
      if (prevVer && prevVer !== ver) {
        changes.push(`${comp}: ${prevVer} → ${ver}`);
        memorySaves.push({
          type: 'component_update',
          description: `Component "${comp}" updated to v${ver}`,
          source: 'tkads-catalog.json'
        });
      }
    }
  }

  // Check new plugins/commands/scripts
  if (prevCatalog) {
    for (const key of ['plugins', 'commands', 'scripts', 'databases']) {
      const cur = catalog[key] || {};
      const prev = prevCatalog[key] || {};
      for (const [name, val] of Object.entries(cur)) {
        if (!prev[name]) {
          changes.push(`New ${key.slice(0, -1)}: "${name}" (${val.version || '?'})`);
          memorySaves.push({
            type: 'new_component',
            description: `New ${key.slice(0, -1)} "${name}" added`,
            source: 'tkads-catalog.json'
          });
        }
      }
    }
  }

  return { changes, suggestions: [], memorySaves };
}

function analyzeUsage(usage, allTimeOps) {
  const suggestions = [];
  if (!usage) return { suggestions: [], memorySaves: [] };

  const memorySaves = [];
  const now = new Date();
  const todayStr = TODAY;

  // Suggest skills that haven't been used in 30 days
  for (const [skillId, info] of Object.entries(usage.skills || {})) {
    if (info.last_used) {
      const lastUsed = new Date(info.last_used + 'T00:00:00');
      const daysSince = Math.round((now - lastUsed) / (1000 * 60 * 60 * 24));
      if (daysSince >= 30) {
        suggestions.push(`Skill "${skillId}" (${info.name}) hasn't been used in ${daysSince} days`);
      }
    }
  }

  // Suggest auto_load promotion for frequently used skills not yet auto-loaded
  const autoLoadList = usage.auto_load_list || [];
  for (const [skillId, info] of Object.entries(usage.skills || {})) {
    if (!autoLoadList.includes(skillId) && (info.usage_count || 0) >= 3) {
      suggestions.push(`Consider adding "${skillId}" to auto_load (used ${info.usage_count} times)`);
      memorySaves.push({
        type: 'auto_load_candidate',
        description: `Skill "${skillId}" used ${info.usage_count} times, candidate for auto_load`,
        source: 'usage.json'
      });
    }
  }

  // Compare usage with all-time operations for unused capabilities
  if (allTimeOps && allTimeOps.length > 0) {
    const knownOps = new Set(allTimeOps.map(r => r.operation));
    // Suggest enabling operations never performed
    const catalog = readJSON(CATALOG_PATH);
    if (catalog && catalog.commands) {
      for (const [cmdName, cmdInfo] of Object.entries(catalog.commands)) {
        const action = cmdInfo.action;
        if (action && !knownOps.has(action) && !knownOps.has(cmdName)) {
          suggestions.push(`Command "${cmdName}" (${action}) has never been executed`);
        }
      }
    }
  }

  return { suggestions, memorySaves };
}

function analyzeEvolutionFiles(evolutionFiles) {
  const insights = [];
  for (const ef of evolutionFiles) {
    if (ef.file === 'explorer_cache.json') {
      const data = ef.data;
      if (data && Array.isArray(data.findings)) {
        for (const f of data.findings) {
          if (f.score >= 8) {
            insights.push(`Explorer found: ${f.title} (score: ${f.score}) — ${f.description || ''}`);
          }
        }
      }
    }
  }
  return insights;
}

// ─── Summary generation ───────────────────────────────────────────────────────

function generateSummary(ops, legacyOps, dailyStats, catalog, usage, evolutionFiles, allTimeOps) {
  const analysis = analyzeOperations(ops);
  const catalogAnalysis = analyzeCatalog(catalog, null);
  const usageAnalysis = analyzeUsage(usage, allTimeOps);
  const explorerInsights = analyzeEvolutionFiles(evolutionFiles);

  const summary = {
    date: TODAY,
    new_capabilities: analysis.newCapabilities,
    errors_fixed: analysis.errorsFixed,
    config_changes: analysis.configChanges,
    patterns_learned: analysis.patternsLearned,
    suggestions: [
      ...catalogAnalysis.suggestions,
      ...usageAnalysis.suggestions,
      ...explorerInsights.filter(i => i.includes('score')).map(
        i => `Explorer recommendation: ${i}`
      )
    ],
    memory_saves: [
      ...analysis.memorySaves,
      ...catalogAnalysis.memorySaves,
      ...usageAnalysis.memorySaves
    ],
    metrics: {
      total_operations: ops.length,
      legacy_operations: legacyOps.length,
      successful_ops: ops.filter(e => e.status === 'OK' || e.status === 'paused').length,
      failed_ops: ops.filter(e => e.error_message && e.error_message.length > 0).length,
      unique_operations: [...new Set(ops.map(e => e.operation))],
      stores_involved: [...new Set(ops.map(e => e.store_id).filter(Boolean))]
    },
    catalog: catalog ? {
      tkads_version: catalog.tkads_version,
      schema_version: catalog.schema_version,
      plugin_count: Object.keys(catalog.plugins || {}).length,
      command_count: Object.keys(catalog.commands || {}).length,
      script_count: Object.keys(catalog.scripts || {}).length
    } : null,
    usage: usage ? {
      skills_count: Object.keys(usage.skills || {}).length,
      auto_load_count: (usage.auto_load_list || []).length,
      last_updated: usage.updated_at
    } : null,
    daily_stats: dailyStats.length > 0 ? dailyStats : null,
    generated_at: new Date().toISOString()
  };

  return summary;
}

// ─── Memory save file ─────────────────────────────────────────────────────────

function writeMemoryFile(summary) {
  const memoryPath = path.join(REVIEWS_DIR, `memory-${TODAY}.json`);
  const memoryData = {
    date: TODAY,
    facts: summary.memory_saves.length > 0 ? summary.memory_saves : [
      { type: 'no_memory_saves', description: 'No memory-worthy facts identified for this date', source: 'reviewer.js' }
    ],
    suggestions: summary.suggestions,
    patterns_learned: summary.patterns_learned.slice(0, 10),
    generated_at: new Date().toISOString()
  };
  writeJSON(memoryPath, memoryData);
  log(`Memory facts written to ${memoryPath}`);
  return memoryPath;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  log(`=== Hermes Evolution Reviewer — ${TODAY} ===`);

  // 1. Ensure reviews dir exists
  if (!fs.existsSync(REVIEWS_DIR)) {
    fs.mkdirSync(REVIEWS_DIR, { recursive: true });
  }

  // 2. Collect data from all sources
  const ops = collectOperationLog();
  const legacyOps = collectOperationLogLegacy();
  const dailyStats = collectDailyStats();
  const catalog = readCatalog();
  const allTimeOps = collectAllTimeStats();
  const usage = readUsage();
  const evolutionFiles = checkEvolutionFiles();

  // 3. Check for catalog from previous review for diff
  const prevReviewPath = path.join(REVIEWS_DIR, `${TODAY}.json`);
  const prevReview = readJSON(prevReviewPath);

  // 4. Generate summary
  const summary = generateSummary(ops, legacyOps, dailyStats, catalog, usage, evolutionFiles, allTimeOps);

  // 5. Save archive copy
  const archivePath = path.join(REVIEWS_DIR, `${TODAY}.json`);
  writeJSON(archivePath, summary);
  log(`Review saved to ${archivePath}`);

  // 6. Write to custom output if specified
  if (args.output) {
    const outPath = path.resolve(args.output);
    writeJSON(outPath, summary);
    log(`Review also written to ${outPath}`);
  }

  // 7. Auto-save memory facts
  if (args.autoSave) {
    writeMemoryFile(summary);
  }

  // 8. Output summary to stdout (the primary output channel)
  console.log(JSON.stringify(summary, null, 2));
}

main();
