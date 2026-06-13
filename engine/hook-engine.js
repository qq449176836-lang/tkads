'use strict';

/**
 * hook-engine.js — Lifecycle hook system for the tkads automation system.
 *
 * Registered handlers run in priority order on named events.  This is the
 * plugin / extension architecture foundation used by tkads.js and Python
 * scripts.
 *
 * Events the system listens for:
 *   before:create_ad    after:create_ad
 *   before:pause_ad     after:pause_ad
 *   before:resume_ad    after:resume_ad
 *   before:update_roi   after:update_roi
 *   before:collect      after:collect
 *   before:report       after:report
 *
 * Usage:
 *   const hookEngine = require('./hook-engine');
 *   const { HookEngine } = hookEngine;             // class reference
 *   hookEngine.register('after:create_ad', async (ctx) => { ... }, { priority: 5 });
 *   await hookEngine.trigger('after:create_ad', { ad_id: '123', store });
 */

// ─── No-dependency policy: only Node.js built-ins ───────────────────────────
const path = require('path');

// ─── Default priority when none is specified ────────────────────────────────
const DEFAULT_PRIORITY = 10;

// ─── HookEngine ─────────────────────────────────────────────────────────────

class HookEngine {
  /**
   * @param {object} [config]  Optional config object.  When omitted the
   *    constructor requires `config-chain.js` from the same directory as this
   *    file, resolving ~/.tkads/ at runtime.
   */
  constructor(config) {
    /** @type {Map<string, Map<string, {handler: Function, priority: number, description: string}>>} */
    this._hooks = new Map();

    if (config !== undefined) {
      this.config = config;
    } else {
      // Require sibling config-chain.js (the singleton instance).
      // We resolve the path at runtime so the file can be required from
      // anywhere without worrying about cwd.
      this.config = require(path.join(__dirname, 'config-chain.js'));
    }

    // Internal counter used to generate auto-IDs when none is supplied.
    this._idCounter = 0;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Register a hook handler for a named event.
   *
   * @param {string}   event           Event name, e.g. 'after:create_ad'.
   * @param {Function} handler         Async or sync function(context) => void.
   * @param {object}   [options]       Optional metadata.
   * @param {number}   [options.priority=10]  Lower number runs first (1 is highest).
   * @param {string}   [options.id]    Unique identifier.  Auto-generated if omitted.
   * @param {string}   [options.description]  Human-readable label for logs.
   * @returns {string} The assigned handler id.
   */
  register(event, handler, options = {}) {
    if (typeof event !== 'string' || !event) {
      throw new TypeError('hook-engine: event must be a non-empty string');
    }
    if (typeof handler !== 'function') {
      throw new TypeError('hook-engine: handler must be a function');
    }

    const priority = options.priority !== undefined ? options.priority : DEFAULT_PRIORITY;
    const id = options.id || `hook_${event}_${++this._idCounter}`;
    const description = options.description || '';

    if (!this._hooks.has(event)) {
      this._hooks.set(event, new Map());
    }

    const eventHooks = this._hooks.get(event);

    if (eventHooks.has(id)) {
      throw new Error(`hook-engine: handler id "${id}" is already registered for event "${event}"`);
    }

    eventHooks.set(id, { handler, priority, description });

    return id;
  }

  /**
   * Unregister a hook handler by its id.
   *
   * @param {string} event      Event name.
   * @param {string} handlerId  The id returned by register().
   * @returns {boolean} True if the handler was found and removed.
   */
  unregister(event, handlerId) {
    if (!this._hooks.has(event)) return false;
    return this._hooks.get(event).delete(handlerId);
  }

  /**
   * Trigger all handlers registered for an event, in priority order.
   *
   * Each handler receives a mutable `context` object.  If a handler throws,
   * the error is caught and the chain continues — no handler can break the
   * pipeline for subsequent ones.
   *
   * @param {string} event    Event name.
   * @param {object} context  Arbitrary data to pass to each handler (mutable).
   * @returns {Promise<Array<{id: string, status: string, duration_ms: number, error?: string}>>}
   */
  async trigger(event, context) {
    const results = [];
    const handlers = this._getSortedHandlers(event);

    if (handlers.length === 0) {
      return results;
    }

    // Normalise context so it's always an object (even if null/undefined passed).
    const ctx = (context !== null && context !== undefined && typeof context === 'object')
      ? context
      : {};

    for (const { id, handler, description } of handlers) {
      const start = Date.now();
      let status = 'success';
      let error = undefined;

      try {
        await handler(ctx);
      } catch (err) {
        status = 'error';
        error = err.message || String(err);
      }

      const duration_ms = Date.now() - start;

      results.push({ id, status, duration_ms, error });

      // Log each result at the console (the system logger can pick these up).
      if (status === 'error') {
        console.error(
          `[hook-engine] ${event} | ${id}${description ? ' (' + description + ')' : ''} | ERROR ${duration_ms}ms | ${error}`
        );
      } else {
        console.log(
          `[hook-engine] ${event} | ${id}${description ? ' (' + description + ')' : ''} | OK ${duration_ms}ms`
        );
      }
    }

    return results;
  }

  /**
   * List all registered hooks, optionally filtered by event.
   *
   * @param {string} [event]  If provided, only list handlers for this event.
   * @returns {object}  A map of event -> array of { id, priority, description }.
   */
  list(event) {
    if (event) {
      const hooks = this._hooks.get(event);
      if (!hooks) return {};
      return {
        [event]: this._sortedHandlerInfo(event),
      };
    }

    const result = {};
    for (const [evt] of this._hooks) {
      result[evt] = this._sortedHandlerInfo(evt);
    }
    return result;
  }

  /**
   * Clear all hooks, or clear hooks for a specific event.
   *
   * @param {string} [event]  Optional event name.  If omitted, ALL hooks are cleared.
   */
  clear(event) {
    if (event) {
      this._hooks.delete(event);
    } else {
      this._hooks.clear();
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * Return handlers for an event sorted by priority (ascending).
   * @private
   */
  _getSortedHandlers(event) {
    const eventHooks = this._hooks.get(event);
    if (!eventHooks) return [];

    const entries = [];
    for (const [id, meta] of eventHooks) {
      entries.push({ id, ...meta });
    }

    entries.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      // Stable sort tie-breaker: insertion order (compare ids).
      return 0;
    });

    return entries;
  }

  /**
   * Return info for all handlers on an event (sorted), sans the handler fn.
   * @private
   */
  _sortedHandlerInfo(event) {
    const eventHooks = this._hooks.get(event);
    if (!eventHooks) return [];

    const info = [];
    for (const [id, meta] of eventHooks) {
      info.push({ id, priority: meta.priority, description: meta.description });
    }
    info.sort((a, b) => a.priority - b.priority);
    return info;
  }
}

// ─── Singleton instance ─────────────────────────────────────────────────────
// The singleton is initialised without an explicit config so it auto-resolves
// config-chain.js.  Consumers who need a different config can instantiate
// the class directly:  const engine = new HookEngine(myConfig);
const hookEngine = new HookEngine();

module.exports = hookEngine;
module.exports.HookEngine = HookEngine;
