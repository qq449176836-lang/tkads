#!/usr/bin/env node
/**
 * catalog-check.js — tkads-catalog.json health checker
 *
 * Reads the versioned registry and validates:
 *   ✓ Script files exist (path + script_real)
 *   ✓ Commands are defined in tkads.js
 *   ✓ Database files exist
 *   ✓ Versioned engine files exist
 *
 * Usage: node catalog-check.js
 *        node catalog-check.js --verbose   (show all checks, not just failures)
 *
 * Uses only Node.js built-ins (fs, path).
 */

const fs = require('fs');
const path = require('path');

// ─── Resolve ~ to real home directory ───────────────────────────────────────
function resolveHome(p) {
  if (!p || typeof p !== 'string') return p;
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

const os = require('os');
const HOME = os.homedir();
const CATALOG_PATH = path.join(HOME, '.tkads', 'tkads-catalog.json');
const TKADS_JS_PATH = path.join(HOME, '.tkads', 'tkads.js');
const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');

// ─── Color helpers ───────────────────────────────────────────────────────────
const COLOR = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
  gray: '\x1b[90m',
};

function ok(msg)  { return `${COLOR.green}✓${COLOR.reset} ${msg}`; }
function fail(msg){ return `${COLOR.red}✗${COLOR.reset} ${msg}`; }
function warn(msg){ return `${COLOR.yellow}⚠${COLOR.reset} ${msg}`; }
function info(msg){ return `${COLOR.cyan}→${COLOR.reset} ${msg}`; }
function dim(msg) { return `${COLOR.gray}${msg}${COLOR.reset}`; }

// ─── Stats tracker ──────────────────────────────────────────────────────────
const stats = { checked: 0, passed: 0, failed: 0, warnings: 0 };

function check(condition, label, detail) {
  stats.checked++;
  if (condition) {
    stats.passed++;
    if (verbose) console.log(`  ${ok(label)}`);
    return true;
  }
  stats.failed++;
  console.log(`  ${fail(label)}`);
  if (detail) console.log(`           ${dim(detail)}`);
  return false;
}

function softCheck(condition, label, detail) {
  stats.checked++;
  if (condition) {
    stats.passed++;
    return true;
  }
  stats.warnings++;
  console.log(`  ${warn(label)}`);
  if (detail) console.log(`           ${dim(detail)}`);
  return false;
}

// ─── Main ───────────────────────────────────────────────────────────────────
function main() {
  console.log('');
  console.log(`${COLOR.bold}╔══════════════════════════════════════════════════╗${COLOR.reset}`);
  console.log(`${COLOR.bold}║   tkads-catalog.json 完整性检查                  ║${COLOR.reset}`);
  console.log(`${COLOR.bold}╚══════════════════════════════════════════════════╝${COLOR.reset}`);
  console.log('');

  // 1. Read catalog
  if (!fs.existsSync(CATALOG_PATH)) {
    console.log(`  ${fail('Catalog file not found: ' + CATALOG_PATH)}`);
    console.log('');
    printSummary();
    process.exit(1);
  }

  let catalog;
  try {
    const raw = fs.readFileSync(CATALOG_PATH, 'utf8');
    catalog = JSON.parse(raw);
    console.log(`  ${ok(`Read catalog (schema v${catalog.schema_version}, tkads v${catalog.tkads_version})`)}`);
  } catch (err) {
    console.log(`  ${fail('Failed to parse catalog: ' + err.message)}`);
    console.log('');
    printSummary();
    process.exit(1);
  }

  // 2. Validate catalog structure
  console.log(`\n${COLOR.bold}── 目录结构 ──${COLOR.reset}`);
  check(!!catalog.schema_version,      'schema_version present');
  check(!!catalog.updated_at,          'updated_at present');
  check(!!catalog.tkads_version,       'tkads_version present');
  check(typeof catalog.plugins === 'object' && catalog.plugins !== null,  'plugins section exists');
  check(typeof catalog.commands === 'object' && catalog.commands !== null, 'commands section exists');
  check(typeof catalog.scripts === 'object' && catalog.scripts !== null,   'scripts section exists');
  check(typeof catalog.databases === 'object' && catalog.databases !== null, 'databases section exists');
  check(typeof catalog.versions === 'object' && catalog.versions !== null,   'versions section exists');

  // 3. Check scripts
  const scriptKeys = Object.keys(catalog.scripts || {});
  console.log(`\n${COLOR.bold}── 脚本检查 (${scriptKeys.length}) ──${COLOR.reset}`);
  for (const [key, script] of Object.entries(catalog.scripts || {})) {
    if (verbose) console.log(`\n  ${COLOR.cyan}[${key}]${COLOR.reset} ${script.name}`);

    // Check primary path
    const resolvedPath = resolveHome(script.path);
    check(
      fs.existsSync(resolvedPath),
      `${key}: ${script.path}`,
      resolvedPath
    );

    // Check script_real if present (used for .bat wrappers)
    if (script.script_real) {
      const resolvedReal = resolveHome(script.script_real);
      check(
        fs.existsSync(resolvedReal),
        `${key}: script_real → ${script.script_real}`,
        resolvedReal
      );
    }

    // Check requires_db entries
    if (script.requires_db && Array.isArray(script.requires_db)) {
      for (const dbName of script.requires_db) {
        // Look up the DB in catalog.databases
        const dbEntry = Object.entries(catalog.databases || {}).find(
          ([k, v]) => v && path.basename(v.path) === dbName
        );
        if (dbEntry) {
          const dbPath = resolveHome(dbEntry[1].path);
          softCheck(
            fs.existsSync(dbPath),
            `${key}: required_db "${dbName}" → ${dbEntry[1].path}`,
            dbPath
          );
        } else {
          softCheck(false, `${key}: required_db "${dbName}" — not found in databases section`);
        }
      }
    }

    // Check hooks reference
    if (script.hooks && Array.isArray(script.hooks)) {
      for (const h of script.hooks) {
        softCheck(
          true,
          `${key}: hook "${h}" registered (validation TBD at runtime)`,
          'Hook presence confirmed in catalog'
        );
      }
    }
  }

  // 4. Check commands against tkads.js
  const cmdKeys = Object.keys(catalog.commands || {});
  console.log(`\n${COLOR.bold}── 命令检查 (${cmdKeys.length}) ──${COLOR.reset}`);

  const tkadsJsExists = fs.existsSync(TKADS_JS_PATH);
  check(tkadsJsExists, 'Handler: tkads.js exists', TKADS_JS_PATH);

  // Parse COMMAND_REGISTRY from tkads.js to know which commands are actually implemented
  let registryCommands = [];
  if (tkadsJsExists) {
    try {
      const tkadsSrc = fs.readFileSync(TKADS_JS_PATH, 'utf8');
      // Extract the COMMAND_REGISTRY array using a simple regex
      const registryMatch = tkadsSrc.match(/const\s+COMMAND_REGISTRY\s*=\s*\[([\s\S]*?)\];/);
      if (registryMatch) {
        // Extract namespace and action from each entry
        const entryRegex = /\{\s*namespace:\s*'([^']+)'[^}]*?action:\s*'([^']+)'/g;
        let m;
        while ((m = entryRegex.exec(registryMatch[1])) !== null) {
          registryCommands.push({ namespace: m[1], action: m[2], full: `${m[1]}.${m[2]}` });
        }
      }
    } catch (err) {
      console.log(`  ${warn('Could not parse COMMAND_REGISTRY from tkads.js: ' + err.message)}`);
    }
  }

  for (const [cmdKey, cmd] of Object.entries(catalog.commands || {})) {
    if (verbose) console.log(`\n  ${COLOR.cyan}[${cmdKey}]${COLOR.reset} ${cmd.name}`);

    // Check that handler is tkads.js
    check(cmd.handler === 'tkads.js', `${cmdKey}: handler = "${cmd.handler}"`);

    // Check that the command is defined in tkads.js COMMAND_REGISTRY
    // The cmdKey is e.g. "tkads.ad.list", "tkads.ad.update-roi"
    // In the registry, it's namespace.action, e.g. tkads.ad.list → ns='tkads.ad', action='list'
    const lastDot = cmdKey.lastIndexOf('.');
    let ns, action;
    if (lastDot !== -1) {
      ns = cmdKey.slice(0, lastDot);
      action = cmdKey.slice(lastDot + 1);
    } else {
      ns = '';
      action = cmdKey;
    }

    // Normalize: the catalog may have action='update_roi' but registry has action='update'
    const registryAction = cmd.action.replace(/_/g, '-'); // normalize dashes
    const catalogAction = action.replace(/_/g, '-');

    const match = registryCommands.find(
      r => r.namespace === ns && (r.action === action || r.action.replace(/_/g, '-') === catalogAction)
    );

    // The catalog defines the ideal command set;
    // registry may not have everything yet (planned commands)
    if (registryCommands.length > 0) {
      softCheck(
        !!match,
        `${cmdKey}: defined in tkads.js COMMAND_REGISTRY`,
        match
          ? `Found as ${match.full}`
          : `Catalog has "${cmdKey}" but tkads.js COMMAND_REGISTRY lacks it (may be planned)`
      );
    } else {
      console.log(`  ${dim('   ' + cmdKey + ': cannot verify — failed to parse COMMAND_REGISTRY')}`);
    }

    // Check required plugins exist in catalog
    if (cmd.requires && cmd.requires.length > 0) {
      for (const reqPlugin of cmd.requires) {
        const pluginExists = catalog.plugins && catalog.plugins[reqPlugin];
        softCheck(
          !!pluginExists,
          `${cmdKey}: requires plugin "${reqPlugin}" registered in catalog`,
          pluginExists ? 'Found in plugins section' : 'Not found in plugins section'
        );
      }
    }
  }

  // 5. Check databases
  const dbKeys = Object.keys(catalog.databases || {});
  console.log(`\n${COLOR.bold}── 数据库检查 (${dbKeys.length}) ──${COLOR.reset}`);
  for (const [dbKey, db] of Object.entries(catalog.databases || {})) {
    if (verbose) console.log(`\n  ${COLOR.cyan}[${dbKey}]${COLOR.reset} ${db.purpose}`);
    const resolvedPath = resolveHome(db.path);
    check(
      fs.existsSync(resolvedPath),
      `${dbKey}: ${db.path}`,
      resolvedPath
    );
    check(!!db.schema_version, `${dbKey}: schema_version = "${db.schema_version}"`);
  }

  // 6. Check versioned engine files
  const verKeys = Object.keys(catalog.versions || {});
  console.log(`\n${COLOR.bold}── 引擎文件检查 (${verKeys.length}) ──${COLOR.reset}`);
  for (const [verKey, verValue] of Object.entries(catalog.versions || {})) {
    if (verbose) console.log(`\n  ${COLOR.cyan}[${verKey}]${COLOR.reset} v${verValue}`);

    // Try to find the file: look in ~/.tkads/ for matching filenames
    const possibleNames = [
      path.join(HOME, '.tkads', verKey),
      path.join(HOME, '.tkads', `${verKey}.js`),
      path.join(HOME, '.tkads', `${verKey}.py`),
      path.join(HOME, '.tkads', verKey.replace(/-/g, '_')),
      path.join(HOME, '.tkads', verKey.replace(/_/g, '-')),
      path.join(HOME, '.tkads', `${verKey.replace(/-/g, '_')}.js`),
      path.join(HOME, '.tkads', `${verKey.replace(/-/g, '_')}.py`),
    ];

    let found = false;
    for (const fp of possibleNames) {
      if (fs.existsSync(fp)) {
        found = true;
        check(true, `${verKey} → ${path.basename(fp)}`, fp);
        break;
      }
    }
    if (!found) {
      check(false, `${verKey} v${verValue}`, `No matching file found in ~/.tkads/`);
    }
  }

  // 7. Check plugins
  const pluginKeys = Object.keys(catalog.plugins || {});
  console.log(`\n${COLOR.bold}── 插件检查 (${pluginKeys.length}) ──${COLOR.reset}`);
  for (const [pluginKey, plugin] of Object.entries(catalog.plugins || {})) {
    if (verbose) console.log(`\n  ${COLOR.cyan}[${pluginKey}]${COLOR.reset} ${plugin.name}`);
    check(!!plugin.version,        `${pluginKey}: version = "${plugin.version}"`);
    check(plugin.type === 'hook',  `${pluginKey}: type = "${plugin.type}"`);
    check(
      Array.isArray(plugin.hooks) && plugin.hooks.length > 0,
      `${pluginKey}: hooks defined [${plugin.hooks.join(', ')}]`
    );
    check(!!plugin.requires_tkads, `${pluginKey}: requires_tkads = "${plugin.requires_tkads}"`);
  }

  // ─── Summary ──────────────────────────────────────────────────────────────
  console.log('');
  printSummary();
}

function printSummary() {
  const allOk = stats.failed === 0 && stats.warnings === 0;
  const color = allOk ? COLOR.green : (stats.failed === 0 ? COLOR.yellow : COLOR.red);
  const status = allOk ? '完全健康' : (stats.failed === 0 ? '有警告' : '存在异常');

  console.log(`${COLOR.bold}╔══════════════════════════════════════════════════╗${COLOR.reset}`);
  console.log(`${COLOR.bold}║  检查摘要${COLOR.reset}                                      ${COLOR.bold}║${COLOR.reset}`);
  console.log(`${COLOR.bold}╚══════════════════════════════════════════════════╝${COLOR.reset}`);
  console.log(`  ${info('总计检查:')}  ${stats.checked}`);
  console.log(`  ${ok('通过:')}     ${stats.passed}`);
  if (stats.warnings > 0) console.log(`  ${warn('警告:')}     ${stats.warnings}`);
  if (stats.failed > 0)  console.log(`  ${fail('失败:')}     ${stats.failed}`);
  console.log('');
  console.log(`  ${color}${COLOR.bold}状态: ${status}${COLOR.reset}`);
  console.log('');

  if (stats.failed > 0) {
    console.log(`  ${dim('提示: 运行 catalog-check.js [--verbose|-v] 查看详情')}`);
    console.log('');
    process.exitCode = 1;
  }
}

main();
