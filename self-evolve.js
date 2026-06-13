#!/usr/bin/env node
/**
 * self-evolve.js — Self-evolution orchestrator for tkads automation system.
 *
 * Runs the full evolution cycle:
 *   Phase 1 — CHECK:  Run catalog-check.js, parse its output
 *   Phase 2 — FIX:    Try auto-fix strategies for each issue found
 *   Phase 3 — LOG:    Record results in operation_log_v2 via Python subprocess
 *   Phase 4 — ALERT:  Send alert for unfixable issues via webhook
 *
 * Uses ONLY Node.js built-in modules (fs, path, child_process, http, https, url).
 * No npm dependencies.
 *
 * Usage:
 *   node self-evolve.js                     # Run full cycle
 *   node self-evolve.js --check-only        # Only run checks, don't fix
 *   node self-evolve.js --fix-only          # Skip checks, just try fixes
 *   node self-evolve.js --verbose           # Verbose output
 *   node self-evolve.js --dry-run           # Show what would be done
 *   node self-evolve.js --status            # Just print status summary
 *
 * ╔══ 自进化循环报告 ══╗
 * 📋 检查: 60项 → 55通过 3警告 2失败
 * 🔧 修复: 2/2 ✓
 * ⚠️ 无法修复: 0
 * 📝 已记录至 operation_log_v2
 * ━━━━━━━━━━━━━━━━━━━━━━━━
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const os = require('os');
const http = require('http');
const https = require('https');
const { URL } = require('url');

// ─── Resolve paths ─────────────────────────────────────────────────────────
const HOME = os.homedir();
const TKADS_DIR = path.join(HOME, '.tkads');
const CATALOG_PATH = path.join(TKADS_DIR, 'tkads-catalog.json');
const CATALOG_CHECK_PATH = path.join(TKADS_DIR, 'catalog-check.js');
const STORES_JSON_PATH = path.join(TKADS_DIR, 'stores.json');
const GATE_ENGINE_PATH = path.join(TKADS_DIR, 'gate-engine.js');
const ANALYTICS_DB = path.join(TKADS_DIR, 'data', 'analytics.db');
const ALERT_WEBHOOK_PATH = path.join(HOME, '.hermes', 'scripts', '.alert_webhook');
const HERMES_SCRIPTS_DIR = path.join(HOME, '.hermes', 'scripts');

// ─── Color helpers (same scheme as catalog-check.js) ──────────────────────
const C = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
  gray: '\x1b[90m',
};

function ok(msg)   { return `${C.green}✓${C.reset} ${msg}`; }
function fail(msg) { return `${C.red}✗${C.reset} ${msg}`; }
function warn(msg) { return `${C.yellow}⚠${C.reset} ${msg}`; }
function info(msg) { return `${C.cyan}→${C.reset} ${msg}`; }
function dim(msg)  { return `${C.gray}${msg}${C.reset}`; }

// ─── Runtime flags ──────────────────────────────────────────────────────────
const ARGS = new Set(process.argv.slice(2));
const FLAGS = {
  checkOnly:  ARGS.has('--check-only'),
  fixOnly:    ARGS.has('--fix-only'),
  verbose:    ARGS.has('--verbose') || ARGS.has('-v'),
  dryRun:     ARGS.has('--dry-run'),
  statusOnly: ARGS.has('--status'),
};

// ─── Helper: resolve home paths ────────────────────────────────────────────
function resolveHome(p) {
  if (!p || typeof p !== 'string') return p;
  if (p.startsWith('~/') || p === '~') {
    return path.join(HOME, p.slice(1));
  }
  return p;
}

// ─── Helper: convert JS value list to Python-safe repr string ────────────
// Handles null → None, string/number/boolean properly for embedding in Python
function _toPythonParams(params) {
  const items = params.map(p => {
    if (p === null || p === undefined) return 'None';
    if (typeof p === 'string') return JSON.stringify(p);
    if (typeof p === 'number') return String(p);
    if (typeof p === 'boolean') return p ? 'True' : 'False';
    return 'None';
  });
  return '[' + items.join(', ') + ']';
}

// ─── Helper: run a Python SQLite script (pattern from gate-engine.js) ─────
function _querySqlite(dbPath, sql, params = []) {
  // Handle ~ in dbPath
  if (dbPath.startsWith('~')) {
    dbPath = path.join(HOME, dbPath.slice(1));
  }

  const pyParams = _toPythonParams(params);
  const script = `
import sqlite3, json, sys
db = ${JSON.stringify(dbPath)}
sql = ${JSON.stringify(sql)}
params = ${pyParams}
try:
    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute(sql, params)
    columns = [d[0] for d in cur.description] if cur.description else []
    rows = [list(r) for r in cur.fetchall()]
    conn.commit()
    conn.close()
    print(json.dumps({"columns": columns, "rows": rows}))
except Exception as e:
    print(json.dumps({"error": str(e), "columns": [], "rows": []}))
`;

  // Try python first (Windows), fall back to python3
  for (const cmd of ['python', 'python3']) {
    const result = spawnSync(cmd, ['-c', script], {
      encoding: 'utf-8',
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
    if (result.error) continue;
    if (result.stderr && result.stderr.trim()) {
      // stderr has content but Python may still have printed JSON to stdout
    }
    try {
      const parsed = JSON.parse(result.stdout);
      return parsed;
    } catch (e) {
      // stdout could not be parsed, try next interpreter
      continue;
    }
  }

  // Both interpreters failed — try to get stderr info
  for (const cmd of ['python', 'python3']) {
    const result = spawnSync(cmd, ['-c', script], {
      encoding: 'utf-8',
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
    if (result.stderr) {
      return { rows: [], columns: [], error: `Python ${cmd} stderr: ${result.stderr.trim().split('\n').pop()}` };
    }
  }

  return { rows: [], columns: [], error: 'No Python interpreter found or all failed' };
}

// ─── Helper: execute SQL without returning rows (INSERT/UPDATE/DELETE) ────
function _execSqlite(dbPath, sql, params = []) {
  if (dbPath.startsWith('~')) {
    dbPath = path.join(HOME, dbPath.slice(1));
  }

  const pyParams = _toPythonParams(params);
  const script = `
import sqlite3, json, sys
db = ${JSON.stringify(dbPath)}
sql = ${JSON.stringify(sql)}
params = ${pyParams}
try:
    conn = sqlite3.connect(db)
    cur = conn.cursor()
    cur.execute(sql, params)
    conn.commit()
    affected = cur.rowcount
    conn.close()
    print(json.dumps({"affected": affected}))
except Exception as e:
    print(json.dumps({"error": str(e)}))
`;

  for (const cmd of ['python', 'python3']) {
    const result = spawnSync(cmd, ['-c', script], {
      encoding: 'utf-8',
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
    if (result.error) continue;
    try {
      return JSON.parse(result.stdout);
    } catch (e) {
      continue;
    }
  }

  // Try to get error info from last attempt
  for (const cmd of ['python', 'python3']) {
    const result = spawnSync(cmd, ['-c', script], {
      encoding: 'utf-8',
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
    if (result.stderr) {
      return { error: `Python ${cmd} error: ${result.stderr.trim().split('\n').pop()}` };
    }
  }

  return { error: 'No Python interpreter found or all failed' };
}

// ─── Helper: make HTTP/S request ──────────────────────────────────────────
function _httpRequest(urlStr, data, method = 'POST') {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch (e) {
      return reject(new Error(`Invalid URL: ${e.message}`));
    }

    const body = typeof data === 'string' ? data : JSON.stringify(data);
    const mod = url.protocol === 'https:' ? https : http;

    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 10000,
    };

    const req = mod.request(options, (res) => {
      let chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const respBody = Buffer.concat(chunks).toString();
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: respBody,
        });
      });
    });

    req.on('error', (e) => reject(e));
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.write(body);
    req.end();
  });
}

// ─── Helper: load JSON file ───────────────────────────────────────────────
function _loadJSON(filePath) {
  try {
    const raw = fs.readFileSync(resolveHome(filePath), 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

// ─── Helper: save JSON file ───────────────────────────────────────────────
function _saveJSON(filePath, data) {
  const resolved = resolveHome(filePath);
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(resolved, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return true;
}

// ─── Helper: find files recursively ───────────────────────────────────────
function _findFiles(dir, pattern) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(..._findFiles(fullPath, pattern));
      } else if (!pattern || pattern.test(entry.name)) {
        results.push(fullPath);
      }
    }
  } catch (e) {
    // Permission error, skip
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════════════════
//  SelfEvolve Class
// ═══════════════════════════════════════════════════════════════════════════

class SelfEvolve {
  constructor(config) {
    this.config = config || {};
    this.results = {
      check: {
        checked: 0,
        passed: 0,
        failed: 0,
        warnings: 0,
        issues: [],      // { type, file, detail, raw }
      },
      fix: {
        attempted: 0,
        succeeded: 0,
        fixed: [],       // { issue, action, detail }
        unfixable: [],   // { issue, reason }
      },
      log: {
        logged: false,
        entries: 0,
      },
      alert: {
        sent: false,
        webhook: null,
        statusCode: null,
      },
      startedAt: new Date().toISOString(),
      completedAt: null,
    };
  }

  // ─── Full cycle: check → fix → log → alert ──────────────────────────
  async evolve() {
    console.log('');
    console.log(`${C.bold}╔════════════════════════════════════════════════════════╗${C.reset}`);
    console.log(`${C.bold}║   自进化循环 Self-Evolution Cycle                    ║${C.reset}`);
    console.log(`${C.bold}╚════════════════════════════════════════════════════════╝${C.reset}`);
    console.log('');

    // Phase 1: Check
    if (!FLAGS.fixOnly) {
      console.log(`${C.bold}┍━ Phase 1: 检查 (CHECK) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┑${C.reset}`);
      await this.runChecks();
      console.log('');
    }

    // Phase 2: Fix
    if (!FLAGS.checkOnly && this.results.check.issues.length > 0) {
      console.log(`${C.bold}┍━ Phase 2: 修复 (FIX) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┑${C.reset}`);
      await this.tryAutoFix(this.results.check.issues);
      console.log('');
    } else if (!FLAGS.checkOnly && this.results.check.issues.length === 0 && !FLAGS.fixOnly) {
      console.log(`  ${info('No issues found, skipping fix phase.')}`);
      console.log('');
    }

    // Phase 3: Log
    if (!FLAGS.dryRun) {
      console.log(`${C.bold}┍━ Phase 3: 记录 (LOG) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┑${C.reset}`);
      await this.logResults();
      console.log('');
    }

    // Phase 4: Alert
    if (!FLAGS.dryRun && this.results.fix.unfixable.length > 0) {
      console.log(`${C.bold}┍━ Phase 4: 告警 (ALERT) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┑${C.reset}`);
      await this.alertUnfixable(this.results.fix.unfixable);
      console.log('');
    }

    this.results.completedAt = new Date().toISOString();
    this._printSummary();

    if (this.results.check.failed > 0 && !FLAGS.dryRun) {
      process.exitCode = 1;
    }

    return this.results;
  }

  // ─── Phase 1: Run catalog check ────────────────────────────────────────
  async runChecks() {
    if (!fs.existsSync(CATALOG_CHECK_PATH)) {
      console.log(`  ${fail(`catalog-check.js not found at ${CATALOG_CHECK_PATH}`)}`);
      this.results.check.issues.push({
        type: 'system_error',
        detail: `catalog-check.js not found at ${CATALOG_CHECK_PATH}`,
      });
      return;
    }

    return new Promise((resolve) => {
      const child = spawn(process.execPath, [
        path.basename(CATALOG_CHECK_PATH),
        '--verbose',
      ], {
        cwd: TKADS_DIR,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        const output = stdout + stderr;

        // Parse stats from the summary line
        // "总计检查:  60" / "通过:     55" / "警告:     3" / "失败:     2"
        const totalMatch = output.match(/总计检查:\s*(\d+)/);
        const passedMatch = output.match(/通过:\s*(\d+)/);
        const warnMatch = output.match(/警告:\s*(\d+)/);
        const failMatch = output.match(/失败:\s*(\d+)/);

        this.results.check.checked = totalMatch ? parseInt(totalMatch[1], 10) : 0;
        this.results.check.passed = passedMatch ? parseInt(passedMatch[1], 10) : 0;
        this.results.check.warnings = warnMatch ? parseInt(warnMatch[1], 10) : 0;
        this.results.check.failed = failMatch ? parseInt(failMatch[1], 10) : 0;

        console.log(`  ${ok(`Check complete: ${this.results.check.checked} items`)}`);

        // Extract specific failed/warning issues from verbose output
        // Look for lines starting with '  ✗' or '  ⚠' and get context
        const lines = output.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];

          // Match failure lines: "  ✗ ..."
          if (line.match(/^\x1b\[31m✗\x1b\[0m/) || line.match(/^  ✗ /) || line.includes('✗')) {
            // Strip ANSI codes
            const clean = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
            const detail = (i + 1 < lines.length)
              ? lines[i + 1].replace(/\x1b\[[0-9;]*m/g, '').trim()
              : '';

            // Determine issue type
            let issueType = 'unknown';
            if (clean.includes('script_real') || (clean.includes('→') && clean.includes('.py') || clean.includes('.bat'))) {
              issueType = 'script_real';
            } else if (clean.includes('version') || clean.includes('v')) {
              issueType = 'version_mismatch';
            } else if (clean.includes('handler') || clean.includes('COMMAND_REGISTRY')) {
              issueType = 'command_missing';
            } else if (clean.includes('plugin') || clean.includes('hook')) {
              issueType = 'plugin_issue';
            } else if (clean.includes('database') || clean.includes('db') || clean.includes('.db')) {
              issueType = 'database_missing';
            } else {
              issueType = 'path_missing';
            }

            this.results.check.issues.push({
              type: issueType,
              line: clean,
              detail: detail,
              raw: clean,
            });
          }

          // Match warning lines
          if (line.match(/^\x1b\[33m⚠\x1b\[0m/) || line.match(/^  ⚠ /) || line.includes('⚠')) {
            const clean = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
            this.results.check.issues.push({
              type: 'warning',
              line: clean,
              detail: (i + 1 < lines.length)
                ? lines[i + 1].replace(/\x1b\[[0-9;]*m/g, '').trim()
                : '',
              raw: clean,
            });
          }
        }

        // Log any stderr
        if (stderr) {
          console.log(`  ${warn('Check stderr:')} ${stderr.trim()}`);
        }

        if (FLAGS.verbose) {
          console.log(`  ${info(`Parsed ${this.results.check.issues.length} issues from check output`)}`);
        }

        resolve();
      });
    });
  }

  // ─── Phase 2: Try auto-fix strategies ──────────────────────────────────
  async tryAutoFix(issues) {
    if (!issues || issues.length === 0) {
      console.log(`  ${info('No issues to fix.')}`);
      return { fixed: [], unfixable: [] };
    }

    console.log(`  ${info(`Attempting to fix ${issues.length} issue(s)...`)}`);

    // Try each auto-fix strategy based on issue type

    // Strategy 1: Fix missing script paths
    for (const issue of issues) {
      if (issue.type === 'script_real' || issue.type === 'path_missing') {
        this.results.fix.attempted++;
        if (FLAGS.dryRun) {
          console.log(`  ${dim(`[DRY-RUN] Would try fixCatalogPath for: ${issue.raw}`)}`);
          continue;
        }
        const result = this.fixCatalogPath(issue);
        if (result.fixed) {
          this.results.fix.succeeded++;
          this.results.fix.fixed.push({ issue, action: result.action, detail: result.detail || '' });
          console.log(`  ${ok(`${result.action}: ${issue.raw}`)}`);
        } else {
          this.results.fix.unfixable.push({ issue, reason: result.reason || 'Could not locate file' });
          console.log(`  ${warn(`Cannot fix: ${issue.raw}`)}`);
          if (result.detail) console.log(`           ${dim(result.detail)}`);
        }
      }
    }

    // Strategy 2: Sync constitution → gates
    // (always run, not per-issue — checks if constitution.rules match gate gates)
    if (!FLAGS.dryRun) {
      const syncResult = this.syncConstitution();
      if (syncResult.fixed) {
        this.results.fix.attempted++;
        this.results.fix.succeeded++;
        this.results.fix.fixed.push({ issue: { type: 'constitution_sync' }, action: syncResult.action, detail: '' });
        console.log(`  ${ok(syncResult.action)}`);
      } else if (syncResult.action) {
        // Not an error, just informational
        if (FLAGS.verbose) console.log(`  ${info(syncResult.action)}`);
      }
    }

    // Strategy 3: Purge stale logs
    if (!FLAGS.dryRun) {
      const purgeResult = this.purgeStaleLogs();
      if (purgeResult.fixed || purgeResult.action) {
        console.log(`  ${ok(purgeResult.action)}`);
      }
    }

    // Strategy 4: Update catalog versions
    if (!FLAGS.dryRun) {
      const verResult = this.updateCatalogVersion();
      if (verResult.fixed) {
        this.results.fix.attempted++;
        this.results.fix.succeeded++;
        this.results.fix.fixed.push({ issue: { type: 'version_update' }, action: verResult.action, detail: '' });
        console.log(`  ${ok(verResult.action)}`);
      } else if (verResult.action) {
        console.log(`  ${info(verResult.action)}`);
      }
    }

    console.log(`  ${ok(`Fixed ${this.results.fix.succeeded}/${this.results.fix.attempted}`)}`);

    return {
      fixed: this.results.fix.fixed,
      unfixable: this.results.fix.unfixable,
    };
  }

  // ─── Fix Strategy: Fix missing script/real paths ───────────────────────
  fixCatalogPath(issue) {
    // Extract filename from the issue line
    const issueText = issue.raw || issue.line || '';

    // Try to extract the filename or key
    let fileName = '';
    // Format: "daily-creator-report: script_real → C:/path/to/file.py"
    const scriptRealMatch = issueText.match(/(\S+):\s*script_real\s*→\s*(\S+)/);
    const pathMatch = issueText.match(/(\S+):\s*(~?\S+)/);

    if (scriptRealMatch) {
      fileName = scriptRealMatch[2];
    } else if (pathMatch) {
      // The key is the script name, the path is what follows
      fileName = pathMatch[2];
    } else {
      // Try to extract just the filename from detail
      const detailFile = (issue.detail || '').match(/[^\\\/]+\.(py|js|bat)$/);
      if (detailFile) {
        fileName = detailFile[0];
      } else {
        return { fixed: false, reason: 'Could not extract filename from issue' };
      }
    }

    const baseName = path.basename(fileName).replace(/^['"]|['"]$/g, '');
    if (!baseName) {
      return { fixed: false, reason: 'No filename to search for' };
    }

    // Get the script key from the issue line
    let scriptKey = '';
    const keyMatch = issueText.match(/^\[?(\S+?)\]?:/);
    if (keyMatch) {
      scriptKey = keyMatch[1];
    }

    if (FLAGS.verbose) {
      console.log(`  ${dim(`  Searching for "${baseName}" (key: ${scriptKey})...`)}`);
    }

    // Search in priority locations
    const searchDirs = [
      TKADS_DIR,
      HERMES_SCRIPTS_DIR,
      path.join(HOME, '.hermes'),
      path.join(HOME, 'AppData', 'Roaming', 'cn.org.hermesagent.desktop', 'runtime', 'hermes-home', 'scripts'),
    ];

    let foundPath = null;

    for (const dir of searchDirs) {
      if (!fs.existsSync(dir)) continue;
      // Direct match
      const directPath = path.join(dir, baseName);
      if (fs.existsSync(directPath)) {
        foundPath = directPath;
        break;
      }
      // Recursive search
      const matches = _findFiles(dir, new RegExp(`^${baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
      if (matches.length > 0) {
        foundPath = matches[0];
        break;
      }
    }

    if (!foundPath) {
      return { fixed: false, reason: `File "${baseName}" not found in any search directory` };
    }

    // Fix: Update catalog.json with the correct path
    let catalog = _loadJSON(CATALOG_PATH);
    if (!catalog) {
      return { fixed: false, reason: 'Could not load catalog.json for update' };
    }

    // Find the script entry that has this path
    const scripts = catalog.scripts || {};
    for (const [key, script] of Object.entries(scripts)) {
      const currentPath = resolveHome(script.path);
      const currentReal = script.script_real ? resolveHome(script.script_real) : null;

      if (currentPath.includes(baseName) && !fs.existsSync(currentPath)) {
        // Update the path
        const relativePath = '~/' + path.relative(HOME, foundPath).replace(/\\/g, '/');
        script.path = relativePath;
        catalog.updated_at = new Date().toISOString();
        _saveJSON(CATALOG_PATH, catalog);
        return {
          fixed: true,
          action: `Updated catalog path for "${key}"`,
          detail: `${currentPath} → ${relativePath}`,
        };
      }

      if (currentReal && currentReal.includes(baseName) && !fs.existsSync(currentReal)) {
        // Update script_real
        const relativePath = '~/' + path.relative(HOME, foundPath).replace(/\\/g, '/');
        script.script_real = relativePath;
        catalog.updated_at = new Date().toISOString();
        _saveJSON(CATALOG_PATH, catalog);
        return {
          fixed: true,
          action: `Updated catalog script_real for "${key}"`,
          detail: `${currentReal} → ${relativePath}`,
        };
      }
    }

    // If we got here, we found the file but couldn't match it to a catalog entry
    return { fixed: false, reason: `Found "${baseName}" but couldn't match to catalog entry` };
  }

  // ─── Fix Strategy: Sync constitution rules with gate-engine ─────────────
  syncConstitution() {
    const stores = _loadJSON(STORES_JSON_PATH);
    if (!stores) {
      return { fixed: false, action: 'stores.json not found' };
    }

    const constitutionRules = stores.constitution && stores.constitution.rules;
    if (!constitutionRules || !Array.isArray(constitutionRules)) {
      return { fixed: false, action: 'No constitution rules in stores.json' };
    }

    const enabledGates = stores.gates && stores.gates.enabled_by_default;
    if (!enabledGates || !Array.isArray(enabledGates)) {
      return { fixed: false, action: 'No gates.enabled_by_default in stores.json' };
    }

    // Check if constitution rules are properly represented as gates
    // Each constitution rule should ideally map to a gate
    const ruleCount = constitutionRules.length;
    const gateCount = enabledGates.length;

    if (FLAGS.verbose) {
      console.log(`  ${dim(`  Constitution: ${ruleCount} rules, Gates: ${gateCount} enabled`)}`);
    }

    // Gate names that correspond to constitution rules
    const requiredGates = ['naming_rule', 'not_legacy', 'spu_available', 'ad_type_modifiable', 'ad_exists', 'constitution_check'];

    const missingGates = requiredGates.filter(g => !enabledGates.includes(g));

    if (missingGates.length === 0) {
      return { fixed: false, action: `All ${gateCount} gates already synced with constitution` };
    }

    if (FLAGS.dryRun) {
      return { fixed: false, action: `[DRY-RUN] Would inject ${missingGates.length} missing gates: ${missingGates.join(', ')}` };
    }

    // Inject missing gates into stores.json
    stores.gates.enabled_by_default = [...enabledGates, ...missingGates];
    _saveJSON(STORES_JSON_PATH, stores);

    return {
      fixed: true,
      action: `Synced ${missingGates.length} constitution rules into gates: ${missingGates.join(', ')}`,
    };
  }

  // ─── Fix Strategy: Purge stale logs (entries > 90 days) ────────────────
  purgeStaleLogs() {
    if (!fs.existsSync(resolveHome(ANALYTICS_DB))) {
      return { fixed: false, action: 'Analytics DB not found' };
    }

    // Delete entries older than 90 days, keeping ERROR and BLOCKED status
    const sql = `
      DELETE FROM operation_log_v2
      WHERE created_at < datetime('now', '-90 days')
        AND status NOT IN ('ERROR', 'BLOCKED')
    `;

    const result = _execSqlite(ANALYTICS_DB, sql);

    if (result.error) {
      return { fixed: false, action: `Purge failed: ${result.error}` };
    }

    const affected = result.affected || 0;
    if (affected > 0) {
      return { fixed: true, action: `Purged ${affected} stale log entries from operation_log_v2` };
    }

    return { fixed: false, action: 'No stale log entries to purge' };
  }

  // ─── Fix Strategy: Update catalog versions to match actual files ────────
  updateCatalogVersion() {
    const catalog = _loadJSON(CATALOG_PATH);
    if (!catalog || !catalog.versions) {
      return { fixed: false, action: 'No versions section in catalog' };
    }

    const versions = catalog.versions;
    let updates = 0;

    for (const [key, catalogVer] of Object.entries(versions)) {
      // Try to find the actual file and check its version
      // Look for the file in ~/.tkads/
      const possibleFiles = [
        path.join(TKADS_DIR, key),
        path.join(TKADS_DIR, `${key}.js`),
        path.join(TKADS_DIR, `${key}.py`),
      ];

      let actualFile = null;
      for (const f of possibleFiles) {
        if (fs.existsSync(f)) {
          actualFile = f;
          break;
        }
      }

      if (!actualFile) continue;

      // Try to extract version from the file contents
      try {
        const content = fs.readFileSync(actualFile, 'utf8');
        // Look for patterns like: version = "1.0.0" or @version 1.0.0
        const verMatch = content.match(/version["']?\s*[:=]\s*["']([^"']+)["']/);
        const docstringMatch = content.match(/@version\s+(\S+)/);

        if (verMatch || docstringMatch) {
          const fileVer = (verMatch ? verMatch[1] : docstringMatch[1]).replace(/^v/, '');

          if (fileVer !== catalogVer) {
            if (FLAGS.verbose) {
              console.log(`  ${dim(`  ${key}: catalog v${catalogVer} → file v${fileVer}`)}`);
            }
            versions[key] = fileVer;
            updates++;
          }
        }
      } catch (e) {
        // Skip files that can't be read
      }
    }

    if (updates > 0) {
      catalog.updated_at = new Date().toISOString();
      _saveJSON(CATALOG_PATH, catalog);
      return { fixed: true, action: `Updated ${updates} catalog version(s) to match actual files` };
    }

    return { fixed: false, action: 'All catalog versions match actual files' };
  }

  // ─── Phase 3: Log results to operation_log_v2 ──────────────────────────
  async logResults() {
    if (!fs.existsSync(resolveHome(ANALYTICS_DB))) {
      console.log(`  ${warn('Analytics DB not found, cannot log')}`);
      return;
    }

    const now = new Date().toISOString();
    const issueCount = this.results.check.issues.length;
    const fixedCount = this.results.fix.fixed.length;
    const unfixableCount = this.results.fix.unfixable.length;

    // Insert evolution record
    const insertSQL = `
      INSERT INTO operation_log_v2
        (operation, namespace, store_id, campaign_id,
         expected_result, actual_result, status,
         error_message, tkads_version)
      VALUES (?, ?, ?, ?,
              ?, ?, ?,
              ?, ?)
    `;

    const status = (this.results.check.failed === 0 && unfixableCount === 0) ? 'OK'
                 : (unfixableCount > 0) ? 'BLOCKED'
                 : 'ERROR';

    const expectedResult = `Self-evolution cycle: check ${this.results.check.checked} items`;
    const actualResult = `Check: ${this.results.check.passed} passed, ${this.results.check.failed} failed, ${this.results.check.warnings} warnings. Fixed: ${fixedCount}/${issueCount}. Unfixable: ${unfixableCount}.`;

    const result = _execSqlite(ANALYTICS_DB, insertSQL, [
      'self_evolve',
      'tkads.monitor',
      'hanmac',
      null,
      expectedResult,
      actualResult,
      status,
      unfixableCount > 0 ? `Unfixable issues: ${unfixableCount}` : null,
      '4.0.0',
    ]);

    if (result.error) {
      console.log(`  ${fail(`Failed to log to operation_log_v2: ${result.error}`)}`);
      this.results.log.logged = false;
      return;
    }

    this.results.log.logged = true;
    this.results.log.entries = 1;
    console.log(`  ${ok('Evolution result recorded in operation_log_v2')}`);
  }

  // ─── Phase 4: Alert for unfixable issues ───────────────────────────────
  async alertUnfixable(unfixable) {
    if (!unfixable || unfixable.length === 0) {
      console.log(`  ${info('No unfixable issues to alert about.')}`);
      return;
    }

    // Read webhook URL
    let webhookUrl = null;
    const webhookPath = resolveHome(ALERT_WEBHOOK_PATH);
    if (fs.existsSync(webhookPath)) {
      webhookUrl = fs.readFileSync(webhookPath, 'utf8').trim();
    }

    if (!webhookUrl) {
      console.log(`  ${warn('No alert webhook configured (missing ~/.hermes/scripts/.alert_webhook)')}`);
      this.results.alert.webhook = null;
      return;
    }

    this.results.alert.webhook = webhookUrl;

    const payload = {
      event: 'self_evolve_unfixable',
      timestamp: new Date().toISOString(),
      system: 'tkads',
      summary: `${unfixable.length} unfixable issue(s) detected during self-evolution`,
      check_stats: {
        checked: this.results.check.checked,
        passed: this.results.check.passed,
        failed: this.results.check.failed,
        warnings: this.results.check.warnings,
      },
      unfixable_issues: unfixable.map(u => ({
        issue: u.issue ? (u.issue.raw || u.issue.line || u.issue.type) : 'unknown',
        reason: u.reason || 'Unknown',
      })),
      fixed: this.results.fix.fixed.map(f => ({
        action: f.action,
        detail: f.detail,
      })),
    };

    try {
      const response = await _httpRequest(webhookUrl, payload);
      this.results.alert.sent = true;
      this.results.alert.statusCode = response.statusCode;

      if (response.statusCode >= 200 && response.statusCode < 300) {
        console.log(`  ${ok(`Alert sent (${response.statusCode}) — ${unfixable.length} unfixable issue(s)`)}`);
      } else {
        console.log(`  ${warn(`Alert sent but returned ${response.statusCode}`)}`);
      }
    } catch (err) {
      console.log(`  ${fail(`Failed to send alert: ${err.message}`)}`);
      this.results.alert.sent = false;
    }
  }

  // ─── Status summary ─────────────────────────────────────────────────────
  getStatus() {
    return {
      lastCycle: this.results.completedAt || this.results.startedAt,
      check: {
        total: this.results.check.checked,
        ok: this.results.check.failed === 0 && this.results.check.warnings === 0,
        passed: this.results.check.passed,
        failed: this.results.check.failed,
        warnings: this.results.check.warnings,
      },
      fix: {
        total: this.results.fix.attempted,
        fixed: this.results.fix.succeeded,
        unfixable: this.results.fix.unfixable.length,
      },
      logWritten: this.results.log.logged,
      alertSent: this.results.alert.sent,
    };
  }

  // ─── Print summary ──────────────────────────────────────────────────────
  _printSummary() {
    const totalIssues = this.results.check.issues.length;
    const fixedCount = this.results.fix.fixed.length;
    const unfixable = this.results.fix.unfixable.length;

    const allGreen = this.results.check.failed === 0 && unfixable === 0;

    console.log(`${C.bold}╔══ 自进化循环报告 ══╗${C.reset}`);
    console.log(`📋 检查: ${this.results.check.checked}项 → ${ok(this.results.check.passed + '通过')} ${this.results.check.warnings > 0 ? warn(this.results.check.warnings + '警告') : ''} ${this.results.check.failed > 0 ? fail(this.results.check.failed + '失败') : ''}`);
    console.log(`🔧 修复: ${fixedCount}/${totalIssues} ${fixedCount === totalIssues ? '✓' : (fixedCount > 0 ? '✓' : '')}${unfixable > 0 ? ` ${warn(unfixable + '未修复')}` : ''}`);
    if (unfixable > 0) {
      console.log(`⚠️  无法修复: ${unfixable}`);
    }
    console.log(`📝 ${this.results.log.logged ? ok('已记录至 operation_log_v2') : warn('未记录')}`);
    if (this.results.alert.sent) {
      console.log(`🔔 ${ok(`告警已发送 (${this.results.alert.statusCode})`)}`);
    } else if (unfixable > 0 && this.results.alert.webhook === null) {
      console.log(`🔔 ${warn('未配置告警Webhook')}`);
    }
    console.log(`${C.gray}━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Main entry point
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  const evolvo = new SelfEvolve();

  if (FLAGS.statusOnly) {
    const status = evolvo.getStatus();
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  try {
    await evolvo.evolve();
  } catch (err) {
    console.error(`\n${fail('Evolution cycle failed:')} ${err.message}`);
    if (FLAGS.verbose) {
      console.error(err.stack);
    }
    process.exitCode = 1;
  }
}

// Run as CLI
if (require.main === module) {
  main();
}

// Export for programmatic use
module.exports = SelfEvolve;
module.exports.evolve = async function(config) {
  const e = new SelfEvolve(config);
  return e.evolve();
};
