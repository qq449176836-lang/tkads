'use strict';

/**
 * degrade-engine.js — Graceful degradation state machine for browser/API/CDP
 * interactions.  Provides fallback chains with retry, timeout, and consecutive-
 * failure escalation.
 *
 * Usage:
 *   const degradeEngine = require('./degrade-engine');
 *   const { DegradeEngine } = degradeEngine;
 *
 *   // Execute a built-in operation (auto-configured)
 *   const result = await degradeEngine.execute('browser_connect', {
 *     browser: puppeteerBrowser,
 *     page: puppeteerPage,
 *   });
 *
 *   // Define a custom fallback chain
 *   degradeEngine.define('my_op', [
 *     { name: 'fast',    fn: async (ctx) => ctx.doThing(), timeout: 5000 },
 *     { name: 'fallback', fn: async (ctx) => ctx.doThingSlow(), timeout: 15000 },
 *     { name: 'skip',    fn: async (ctx) => ({ skipped: true, reason: 'Unavailable' }) },
 *   ], { max_retries: 2, retry_delay: 1000 });
 *
 *   const res = await degradeEngine.execute('my_op', { doThing: ... });
 *   if (!res.ok) { /* handle degradation *\/ }
 */

// ─── No-dependency policy: use only Node.js built-ins ───────────────────────
const timers = require('timers');

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY = 2000;
const CONSECUTIVE_ESCALATION_THRESHOLD = 3;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Sleep for `ms` milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => timers.setTimeout(resolve, ms));
}

/**
 * Execute an async function with a timeout guard.
 * If the function does not settle within `timeout` ms, the promise rejects
 * with a TimeoutError.
 *
 * @param {Function} fn    Async function returning a promise.
 * @param {number} timeout  Max milliseconds to wait.
 * @param {string} label    Human-readable label for error messages.
 * @returns {Promise<*>}
 */
function withTimeout(fn, timeout, label) {
  return new Promise((resolve, reject) => {
    const timer = timers.setTimeout(() => {
      reject(new Error(`[degrade-engine] "${label}" timed out after ${timeout}ms`));
    }, timeout);

    Promise.resolve()
      .then(() => fn())
      .then((val) => {
        timers.clearTimeout(timer);
        resolve(val);
      })
      .catch((err) => {
        timers.clearTimeout(timer);
        reject(err);
      });
  });
}

// ─── DegradeEngine ───────────────────────────────────────────────────────────

class DegradeEngine {
  /**
   * @param {object} [config]
   * @param {number} [config.max_retries]          Override default max retries per strategy.
   * @param {number} [config.retry_delay]          Override default delay between retries (ms).
   * @param {number} [config.escalation_threshold] Consecutive failures before escalation.
   */
  constructor(config) {
    config = config || {};

    /** @type {Map<string, { strategies: Array<object>, options: object }>} */
    this._chains = new Map();

    /**
     * Per-operation consecutive failure counters.
     * @type {Map<string, number>}
     */
    this._failCounts = new Map();

    /**
     * Degradation states — set to true when a fallback was used (i.e. primary failed).
     * @type {Map<string, boolean>}
     */
    this._degraded = new Map();

    this._maxRetries = config.max_retries !== undefined ? config.max_retries : DEFAULT_MAX_RETRIES;
    this._retryDelay = config.retry_delay !== undefined ? config.retry_delay : DEFAULT_RETRY_DELAY;
    this._escalationThreshold =
      config.escalation_threshold !== undefined
        ? config.escalation_threshold
        : CONSECUTIVE_ESCALATION_THRESHOLD;

    // ── Register built-in chains ────────────────────────────────────────
    this._registerBuiltins();
  }

  /**
   * Register the three built-in fallback chains:
   *   browser_connect, cdp_evaluate, api_request
   *
   * @private
   */
  _registerBuiltins() {
    // ── browser_connect ──────────────────────────────────────────────────
    this.define(
      'browser_connect',
      [
        {
          name: 'connect_active',
          fn: async (ctx) => {
            // Expects ctx.browser (Puppeteer browser instance).
            // If browser already connected and page accessible, succeed.
            if (!ctx.browser) throw new Error('No browser instance in context');
            const pages = await ctx.browser.pages();
            if (!pages || pages.length === 0) throw new Error('Browser has no pages');
            // Return the first page as the connection result
            return { page: pages[0], browser: ctx.browser };
          },
          timeout: 10000,
        },
        {
          name: 'start_and_connect',
          fn: async (ctx) => {
            // Expects ctx.startBrowser() — a factory that returns a browser.
            // If no factory provided, try connecting to default endpoint.
            if (typeof ctx.startBrowser === 'function') {
              const browser = await ctx.startBrowser();
              const pages = await browser.pages();
              const page = pages.length > 0 ? pages[0] : await browser.newPage();
              return { page, browser };
            }
            throw new Error('No startBrowser function and no active browser');
          },
          timeout: 30000,
        },
        {
          name: 'readonly_fallback',
          fn: async (ctx) => ({
            skipped: true,
            degraded: true,
            mode: 'readonly',
            reason: 'Browser unavailable — operating in read-only / DB-only mode',
          }),
          timeout: 1000,
        },
      ],
      { max_retries: 2, retry_delay: 3000 }
    );

    // ── cdp_evaluate ────────────────────────────────────────────────────
    this.define(
      'cdp_evaluate',
      [
        {
          name: 'page_evaluate',
          fn: async (ctx) => {
            // ctx.page is a Puppeteer Page object with page.evaluate()
            if (!ctx.page || typeof ctx.page.evaluate !== 'function') {
              throw new Error('No page.evaluate available');
            }
            if (ctx.code === undefined && ctx.fn === undefined) {
              throw new Error('No code or function provided to evaluate');
            }
            const result = ctx.fn
              ? await ctx.page.evaluate(ctx.fn, ctx.args || [])
              : await ctx.page.evaluate(ctx.code);
            return { data: result, method: 'page.evaluate' };
          },
          timeout: 15000,
        },
        {
          name: 'network_fetch',
          fn: async (ctx) => {
            // Use CDP Network.fetch API if available (bypasses page JS execution).
            // Expects ctx.page or ctx.cdpSession with CDP methods.
            const cdp = ctx.cdpSession || (ctx.page && ctx.page._client);
            if (!cdp || typeof cdp.send !== 'function') {
              throw new Error('No CDP session available for Network.fetch');
            }
            if (!ctx.url) {
              throw new Error('No URL provided for Network.fetch fallback');
            }
            const result = await cdp.send('Network.fetch', {
              url: ctx.url,
              headers: ctx.headers || [],
              method: ctx.method || 'GET',
              postData: ctx.postData || undefined,
            });
            // Decode base64 body if present
            let body = null;
            if (result.response && result.response.body) {
              body = Buffer.from(result.response.body, 'base64').toString('utf-8');
              try {
                body = JSON.parse(body);
              } catch (_) {
                // keep as string
              }
            }
            return { data: body, method: 'Network.fetch', raw: result };
          },
          timeout: 20000,
        },
        {
          name: 'no_cdp_fallback',
          fn: async (ctx) => ({
            skipped: true,
            degraded: true,
            mode: 'no_cdp',
            reason: 'CDP evaluate and Network.fetch both unavailable — operating without CDP',
          }),
          timeout: 1000,
        },
      ],
      { max_retries: 1, retry_delay: 2000 }
    );

    // ── api_request ──────────────────────────────────────────────────────
    this.define(
      'api_request',
      [
        {
          name: 'page_evaluate_fetch',
          fn: async (ctx) => {
            if (!ctx.page || typeof ctx.page.evaluate !== 'function') {
              throw new Error('No page.evaluate available for API request');
            }
            if (!ctx.url) throw new Error('No URL for API request');
            const result = await ctx.page.evaluate(
              (opts) => {
                return fetch(opts.url, {
                  method: opts.method || 'GET',
                  headers: opts.headers || {},
                  body: opts.body || undefined,
                })
                  .then((r) => r.json())
                  .catch((e) => ({ _error: e.message }));
              },
              {
                url: ctx.url,
                method: ctx.method || 'GET',
                headers: ctx.headers || {},
                body: ctx.body || undefined,
              }
            );
            if (result && result._error) {
              throw new Error(`API fetch returned error: ${result._error}`);
            }
            return { data: result, method: 'page.evaluate(fetch)' };
          },
          timeout: 15000,
        },
        {
          name: 'retry_2s',
          fn: async (ctx) => {
            // Same as primary but with a 2-second pre-delay — retry semantics
            // are built into the execute loop's retry logic, but this strategy
            // is intentionally identical to the primary so that retries happen
            // with the delay from execute().
            if (!ctx.page || typeof ctx.page.evaluate !== 'function') {
              throw new Error('No page.evaluate available');
            }
            if (!ctx.url) throw new Error('No URL for API request');
            const result = await ctx.page.evaluate(
              (opts) => {
                return fetch(opts.url, {
                  method: opts.method || 'GET',
                  headers: opts.headers || {},
                  body: opts.body || undefined,
                })
                  .then((r) => r.json())
                  .catch((e) => ({ _error: e.message }));
              },
              {
                url: ctx.url,
                method: ctx.method || 'GET',
                headers: ctx.headers || {},
                body: ctx.body || undefined,
              }
            );
            if (result && result._error) {
              throw new Error(`API fetch returned error: ${result._error}`);
            }
            return { data: result, method: 'page.evaluate(fetch)' };
          },
          timeout: 15000,
        },
        {
          name: 'retry_5s',
          fn: async (ctx) => {
            // Third attempt after longer delay. Same strategy body, with
            // the 5-second delay enforced by the chain's retry_delay.
            if (!ctx.page || typeof ctx.page.evaluate !== 'function') {
              throw new Error('No page.evaluate available');
            }
            if (!ctx.url) throw new Error('No URL for API request');
            const result = await ctx.page.evaluate(
              (opts) => {
                return fetch(opts.url, {
                  method: opts.method || 'GET',
                  headers: opts.headers || {},
                  body: opts.body || undefined,
                })
                  .then((r) => r.json())
                  .catch((e) => ({ _error: e.message }));
              },
              {
                url: ctx.url,
                method: ctx.method || 'GET',
                headers: ctx.headers || {},
                body: ctx.body || undefined,
              }
            );
            if (result && result._error) {
              throw new Error(`API fetch returned error: ${result._error}`);
            }
            return { data: result, method: 'page.evaluate(fetch)' };
          },
          timeout: 15000,
        },
        {
          name: 'api_unavailable',
          fn: async (ctx) => ({
            skipped: true,
            degraded: true,
            error: 'api_unavailable',
            reason:
              'All API request attempts failed — Seller Center API unavailable',
          }),
          timeout: 1000,
        },
      ],
      { max_retries: 0, retry_delay: 5000 }
    );
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Define a fallback chain for an operation.
   *
   * @param {string}   name       Unique operation name (e.g. 'browser_connect').
   * @param {Array}    strategies Ordered array of strategy objects:
   *   { name: string, fn: async(ctx) => any, timeout?: number }
   *   Each strategy function receives the context object passed to execute().
   *   Strategies that throw or reject cause the chain to advance to the next.
   *   The final strategy typically returns a skip/degraded sentinel object.
   * @param {object}   [options]
   * @param {number}   [options.max_retries]  Per-strategy retry count (default: 3).
   * @param {number}   [options.retry_delay]  Delay between retries (ms) (default: 2000).
   */
  define(name, strategies, options) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('[degrade-engine] Operation name must be a non-empty string');
    }
    if (!Array.isArray(strategies) || strategies.length === 0) {
      throw new Error('[degrade-engine] Strategies must be a non-empty array');
    }

    // Validate each strategy has a name and fn
    for (let i = 0; i < strategies.length; i++) {
      const s = strategies[i];
      if (!s.name || typeof s.fn !== 'function') {
        throw new Error(
          `[degrade-engine] Strategy at index ${i} must have "name" (string) and "fn" (function)`
        );
      }
    }

    const opts = Object.assign({}, options);
    if (opts.max_retries === undefined) opts.max_retries = this._maxRetries;
    if (opts.retry_delay === undefined) opts.retry_delay = this._retryDelay;

    this._chains.set(name, { strategies, options: opts });

    // Initialise failure counter if not already set
    if (!this._failCounts.has(name)) {
      this._failCounts.set(name, 0);
    }
    if (!this._degraded.has(name)) {
      this._degraded.set(name, false);
    }
  }

  /**
   * Execute the best available strategy for a named operation.
   *
   * Tries each strategy in order (with per-strategy retries).  If all
   * strategies for a given operation fail, the method returns a degraded
   * result, increments the consecutive-failure counter, and — if the
   * threshold is reached — flags escalation.
   *
   * @param {string} name      Operation name (must have been defined).
   * @param {object} context   Arbitrary data passed to each strategy fn.
   * @returns {Promise<{ok: boolean, strategy_used: string, result: *, error?: string, degraded: boolean, escalated?: boolean}>}
   */
  async execute(name, context) {
    const chain = this._chains.get(name);
    if (!chain) {
      return {
        ok: false,
        strategy_used: null,
        result: null,
        error: `[degrade-engine] Unknown operation "${name}" — call define() first`,
        degraded: true,
      };
    }

    const { strategies, options } = chain;
    const maxRetries = options.max_retries;
    const retryDelay = options.retry_delay;

    let lastError = null;

    // Walk strategies in order
    for (const strategy of strategies) {
      const timeout = strategy.timeout || 30000;
      const label = `${name}:${strategy.name}`;

      // Retry loop for this strategy
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const result = await withTimeout(
            () => strategy.fn(context),
            timeout,
            label
          );

          // If strategy returns a skip sentinel (i.e. it's a graceful-noop)
          if (
            result &&
            result.skipped === true &&
            result.degraded === true
          ) {
            // This strategy is intentionally skipping — it's still a "success"
            // in the sense that it didn't throw, but we're now degraded.
            this._degraded.set(name, true);
            this._incrementFailure(name);

            // Check escalation
            const failCount = this._failCounts.get(name) || 0;
            const escalated = failCount >= this._escalationThreshold;

            return {
              ok: true,
              strategy_used: strategy.name,
              result: result,
              degraded: true,
              escalated,
              error: result.reason || undefined,
            };
          }

          // Clean success — reset failure counter, clear degraded flag
          this._failCounts.set(name, 0);
          this._degraded.set(name, false);

          return {
            ok: true,
            strategy_used: strategy.name,
            result,
            degraded: false,
            escalated: false,
          };
        } catch (err) {
          lastError = err;

          if (attempt < maxRetries) {
            // Wait before retrying this strategy
            await sleep(retryDelay);
            continue;
          }

          // Out of retries for this strategy — advance to next strategy
          break;
        }
      }
    }

    // All strategies exhausted
    this._degraded.set(name, true);
    this._incrementFailure(name);

    const failCount = this._failCounts.get(name) || 0;
    const escalated = failCount >= this._escalationThreshold;

    return {
      ok: false,
      strategy_used: strategies.length > 0 ? strategies[strategies.length - 1].name : null,
      result: null,
      error: lastError ? lastError.message : 'All strategies exhausted',
      degraded: true,
      escalated,
    };
  }

  /**
   * Get the consecutive failure count for an operation.
   *
   * @param {string} name Operation name.
   * @returns {number}
   */
  getFailureCount(name) {
    return this._failCounts.get(name) || 0;
  }

  /**
   * Reset the consecutive failure count for an operation (e.g. after a
   * successful manual intervention or a positive health check).
   *
   * @param {string} name Operation name.
   */
  resetFailureCount(name) {
    this._failCounts.set(name, 0);
    this._degraded.set(name, false);
  }

  /**
   * Get the current degradation status of all tracked operations.
   *
   * @returns {object}
   *   { operations: { [name]: { failures, degraded, escalated } },
   *     degraded_any: boolean,
   *     escalated_any: boolean }
   */
  getStatus() {
    const operations = {};
    let degradedAny = false;
    let escalatedAny = false;

    for (const name of this._chains.keys()) {
      const failures = this._failCounts.get(name) || 0;
      const degraded = this._degraded.get(name) || false;
      const escalated = failures >= this._escalationThreshold;

      operations[name] = { failures, degraded, escalated };

      if (degraded) degradedAny = true;
      if (escalated) escalatedAny = true;
    }

    return {
      operations,
      degraded_any: degradedAny,
      escalated_any: escalatedAny,
    };
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  /**
   * Increment consecutive failure count for an operation.
   * @param {string} name
   * @private
   */
  _incrementFailure(name) {
    const current = this._failCounts.get(name) || 0;
    this._failCounts.set(name, current + 1);
  }
}

// ─── Singleton export ────────────────────────────────────────────────────────

const instance = new DegradeEngine();

module.exports = instance;
module.exports.DegradeEngine = DegradeEngine;
