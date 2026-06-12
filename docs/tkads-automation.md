# TKADS Automation System (v4)

## Architecture Overview

```
stores.json -> config-chain -> hook-engine -> gate-engine -> degrade-engine -> db_v2
                                        |                  |
                                   self-evolve.js    evolution-engine (daily)
                                        |                  |
                                   knowledge_v4/     knowledge_v4/
```

The v4 architecture is a layered pipeline that processes store configurations through a series of engines, applying business rules, quality gates, and degradation logic before persisting results.

---

## Modules & Engines Summary

| # | Module | Purpose |
|---|--------|---------|
| 1 | **stores.json** | Master configuration — defines all stores, sources, and top-level routing |
| 2 | **config-chain (config_chain.py)** | Resolves and chains configuration from stores.json → per-store overrides |
| 3 | **hook-engine (tkads_hook.py)** | Pre/post processing hooks; intercepts pipeline stages for observability |
| 4 | **gate-engine (gate_engine.py)** | Evaluates 7 quality gates before executing any automation task |
| 5 | **degrade-engine (degrade_engine.py)** | Applies graceful degradation when gates fail or resources are constrained |
| 6 | **db_v2 (db_v2.py)** | v2 database layer — logging, metrics, persistence of pipeline results |
| 7 | **self-evolve (self-evolve.js)** | Internal 2-hour cycle that self-improves prompts, agents, and execution logic |
| 8 | **evolution-engine (evolution-engine.py)** | External daily evolution that audits execution traces and retrains classifiers |
| 9 | **knowledge_v4/** | Three-layer knowledge base (stitch, invoke, aggregate) |
| 10 | **daily-collection (daily_collection.py)** | Cron-triggered daily data pipeline (07:00) |

---

## Namespace Commands

| Command | Description |
|---------|-------------|
| `tkads:help` | Show all commands |
| `tkads:status` | Pipeline health & last-run timestamps |
| `tkads:run <store>` | Run full pipeline for a single store |
| `tkads:run:all` | Run full pipeline for all stores |
| `tkads:gate:test <store>` | Dry-run gate evaluation only |
| `tkads:degrade:status` | Show active degradations |
| `tkads:degrade:revert <store>` | Manually revert degradation for a store |
| `tkads:evolve:internal` | Trigger self-evolve cycle immediately |
| `tkads:evolve:external` | Trigger evolution-engine cycle immediately |
| `tkads:evolve:status` | Show evolution cycle metrics |
| `tkads:kb:query <key>` | Query knowledge base |
| `tkads:kb:refresh` | Force refresh of knowledge base layers |
| `tkads:collection:run` | Run daily collection immediately |
| `tkads:collection:status` | Show collection status for today |
| `tkads:db:stats` | Show database statistics |
| `tkads:log:tail` | Tail recent pipeline logs |

---

## Gate Rules (Gate Engine)

The gate engine evaluates 7 gates in sequence. All gates must pass for execution to proceed.

| # | Gate ID | Check | Fail Action |
|---|---------|-------|-------------|
| 1 | `not_legacy` | Store not in legacy/excluded list | Skip (no degrade) |
| 2 | `spu_available` | SPU (Service Processing Unit) has capacity | Degrade: queue for off-peak |
| 3 | `config_valid` | Resolved config passes schema validation | Degrade: use fallback config |
| 4 | `api_reachable` | Target API responds to health check | Degrade: retry with backoff |
| 5 | `data_fresh` | Last-data timestamp is within freshness window | Degrade: use cached data |
| 6 | `quota_ok` | API quota not exhausted | Degrade: throttle requests |
| 7 | `output_writable` | Output destination is writable | Hard fail |

---

## Self-Evolution System

See [self-evolution.md](./self-evolution.md) and [evolution-engine.md](./evolution-engine.md) for detailed specifications.

### Dual System

| System | Cycle | Scope | Mechanism |
|--------|-------|-------|-----------|
| **self-evolve.js** | Every 2 hours | Internal — prompts, agents, execution logic | Retrieves traces from db_v2, scores performance, mutates prompt templates in hooks/ |
| **evolution-engine.py** | Daily (06:00) | External — classifiers, embeddings, knowledge base | Audits execution patterns, retrains gate classifiers, updates knowledge_v4/ |

---

## Knowledge Base (knowledge_v4/)

The knowledge base is organized in three layers:

| Layer | Directory | Purpose |
|-------|-----------|---------|
| **Stitch** | `knowledge_v4/stitch/` | Raw execution traces, store metadata, API responses |
| **Invoke** | `knowledge_v4/invoke/` | Processed patterns — successful gate pass/fail sequences |
| **Aggregate** | `knowledge_v4/aggregate/` | Aggregated metrics — store success rates, gate failure distributions |

---

## API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/v4/pipeline/run` | POST | Trigger pipeline for store(s) |
| `/api/v4/pipeline/status` | GET | Pipeline health and metrics |
| `/api/v4/gates/evaluate` | POST | Gate evaluation (dry-run) |
| `/api/v4/degrade/list` | GET | Active degradations |
| `/api/v4/degrade/revert` | POST | Revert degradation |
| `/api/v4/evolve/status` | GET | Evolution cycle status |
| `/api/v4/kb/query` | GET | Knowledge base query |
| `/api/v4/collection/run` | POST | Trigger daily collection |
| `/api/v4/collection/status` | GET | Collection status |

---

## Database Schemas (db_v2)

### pipeline_runs
```sql
CREATE TABLE pipeline_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id TEXT NOT NULL,
    started_at TIMESTAMP NOT NULL,
    finished_at TIMESTAMP,
    status TEXT NOT NULL CHECK(status IN ('running','passed','failed','degraded')),
    gates_passed INTEGER DEFAULT 0,
    gates_total INTEGER DEFAULT 7,
    error TEXT,
    trace_id TEXT UNIQUE
);
```

### gate_results
```sql
CREATE TABLE gate_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES pipeline_runs(id),
    gate_name TEXT NOT NULL,
    passed BOOLEAN NOT NULL,
    detail TEXT,
    evaluated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### evolution_cycles
```sql
CREATE TABLE evolution_cycles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_type TEXT NOT NULL CHECK(cycle_type IN ('internal','external')),
    started_at TIMESTAMP NOT NULL,
    finished_at TIMESTAMP,
    stores_processed INTEGER DEFAULT 0,
    mutations_applied INTEGER DEFAULT 0,
    performance_delta REAL
);
```

### daily_collections
```sql
CREATE TABLE daily_collections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collection_date DATE NOT NULL,
    store_id TEXT NOT NULL,
    status TEXT NOT NULL,
    records_collected INTEGER DEFAULT 0,
    started_at TIMESTAMP NOT NULL,
    finished_at TIMESTAMP,
    UNIQUE(collection_date, store_id)
);
```

---

## File Manifest

```
docs/tkads-automation.md          -- This file (v4 documentation)
docs/tkads-daily-collection.md    -- Daily collection flow
docs/tkads-v4-architecture.md     -- Comprehensive architecture reference
docs/self-evolution.md            -- Self-evolution system
docs/evolution-engine.md          -- Evolution engine detailed spec
tkads_v4/
  stores.json                     -- Master configuration
  config_chain.py                 -- Configuration chain resolver
  tkads_hook.py                   -- Hook engine
  gate_engine.py                  -- Gate evaluation engine
  degrade_engine.py               -- Degradation engine
  db_v2.py                        -- Database layer v2
  self-evolve.js                  -- Internal self-evolution (2h cycle)
  evolution-engine.py             -- External evolution engine (daily)
  daily_collection.py             -- Daily collection pipeline
  knowledge_v4/
    stitch/                       -- Raw execution traces
    invoke/                       -- Processed patterns
    aggregate/                    -- Aggregated metrics
```

---

## Configuration Chain (stores.json → config_chain.py)

### stores.json Structure
```json
{
  "stores": {
    "store_alpha": {
      "source": "facebook",
      "spu": "spu-01",
      "enabled": true,
      "overrides": {
        "collection_interval": 3600,
        "max_retries": 3
      }
    }
  },
  "global": {
    "default_collection_interval": 7200,
    "max_concurrent": 5,
    "freshness_window": 86400
  }
}
```

### Config Chain Resolution
1. Load `stores.json` global defaults
2. Apply per-store overrides
3. Pass through `config_chain.py` which:
   - Validates schema (required fields, types)
   - Resolves inheritance (store overrides global)
   - Injects environment-specific variables
   - Returns resolved `Config` object

---

## Hook Engine (tkads_hook.py)

The hook engine provides lifecycle hooks at each pipeline stage:

| Hook | Trigger | Signature |
|------|---------|-----------|
| `pre_run` | Before pipeline starts | `(store_id, config) → None` |
| `post_run` | After pipeline completes | `(store_id, status, result) → None` |
| `pre_gate` | Before gate evaluation | `(store_id, gate_name) → None` |
| `post_gate` | After gate evaluation | `(store_id, gate_name, passed, detail) → None` |
| `on_degrade` | When degradation applied | `(store_id, gate_name, degrade_action) → None` |
| `on_error` | When unrecoverable error occurs | `(store_id, error) → None` |

Hooks are registered in `hooks/` directory and auto-discovered by `self-evolve.js` during internal evolution.

---

## Degrade Engine (degrade_engine.py)

When a gate fails, the degrade engine applies one of these actions:

| Action | Description | Recovery |
|--------|-------------|----------|
| `queue_for_offpeak` | Queue execution for non-peak hours | Auto-retry at next off-peak window |
| `use_fallback_config` | Use a pre-defined fallback configuration | Next successful gate pass resets |
| `retry_with_backoff` | Retry with exponential backoff (1m, 2m, 4m, 8m, max 30m) | Auto-resolves when retry succeeds |
| `use_cached_data` | Serve last-known-good cached data | Cleared when fresh data available |
| `throttle_requests` | Reduce request rate to 25% of normal | Auto-ratchets up over time |
| `hard_fail` | Abort execution for this store | Requires manual re-trigger |

Active degradations are tracked in `db_v2.degradations` table and visible via `tkads:degrade:status`.
