'use strict';

const fs = require('fs');
const path = require('path');

// ─── Defaults ────────────────────────────────────────────────────────────────
const DEFAULT_STORE_ID = 'default';

const BUILTIN_DEFAULTS = {
  sid: '',
  api_secret: '',
  base_url: 'https://open-api.tiktokglobalshop.com',
  shop_cipher: '',
  app_key: '',
  app_secret: '',
  access_token: '',
  refresh_token: '',
  store_name: '',
  currency: 'USD',
  timezone: 'Asia/Shanghai',
  country: '',
  shop_id: '',
  bc_id: '',
  creator_uid: '',
  aadvid: '',
  tid: '',
  profile_id: '',
  seller_domain: '',
  ads_url: '',
  budget: 20,
  roi_target: 1.2,
  custom_props: {},
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Return the home-directory-resolved path for ~/.tkads/stores.json */
function storesJsonPath() {
  const home = process.env.HOME ||
               process.env.USERPROFILE ||
               (process.env.HOMEDRIVE && process.env.HOMEPATH
                 ? path.join(process.env.HOMEDRIVE, process.env.HOMEPATH)
                 : __dirname);
  return path.join(home, '.tkads', 'stores.json');
}

/** Lightweight deep-merge: copies own enumerable props from sources onto target. */
function deepMerge(target, ...sources) {
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    for (const key of Object.keys(src)) {
      const val = src[key];
      if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
        target[key] = deepMerge(target[key] || {}, val);
      } else {
        target[key] = val;
      }
    }
  }
  return target;
}

// ─── ConfigChain ─────────────────────────────────────────────────────────────

class ConfigChain {
  /**
   * @param {object} [opts]
   * @param {string} [opts.filePath]  Path to stores.json (default: ~/.tkads/stores.json)
   * @param {object} [opts.defaults]  Built-in defaults merged underneath everything
   */
  constructor(opts = {}) {
    this._filePath = opts.filePath || storesJsonPath();
    this._defaults = Object.assign({}, BUILTIN_DEFAULTS, opts.defaults || {});

    /** @type {{ mtime: number, data: object } | null} */
    this._cache = null;

    // Watch for SIGHUP to refresh cache on supported platforms (not Windows).
    if (process.listenerCount && typeof process.on === 'function') {
      process.on('SIGHUP', () => {
        this._cache = null;
      });
    }
  }

  // ── private helpers ──────────────────────────────────────────────────────

  /** Read & parse stores.json, with graceful fallback. */
  _loadRaw() {
    try {
      const stat = fs.statSync(this._filePath);
      if (this._cache && this._cache.mtime === stat.mtimeMs) {
        return this._cache.data;
      }
      const raw = fs.readFileSync(this._filePath, 'utf-8');
      const data = JSON.parse(raw);
      this._cache = { mtime: stat.mtimeMs, data };
      return data;
    } catch (err) {
      // File doesn't exist or is malformed — create with defaults.
      if (err.code === 'ENOENT' || err instanceof SyntaxError) {
        const defaults = {
          active_store: DEFAULT_STORE_ID,
          stores: {
            [DEFAULT_STORE_ID]: {},
          },
        };
        try {
          const dir = path.dirname(this._filePath);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          fs.writeFileSync(this._filePath, JSON.stringify(defaults, null, 2), 'utf-8');
        } catch (_) { /* best-effort */ }
        this._cache = { mtime: Date.now(), data: defaults };
        return defaults;
      }
      // For other errors (permissions etc.), return empty shape.
      return { active_store: DEFAULT_STORE_ID, stores: {} };
    }
  }

  /** Resolve the effective store ID. */
  _resolveStoreId(storeId) {
    if (storeId) return storeId;
    const envStore = process.env.TKADS_STORE;
    if (envStore) return envStore;
    const raw = this._loadRaw();
    return raw.active_store || DEFAULT_STORE_ID;
  }

  /** Return raw store config object (may be undefined). */
  _getStoreRaw(storeId) {
    const raw = this._loadRaw();
    const id = this._resolveStoreId(storeId);
    return raw.stores && raw.stores[id] ? raw.stores[id] : undefined;
  }

  /** Read an env override for `key` using TKADS_ prefix. */
  _envOverride(key) {
    const envKey = 'TKADS_' + key.toUpperCase();
    return process.env[envKey] !== undefined ? process.env[envKey] : undefined;
  }

  // ── public API ───────────────────────────────────────────────────────────

  /**
   * Get a resolved config value.
   * Priority: env override → store config → built-in defaults.
   *
   * @param {string} key       Dot-separated config key (e.g. 'sid' or 'custom_props.foo')
   * @param {string} [storeId] Optional explicit store ID
   * @returns {*} Resolved value, or undefined if not found anywhere.
   */
  get(key, storeId) {
    if (typeof key !== 'string' || key.length === 0) return undefined;

    // 1. env override
    const envVal = this._envOverride(key);
    if (envVal !== undefined) return envVal;

    // 2. store config
    const store = this._getStoreRaw(storeId);
    if (store !== undefined) {
      const parts = key.split('.');
      let cursor = store;
      for (const part of parts) {
        if (cursor === null || typeof cursor !== 'object') return undefined;
        cursor = cursor[part];
      }
      if (cursor !== undefined) return cursor;
    }

    // 3. fallback: try first available store
    if (!storeId) {
      const raw = this._loadRaw();
      const stores = raw.stores || {};
      const firstId = Object.keys(stores)[0];
      if (firstId && firstId !== this._resolveStoreId(storeId)) {
        const firstStore = stores[firstId];
        if (firstStore) {
          const parts = key.split('.');
          let cursor = firstStore;
          for (const part of parts) {
            if (cursor === null || typeof cursor !== 'object') return undefined;
            cursor = cursor[part];
          }
          if (cursor !== undefined) return cursor;
        }
      }
    }

    // 4. built-in defaults
    const parts = key.split('.');
    let cursor = this._defaults;
    for (const part of parts) {
      if (cursor === null || typeof cursor !== 'object') return undefined;
      cursor = cursor[part];
    }
    return cursor;
  }

  /**
   * Get all resolved config for a store, as a flat merged object.
   * Priority: env override (for known keys) → store config → built-in defaults.
   *
   * @param {string} [storeId] Optional explicit store ID
   * @returns {object}
   */
  getAll(storeId) {
    const store = this._getStoreRaw(storeId) || {};
    const merged = deepMerge({}, this._defaults, store);

    // Apply env overrides for every known default key.
    for (const key of Object.keys(this._defaults)) {
      const envVal = this._envOverride(key);
      if (envVal !== undefined) {
        merged[key] = envVal;
      }
    }

    // Also scan process.env for any TKADS_ prefixed keys not in defaults.
    for (const envKey of Object.keys(process.env)) {
      if (envKey.startsWith('TKADS_')) {
        const configKey = envKey.slice(6).toLowerCase();
        if (!(configKey in this._defaults)) {
          merged[configKey] = process.env[envKey];
        }
      }
    }

    return merged;
  }

  /**
   * Get the raw store config object (no env overrides, no defaults merged).
   *
   * @param {string} [storeId] Optional explicit store ID
   * @returns {object|undefined}
   */
  getStore(storeId) {
    return this._getStoreRaw(storeId);
  }

  /**
   * List all store IDs present in stores.json.
   *
   * @returns {string[]}
   */
  listStores() {
    const raw = this._loadRaw();
    const stores = raw.stores || {};
    return Object.keys(stores);
  }
}

// ─── Singleton export ────────────────────────────────────────────────────────

const instance = new ConfigChain();

module.exports = instance;
module.exports.ConfigChain = ConfigChain;
module.exports.BUILTIN_DEFAULTS = BUILTIN_DEFAULTS;
