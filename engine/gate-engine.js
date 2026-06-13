'use strict';

/**
 * gate-engine.js — Constitution gate system for the tkads automation system.
 *
 * Enforces immutable rules ("constitution") before operations, blocking
 * violations with detailed messages.  Designed to be plugged into the
 * hook-engine lifecycle (as `before:*` hooks).
 *
 * Usage:
 *   const gateEngine = require('./gate-engine');
 *   const { GateEngine } = gateEngine;
 *
 *   // Run gates before an operation:
 *   const result = await gateEngine.check('before:create_ad', {
 *     store: 'hanmac',
 *     campaign_id: '123',
 *     spu_id: 'SPU456',
 *     name: '自动化-SPU456',
 *     roi_target: 1.5,
 *     budget: 20,
 *   });
 *   if (!result.passed) {
 *     console.error('Gate blocked:', result.failures);
 *   }
 */

// ─── No-dependency policy: use only Node.js built-ins ───────────────────────
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ─── Constants ───────────────────────────────────────────────────────────────

const TKADS_DIR = path.join(
  process.env.HOME ||
    process.env.USERPROFILE ||
    (process.env.HOMEDRIVE && process.env.HOMEPATH
      ? path.join(process.env.HOMEDRIVE, process.env.HOMEPATH)
      : __dirname),
  '.tkads'
);

const STORES_JSON_PATH = path.join(TKADS_DIR, 'stores.json');
const CAMPAIGN_DB_PATH = path.join(TKADS_DIR, 'campaign_meta.db');

/** Valid events the gate system recognises. */
const VALID_EVENTS = new Set([
  'before:create_ad',
  'before:pause_ad',
  'before:resume_ad',
  'before:update_roi',
]);

/**
 * Map of events to the gates that are relevant for them.
 * Gates not listed in any event's array run for ALL events (universal).
 */
const EVENT_GATES = {
  'before:create_ad':  ['spu_available', 'naming_rule', 'constitution_check', 'catalog_health'],
  'before:pause_ad':   ['ad_exists'],
  'before:resume_ad':  ['ad_exists'],
  'before:update_roi': ['not_legacy', 'ad_type_modifiable', 'catalog_health'],
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Load stores.json and return the parsed object.
 * Returns an empty object on failure.
 */
function _loadStoresJson() {
  try {
    const raw = fs.readFileSync(STORES_JSON_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    return {};
  }
}

/**
 * Get the list of gates enabled by default from stores.json.
 * Falls back to all known gates if not configured.
 */
function _getEnabledByDefault() {
  const config = _loadStoresJson();
  const enabled = config.gates && config.gates.enabled_by_default;
  if (Array.isArray(enabled) && enabled.length > 0) {
    return new Set(enabled);
  }
  // Fallback: all built-in gates enabled
  return new Set([
    'not_legacy',
    'spu_available',
    'ad_type_modifiable',
    'ad_exists',
    'naming_rule',
    'constitution_check',
  ]);
}

/**
 * Get the constitution rules array from stores.json.
 */
function _getConstitutionRules() {
  const config = _loadStoresJson();
  return (config.constitution && config.constitution.rules) || [];
}

/**
 * Query SQLite via a Python subprocess.
 *
 * @param {string} dbPath        Absolute path to the .db file.
 * @param {string} sql           SQL query string.
 * @param {Array}  [params=[]]   Positional parameters (? placeholders).
 * @returns {{ rows: Array<Array>, columns: string[], error?: string }}
 */
function _querySqlite(dbPath, sql, params = []) {
  const script = `
import sqlite3, json, sys
db = ${JSON.stringify(dbPath)}
sql = ${JSON.stringify(sql)}
params = ${JSON.stringify(params)}
try:
    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute(sql, params)
    columns = [d[0] for d in cur.description] if cur.description else []
    rows = [list(r) for r in cur.fetchall()]
    conn.close()
    print(json.dumps({"columns": columns, "rows": rows}))
except Exception as e:
    print(json.dumps({"error": str(e), "columns": [], "rows": []}))
`;

  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
  const result = spawnSync(pythonCmd, ['-c', script], {
    encoding: 'utf-8',
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  });

  if (result.error) {
    // Try 'python3' on Windows if 'python' failed
    if (process.platform === 'win32' && pythonCmd === 'python') {
      const result2 = spawnSync('python3', ['-c', script], {
        encoding: 'utf-8',
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      });
      if (result2.error) {
        return { rows: [], columns: [], error: `Python subprocess failed: ${result2.error.message}` };
      }
      try {
        return JSON.parse(result2.stdout);
      } catch (e) {
        return { rows: [], columns: [], error: `Python output parse error: ${e.message}` };
      }
    }
    return { rows: [], columns: [], error: `Python subprocess failed: ${result.error.message}` };
  }

  try {
    return JSON.parse(result.stdout);
  } catch (e) {
    return { rows: [], columns: [], error: `Python output parse error: ${e.message}` };
  }
}

/**
 * Check whether a campaign has existing daily_stats data.
 * @param {string} campaignId
 * @returns {{ hasData: boolean, rowCount: number, error?: string }}
 */
function _checkCampaignHasData(campaignId) {
  const sql = `
    SELECT COUNT(*) AS cnt
    FROM daily_stats
    WHERE campaign_id = ?
  `;
  const res = _querySqlite(CAMPAIGN_DB_PATH, sql, [campaignId]);
  if (res.error) {
    return { hasData: false, rowCount: 0, error: res.error };
  }
  if (res.rows.length > 0 && res.rows[0].length > 0) {
    return { hasData: res.rows[0][0] > 0, rowCount: res.rows[0][0] };
  }
  return { hasData: false, rowCount: 0 };
}

/**
 * Check whether an SPU is already used by another active campaign.
 * @param {string} spuId
 * @param {string} [excludeCampaignId] Campaign to exclude from the check.
 * @returns {{ inUse: boolean, campaignName?: string, campaignId?: string, error?: string }}
 */
function _checkSpuInUse(spuId, excludeCampaignId) {
  // Try campaigns table first
  let sql = `
    SELECT campaign_id, name FROM campaigns
    WHERE spu_id = ? AND status = 'ACTIVE'
  `;
  const params = [spuId];

  if (excludeCampaignId) {
    sql += ` AND campaign_id != ?`;
    params.push(excludeCampaignId);
  }

  sql += ` LIMIT 1`;

  const res = _querySqlite(CAMPAIGN_DB_PATH, sql, params);
  if (res.error || res.rows.length === 0) {
    // Fallback: try campaign_spus junction table or generic campaigns table
    const fallbackSql = `
      SELECT campaign_id, name FROM campaigns
      WHERE spu_id = ? AND status NOT IN ('DELETE', 'REMOVED')
    `;
    const fallbackParams = [spuId];
    if (excludeCampaignId) {
      fallbackSql.replace(/;$/, '') + ` AND campaign_id != ?`;
      fallbackParams.push(excludeCampaignId);
    }
    const fallbackRes = _querySqlite(CAMPAIGN_DB_PATH, fallbackSql, fallbackParams);
    if (fallbackRes.error || fallbackRes.rows.length === 0) {
      return { inUse: false };
    }
    return {
      inUse: true,
      campaignId: fallbackRes.rows[0][0],
      campaignName: fallbackRes.rows[0][1] || 'Unknown',
    };
  }

  return {
    inUse: true,
    campaignId: res.rows[0][0],
    campaignName: res.rows[0][1] || 'Unknown',
  };
}

/**
 * Check whether a campaign ID exists in the DB.
 * @param {string} campaignId
 * @returns {{ exists: boolean, error?: string }}
 */
function _checkCampaignExists(campaignId) {
  const sql = `
    SELECT COUNT(*) AS cnt FROM campaigns WHERE campaign_id = ?
  `;
  const res = _querySqlite(CAMPAIGN_DB_PATH, sql, [campaignId]);
  if (res.error) {
    return { exists: false, error: res.error };
  }
  if (res.rows.length > 0 && res.rows[0].length > 0) {
    return { exists: res.rows[0][0] > 0 };
  }
  return { exists: false };
}

/**
 * Get the ad type for a campaign from the DB.
 * @param {string} campaignId
 * @returns {{ adType?: string, error?: string }}
 */
function _getCampaignAdType(campaignId) {
  const sql = `
    SELECT ad_type FROM campaigns WHERE campaign_id = ?
  `;
  const res = _querySqlite(CAMPAIGN_DB_PATH, sql, [campaignId]);
  if (res.error) {
    return { error: res.error };
  }
  if (res.rows.length > 0 && res.rows[0].length > 0) {
    return { adType: res.rows[0][0] };
  }
  return { adType: undefined };
}

// ─── GateEngine ──────────────────────────────────────────────────────────────

class GateEngine {
  /**
   * @param {object} [config]  Optional configuration.  When omitted the
   *    constructor auto-loads from stores.json in ~/.tkads/.
   */
  constructor(config) {
    /** @type {Map<string, { checkFn: Function, options: object, enabled: boolean }>} */
    this._gates = new Map();

    // ── Load enabled-by-default list from config or stores.json ────────
    if (config && config.enabled_by_default) {
      this._enabledByDefault = new Set(config.enabled_by_default);
    } else {
      this._enabledByDefault = _getEnabledByDefault();
    }

    // ── Register all built-in gates ────────────────────────────────────
    this._registerBuiltins();
  }

  // ── Built-in gate registrations ────────────────────────────────────────

  /** @private */
  _registerBuiltins() {
    this.register(
      'not_legacy',
      async (context) => this._gateNotLegacy(context),
      {
        enabled: this._enabledByDefault.has('not_legacy'),
        description:
          'Checks campaign_meta.db: if campaign has existing daily_stats data, blocks ROI/budget changes',
      }
    );

    this.register(
      'spu_available',
      async (context) => this._gateSpuAvailable(context),
      {
        enabled: this._enabledByDefault.has('spu_available'),
        description:
          'Checks campaign_meta.db: if SPU is already used by another active campaign, blocks creation',
      }
    );

    this.register(
      'ad_type_modifiable',
      async (context) => this._gateAdTypeModifiable(context),
      {
        enabled: this._enabledByDefault.has('ad_type_modifiable'),
        description:
          'Checks if ad type supports ROI modification (Product GMV Max and Shop GMV Max cannot)',
      }
    );

    this.register(
      'ad_exists',
      async (context) => this._gateAdExists(context),
      {
        enabled: this._enabledByDefault.has('ad_exists'),
        description:
          'Checks campaign_meta.db: verifies campaign_id exists before pause/resume',
      }
    );

    this.register(
      'naming_rule',
      async (context) => this._gateNamingRule(context),
      {
        enabled: this._enabledByDefault.has('naming_rule'),
        description:
          'Validates ad name matches "自动化-<SPU_ID>" pattern',
      }
    );

    this.register(
      'constitution_check',
      async (context) => this._gateConstitutionCheck(context),
      {
        enabled: this._enabledByDefault.has('constitution_check'),
        description:
          'General catch-all: verifies all immutable rules from the constitution',
      }
    );

    // ─── v4.1: catalog_health 门禁 ───
    this.register(
      'catalog_health',
      async (context) => this._gateCatalogHealth(context),
      {
        enabled: this._enabledByDefault.has('catalog_health'),
        description:
          'Runs catalog-check.js and blocks operations if catalog has unresolved failures',
      }
    );
  }

  // ── Individual gate implementations ────────────────────────────────────

  /**
   * gate:not_legacy — Block ROI/budget modification on campaigns that have
   * existing daily_stats data (i.e. they are "legacy" plans with history).
   *
   * Applicable events: before:update_roi
   *
   * @param {object} context
   * @param {string} [context.campaign_id]
   * @returns {Promise<{passed: boolean, message: string, severity: string}>}
   */
  async _gateNotLegacy(context) {
    const campaignId = context.campaign_id;
    if (!campaignId) {
      return {
        passed: true,
        message: 'No campaign_id provided — skipping legacy check',
        severity: 'warn',
      };
    }

    const { hasData, rowCount, error } = _checkCampaignHasData(campaignId);

    if (error) {
      return {
        passed: false,
        message:
          `[gate:not_legacy] Cannot verify legacy status for campaign "${campaignId}" — ` +
          `database query failed: ${error}. Blocking as a safety measure.`,
        severity: 'error',
      };
    }

    if (hasData) {
      return {
        passed: false,
        message:
          `[gate:not_legacy] BLOCKED: Campaign "${campaignId}" has ${rowCount} ` +
          `daily_stats record(s) — it is a legacy plan with existing data. ` +
          `CONSTITUTION RULE: NEVER modify ROI or budget of legacy plans with existing data.`,
        severity: 'error',
      };
    }

    return {
      passed: true,
      message: `Campaign "${campaignId}" has no existing data — modifications allowed`,
      severity: 'error',
    };
  }

  /**
   * gate:spu_available — Block ad creation if the SPU is already used by
   * another active campaign.
   *
   * Applicable events: before:create_ad
   *
   * @param {object} context
   * @param {string} [context.spu_id]
   * @param {string} [context.campaign_id]  (optional, to exclude self)
   * @returns {Promise<{passed: boolean, message: string, severity: string}>}
   */
  async _gateSpuAvailable(context) {
    const spuId = context.spu_id;
    if (!spuId) {
      return {
        passed: true,
        message: 'No spu_id provided — skipping SPU availability check',
        severity: 'warn',
      };
    }

    const { inUse, campaignId, campaignName, error } = _checkSpuInUse(spuId, context.campaign_id);

    if (error) {
      return {
        passed: false,
        message:
          `[gate:spu_available] Cannot verify SPU "${spuId}" availability — ` +
          `database query failed: ${error}. Blocking as a safety measure.`,
        severity: 'error',
      };
    }

    if (inUse) {
      return {
        passed: false,
        message:
          `[gate:spu_available] BLOCKED: SPU "${spuId}" is already in use by ` +
          `active campaign "${campaignName || campaignId}" (ID: ${campaignId || 'unknown'}). ` +
          `CONSTITUTION RULE: New ads must check SPU availability first.`,
        severity: 'error',
      };
    }

    return {
      passed: true,
      message: `SPU "${spuId}" is available — not used by any other active campaign`,
      severity: 'error',
    };
  }

  /**
   * gate:ad_type_modifiable — Block ROI modification on ad types that do not
   * support it (Product GMV Max and Shop GMV Max).
   *
   * Applicable events: before:update_roi
   *
   * @param {object} context
   * @param {string} [context.campaign_id]
   * @param {string} [context.ad_type]
   * @returns {Promise<{passed: boolean, message: string, severity: string}>}
   */
  async _gateAdTypeModifiable(context) {
    // Resolve ad type: from context first, then from DB
    let adType = context.ad_type;

    if (!adType && context.campaign_id) {
      const { adType: dbAdType, error } = _getCampaignAdType(context.campaign_id);
      if (!error && dbAdType) {
        adType = dbAdType;
      }
    }

    if (!adType) {
      return {
        passed: true,
        message: 'No ad_type available — skipping ad_type_modifiable check',
        severity: 'warn',
      };
    }

    // Ad types that do NOT support ROI modification
    const nonModifiableTypes = new Set([
      'PRODUCT_GMV_MAX',
      'SHOP_GMV_MAX',
      'Product GMV Max',
      'Shop GMV Max',
    ]);

    if (nonModifiableTypes.has(adType)) {
      return {
        passed: false,
        message:
          `[gate:ad_type_modifiable] BLOCKED: Ad type "${adType}" does not support ROI/budget modification. ` +
          `CONSTITUTION RULE: Do not attempt to modify ROI or budget on non-modifiable ad types.`,
        severity: 'error',
      };
    }

    return {
      passed: true,
      message: `Ad type "${adType}" supports ROI modification`,
      severity: 'error',
    };
  }

  /**
   * gate:ad_exists — Verify that a campaign_id exists in the DB before
   * performing pause/resume operations.
   *
   * Applicable events: before:pause_ad, before:resume_ad
   *
   * @param {object} context
   * @param {string} [context.campaign_id]
   * @returns {Promise<{passed: boolean, message: string, severity: string}>}
   */
  async _gateAdExists(context) {
    const campaignId = context.campaign_id;
    if (!campaignId) {
      return {
        passed: false,
        message:
          '[gate:ad_exists] BLOCKED: No campaign_id provided. Cannot perform pause/resume without a valid campaign identifier.',
        severity: 'error',
      };
    }

    const { exists, error } = _checkCampaignExists(campaignId);

    if (error) {
      return {
        passed: false,
        message:
          `[gate:ad_exists] Cannot verify campaign "${campaignId}" existence — ` +
          `database query failed: ${error}. Blocking as a safety measure.`,
        severity: 'error',
      };
    }

    if (!exists) {
      return {
        passed: false,
        message:
          `[gate:ad_exists] BLOCKED: Campaign "${campaignId}" does not exist in campaign_meta.db. ` +
          `Cannot perform pause/resume on a non-existent campaign.`,
        severity: 'error',
      };
    }

    return {
      passed: true,
      message: `Campaign "${campaignId}" exists in campaign_meta.db — operation allowed`,
      severity: 'error',
    };
  }

  /**
   * gate:naming_rule — Validate that the ad name follows the required pattern
   * "自动化-<SPU_ID>".
   *
   * Applicable events: before:create_ad
   *
   * @param {object} context
   * @param {string} [context.name]
   * @param {string} [context.spu_id]
   * @returns {Promise<{passed: boolean, message: string, severity: string}>}
   */
  async _gateNamingRule(context) {
    const name = context.name;

    if (!name) {
      return {
        passed: false,
        message:
          '[gate:naming_rule] BLOCKED: No ad name provided. ' +
          'CONSTITUTION RULE: All automation ads MUST be named "自动化-<SPU_ID>".',
        severity: 'error',
      };
    }

    // Pattern: "自动化-" followed by the SPU ID (alphanumeric, underscores, dashes)
    const pattern = /^自动化-[A-Za-z0-9_-]+$/;
    const matches = pattern.test(name);

    if (!matches) {
      // Try to give a more specific message
      if (!name.startsWith('自动化-')) {
        return {
          passed: false,
          message:
            `[gate:naming_rule] BLOCKED: Ad name "${name}" does not start with "自动". ` +
            `CONSTITUTION RULE: All automation ads MUST be named "自动化-<SPU_ID>". ` +
            `Expected pattern: 自动化-<SPU_ID> (e.g. 自动化-SPU123)`,
          severity: 'error',
        };
      }

      const suffix = name.slice(4); // after "自动化-"
      if (!suffix) {
        return {
          passed: false,
          message:
            `[gate:naming_rule] BLOCKED: Ad name "${name}" has no SPU ID after prefix. ` +
            `CONSTITUTION RULE: All automation ads MUST be named "自动化-<SPU_ID>".`,
          severity: 'error',
        };
      }

      return {
        passed: false,
        message:
          `[gate:naming_rule] BLOCKED: Ad name "${name}" contains invalid characters in SPU ID portion "${suffix}". ` +
          `CONSTITUTION RULE: All automation ads MUST be named "自动化-<SPU_ID>". ` +
          `SPU ID must contain only alphanumeric characters, underscores, or dashes.`,
        severity: 'error',
      };
    }

    // Optionally verify that the SPU_ID in the name matches context.spu_id
    const extractedSpu = name.slice(4); // Remove "自动化-" prefix
    if (context.spu_id && extractedSpu !== context.spu_id) {
      return {
        passed: false,
        message:
          `[gate:naming_rule] BLOCKED: Ad name SPU "${extractedSpu}" does not match context spu_id "${context.spu_id}". ` +
          `CONSTITUTION RULE: All automation ads MUST be named "自动化-<SPU_ID>" with matching SPU ID.`,
        severity: 'error',
      };
    }

    return {
      passed: true,
      message: `Ad name "${name}" conforms to naming convention`,
      severity: 'error',
    };
  }

  /**
   * gate:constitution_check — General catch-all gate that verifies ALL
   * immutable rules from the constitution (stores.json) are satisfied.
   *
   * This is a meta-gate that double-checks everything contextually.
   *
   * @param {object} context
   * @returns {Promise<{passed: boolean, message: string, severity: string}>}
   */
  async _gateConstitutionCheck(context) {
    const rules = _getConstitutionRules();
    const violations = [];

    // Rule 1: NEVER modify ROI/budget of legacy plans with existing data
    if (context.request_type === 'update_roi' || context.request_type === 'update_budget') {
      if (context.campaign_id) {
        const { hasData, rowCount } = _checkCampaignHasData(context.campaign_id);
        if (hasData) {
          violations.push(
            `Constitution Rule #1 violated: Campaign "${context.campaign_id}" has ${rowCount} ` +
            `daily_stats record(s). NEVER modify ROI or budget of legacy plans with existing data.`
          );
        }
      }
    }

    // Rule 2: All automation ads MUST be named "自动化-<SPU_ID>"
    if (context.name) {
      const pattern = /^自动化-[A-Za-z0-9_-]+$/;
      if (!pattern.test(context.name)) {
        violations.push(
          `Constitution Rule #2 violated: Ad name "${context.name}" does not match required pattern "自动化-<SPU_ID>".`
        );
      }
      // Also check SPU match
      if (context.spu_id) {
        const extracted = context.name.slice(4);
        if (extracted !== context.spu_id) {
          violations.push(
            `Constitution Rule #2 violated: Ad name SPU "${extracted}" does not match context spu_id "${context.spu_id}".`
          );
        }
      }
    }

    // Rule 3: Each automation plan MUST contain exactly 1 product
    if (context.products && Array.isArray(context.products)) {
      if (context.products.length !== 1) {
        violations.push(
          `Constitution Rule #3 violated: Plan has ${context.products.length} product(s), but each automation plan MUST contain exactly 1 product.`
        );
      }
    }
    if (context.product_count !== undefined && context.product_count !== 1) {
      violations.push(
        `Constitution Rule #3 violated: Plan has ${context.product_count} product(s), but each automation plan MUST contain exactly 1 product.`
      );
    }

    // Rule 4: Do NOT change timezone or start time (use defaults)
    if (context.timezone && context.timezone !== 'Asia/Shanghai') {
      violations.push(
        `Constitution Rule #4 violated: Attempting to set timezone to "${context.timezone}". ` +
        `Do NOT change timezone — use default (Asia/Shanghai).`
      );
    }
    if (context.start_time) {
      violations.push(
        `Constitution Rule #4 violated: Attempting to set start_time to "${context.start_time}". ` +
        `Do NOT change start time — use defaults.`
      );
    }
    if (context.schedule_type && context.schedule_type !== 'default') {
      violations.push(
        `Constitution Rule #4 violated: Attempting to set schedule_type to "${context.schedule_type}". ` +
        `Do NOT change schedule type — use defaults.`
      );
    }

    // Rule 5: New ads must check SPU availability first
    if (context.event === 'before:create_ad' || context.request_type === 'create_ad') {
      if (context.spu_id) {
        const { inUse, campaignName, campaignId } = _checkSpuInUse(context.spu_id, context.campaign_id);
        if (inUse) {
          violations.push(
            `Constitution Rule #5 violated: SPU "${context.spu_id}" is already in use by campaign ` +
            `"${campaignName || campaignId}". New ads must check SPU availability first.`
          );
        }
      }
    }

    if (violations.length > 0) {
      return {
        passed: false,
        message:
          `[gate:constitution_check] CONSTITUTION VIOLATION(S) DETECTED:\n  - ` +
          violations.join('\n  - '),
        severity: 'error',
      };
    }

    return {
      passed: true,
      message: 'All constitution rules pass',
      severity: 'error',
    };
  }

  /**
   * gate:catalog_health — Run catalog-check.js and block if unresolved failures exist.
   * Uses a 60-second cache to avoid running the check on every event.
   * Applicable events: before:create_ad, before:update_roi
   *
   * @param {object} context
   * @returns {Promise<{passed: boolean, message: string, severity: string}>}
   */
  async _gateCatalogHealth(context) {
    // Cache: only re-run catalog check every 60 seconds
    if (this._catalogHealthCache && (Date.now() - this._catalogHealthCache.ts) < 60000) {
      if (this._catalogHealthCache.passed) {
        return { passed: true, message: 'Catalog health OK (cached)', severity: 'error' };
      }
      return {
        passed: false,
        message: `Catalog health issue (cached): ${this._catalogHealthCache.failCount} failure(s) remain. Run node self-evolve.js to auto-fix.`,
        severity: 'error',
      };
    }

    try {
      const { spawnSync } = require('child_process');
      const path = require('path');
      const tkadsDir = path.join(
        process.env.HOME || process.env.USERPROFILE || '',
        '.tkads'
      );
      const result = spawnSync('node', [path.join(tkadsDir, 'catalog-check.js')], {
        cwd: tkadsDir,
        timeout: 30000,
        encoding: 'utf8',
      });

      const output = result.stdout || '';
      const hasFailures = output.includes('✗');
      const failCount = hasFailures ? (output.match(/✗/g) || []).length : 0;
      const passed = !hasFailures;

      // Cache result
      this._catalogHealthCache = {
        ts: Date.now(),
        passed,
        failCount,
        output: output.slice(0, 500),
      };

      if (passed) {
        return { passed: true, message: 'Catalog health OK', severity: 'error' };
      }
      return {
        passed: false,
        message: `Catalog has ${failCount} unresolved failure(s). Run 'node ~/.tkads/self-evolve.js' to auto-fix.`,
        severity: 'error',
      };
    } catch (e) {
      return {
        passed: true,
        message: `Catalog health check skipped (${e.message})`,
        severity: 'warn',
      };
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Register a gate check function.
   *
   * @param {string}   name              Unique gate identifier, e.g. 'spu_available'.
   * @param {Function} checkFn           Async function(context) => { passed, message, severity }.
   * @param {object}   [options]         Optional metadata.
   * @param {boolean}  [options.enabled=true]  Whether the gate is active.
   * @param {string}   [options.description]   Human-readable description.
   * @returns {GateEngine} This instance for chaining.
   */
  register(name, checkFn, options = {}) {
    if (typeof name !== 'string' || !name) {
      throw new TypeError('gate-engine: name must be a non-empty string');
    }
    if (typeof checkFn !== 'function') {
      throw new TypeError('gate-engine: checkFn must be a function');
    }

    const enabled = options.enabled !== undefined ? !!options.enabled : true;
    const description = options.description || '';

    if (this._gates.has(name)) {
      throw new Error(`gate-engine: gate "${name}" is already registered`);
    }

    this._gates.set(name, {
      checkFn,
      options: { ...options, enabled, description },
      enabled,
    });

    return this;
  }

  /**
   * Run all applicable gates for a given operation context.
   *
   * @param {string}  event    Event name, e.g. 'before:create_ad'.
   * @param {object}  context  Operation context with fields like store,
   *                           campaign_id, spu_id, name, etc.
   * @returns {Promise<{passed: boolean, results: Array, failures: Array}>}
   */
  async check(event, context) {
    if (!VALID_EVENTS.has(event)) {
      return {
        passed: false,
        results: [],
        failures: [
          {
            name: '_event_validation',
            passed: false,
            message: `Unknown event "${event}". Valid events: ${[...VALID_EVENTS].join(', ')}`,
            severity: 'error',
          },
        ],
      };
    }

    // Build the enhanced context
    const ctx = {
      ...(context || {}),
      event,
      timestamp: Date.now(),
    };

    const results = [];

    // Determine which gates to run for this event.
    // A gate runs for an event if:
    //   (a) it is listed in EVENT_GATES[event], OR
    //   (b) it is NOT listed in ANY event's array (truly universal gate).
    const eventGateNames = EVENT_GATES[event] || [];

    // Pre-compute the set of all gates that are tied to at least one specific event.
    const allTiedGates = new Set();
    for (const gates of Object.values(EVENT_GATES)) {
      for (const g of gates) {
        allTiedGates.add(g);
      }
    }

    const gatesToRun = [];

    // (a) Event-specific gates in defined order
    for (const gateName of eventGateNames) {
      if (this._gates.has(gateName) && this._gates.get(gateName).enabled) {
        gatesToRun.push(gateName);
      }
    }

    // (b) Universal gates: registered but NOT listed in any event's array
    for (const [name, meta] of this._gates) {
      if (!meta.enabled) continue;
      if (allTiedGates.has(name)) continue; // already handled or event-specific
      gatesToRun.push(name);
    }

    // Execute gates in order
    for (const gateName of gatesToRun) {
      const meta = this._gates.get(gateName);
      const start = Date.now();

      try {
        const gateResult = await meta.checkFn(ctx);

        const result = {
          name: gateName,
          passed: gateResult.passed,
          message: gateResult.message,
          severity: gateResult.severity || 'error',
          duration_ms: Date.now() - start,
        };

        results.push(result);

        // Log each gate result
        if (!result.passed) {
          console.error(
            `[gate-engine] ${event} | ${gateName} | BLOCKED ${result.duration_ms}ms | ${result.message}`
          );
        } else {
          console.log(
            `[gate-engine] ${event} | ${gateName} | PASS ${result.duration_ms}ms`
          );
        }
      } catch (err) {
        const result = {
          name: gateName,
          passed: false,
          message: `[gate-engine] Gate "${gateName}" threw an exception: ${err.message || String(err)}`,
          severity: 'error',
          duration_ms: Date.now() - start,
        };
        results.push(result);

        console.error(
          `[gate-engine] ${event} | ${gateName} | EXCEPTION ${result.duration_ms}ms | ${result.message}`
        );
      }
    }

    // Collect all failures
    const failures = results.filter((r) => !r.passed);

    return {
      passed: failures.length === 0,
      results,
      failures,
    };
  }

  /**
   * Enable or disable a specific gate by name.
   *
   * @param {string}  name     Gate identifier.
   * @param {boolean} enabled  true to enable, false to disable.
   * @returns {boolean} True if the gate was found and updated.
   */
  setState(name, enabled) {
    const meta = this._gates.get(name);
    if (!meta) return false;

    meta.enabled = !!enabled;
    return true;
  }

  /**
   * List all registered gates with their current state.
   *
   * @param {string} [event]  Optional event name to filter gates for.
   * @returns {Array<{name: string, enabled: boolean, description: string}>}
   */
  list(event) {
    const result = [];

    for (const [name, meta] of this._gates) {
      // If event filter is specified, only include gates relevant to that event
      if (event) {
        const eventGates = EVENT_GATES[event] || [];
        // Check if this gate is either event-specific or universal
        const isEventSpecific = eventGates.includes(name);
        const isUniversal = !Object.values(EVENT_GATES).some((gates) =>
          gates.includes(name)
        );
        if (!isEventSpecific && !isUniversal) continue;
      }

      result.push({
        name,
        enabled: meta.enabled,
        description: meta.options.description || '',
      });
    }

    return result;
  }

  /**
   * Return the internal gates Map (for introspection / debugging).
   * @private
   */
  _debugGates() {
    return this._gates;
  }
}

// ─── Singleton instance ──────────────────────────────────────────────────────
// Auto-loads configuration from stores.json.
const gateEngine = new GateEngine();

module.exports = gateEngine;
module.exports.GateEngine = GateEngine;
