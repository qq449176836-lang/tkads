# TKADS v4 Architecture Reference

## Overview

TKADS v4 is a layered, event-driven automation pipeline for managing targeted keyword advertising delivery across multiple stores. It processes store configurations through a chain of specialized engines, applying quality gates, degradation logic, and self-evolution mechanisms.

---

## System Context Diagram

```
                    +-----------+
                    |   Cron    |
                    |  (07:00)  |
                    +-----+-----+
                          |
                    +-----v-----------+
                    | daily_collection|
                    |    .py          |
                    +-----+-----------+
                          |
+-----------+     +------v------+     +-----------+
| stores    |---->| config_chain|---->| hook      |
| .json     |     | .py         |     | engine    |
+-----------+     +------+------+     +-----+-----+
                          |                  |
                    +-----v------+           |
                    | gate       |           |
                    | engine     |           |
                    +-----+------+           |
                          |                  |
                    +-----v------+           |
                    | degrade    |           |
                    | engine     |           |
                    +-----+------+           |
                          |                  |
                    +-----v------+           |
                    | db_v2      |<----------+
                    | .py        |
                    +-----+------+
                          |
                    +-----v------+
                    | knowledge  |
                    | _v4/       |
                    +-----+------+
                          |
              +-----------+-----------+
              |                       |
        +-----v------+         +------v-----+
        | self-evolve |         | evolution  |
        | .js (2h)    |         | -engine.py |
        +-------------+         | (daily)    |
                                +------------+
```

---

## Module Reference

### 1. stores.json

**Purpose:** Master configuration file defining all stores, data sources, SPU assignments, and global defaults.

**Location:** `tkads_v4/stores.json`

**Structure:**
```json
{
  "stores": {
    "<store_id>": {
      "source": "<source_type>",
      "spu": "<spu_id>",
      "enabled": <boolean>,
      "overrides": {
        "collection_interval": <seconds>,
        "max_retries": <int>,
        "freshness_window": <seconds>
      }
    }
  },
  "global": {
    "default_collection_interval": 7200,
    "max_concurrent": 5,
    "freshness_window": 86400,
    "retry_backoff_base": 60
  }
}
```

### 2. config_chain.py

**Purpose:** Configuration resolution and validation pipeline.

**Location:** `tkads_v4/config_chain.py`

**Resolution Steps:**
1. **Load** global defaults from `stores.json`
2. **Merge** per-store overrides (shallow merge, overrides take precedence)
3. **Validate** against schema:
   - Required: `source`, `spu`
   - Optional with defaults: `collection_interval`, `max_retries`, `freshness_window`
   - Type checks: all string/int/boolean fields
4. **Resolve** environment variables: `$ENV_VAR` patterns in config values
5. **Inject** computed fields:
   - `api_endpoint`: derived from source type
   - `credentials`: resolved from credential vault
   - `retry_schedule`: computed from backoff params
6. **Return** immutable `Config` namedtuple

### 3. hook_engine (tkads_hook.py)

**Purpose:** Lifecycle event hooks for observability and extensibility.

**Location:** `tkads_v4/tkads_hook.py`

**Hook Registry:**
Hooks are Python callables registered in the `hooks/` subdirectory. The engine auto-discovers hooks by scanning `hooks/*.py` at startup.

**Available Hooks:**
| Hook | Trigger | Receives |
|------|---------|----------|
| `pre_run(store_id, config)` | Before pipeline execution | Store ID + resolved config |
| `post_run(store_id, status, result)` | After pipeline completes | Store, status, result object |
| `pre_gate(store_id, gate_name)` | Before gate evaluation | Store, gate name |
| `post_gate(store_id, gate_name, passed, detail)` | After gate evaluation | Store, gate, pass/fail, detail |
| `on_degrade(store_id, gate_name, action)` | When degradation applied | Store, failing gate, action taken |
| `on_error(store_id, error)` | On unrecoverable error | Store, exception |

**Hook Lifecycle:**
```
Discovered at startup -> Registered in hook registry
    -> Called at each lifecycle point -> Results aggregated
    -> Errors caught and logged (hooks never crash the pipeline)
```

### 4. gate_engine (gate_engine.py)

**Purpose:** Quality gate evaluation before task execution.

**Location:** `tkads_v4/gate_engine.py`

**Evaluation Order:**
1. `not_legacy` — Store not in legacy/excluded list
2. `spu_available` — SPU has capacity
3. `config_valid` — Config passes schema validation
4. `api_reachable` — Target API responds
5. `data_fresh` — Data within freshness window
6. `quota_ok` — API quota not exhausted
7. `output_writable` — Output destination is writable

**Gate Evaluation Process:**
```python
# Pseudocode
for gate in gates:
    result = gate.evaluate(store_id, config)
    log_gate_result(store_id, gate.name, result)
    if not result.passed:
        degrade_action = degrade_engine.apply(store_id, gate.name, result)
        if degrade_action == "hard_fail":
            abort_pipeline(store_id)
        else:
            continue_with_degradation(store_id, degrade_action)
```

### 5. degrade_engine (degrade_engine.py)

**Purpose:** Graceful degradation when gates fail.

**Location:** `tkads_v4/degrade_engine.py`

**Degradation Actions:**
| Action | Applies To | Behavior |
|--------|------------|----------|
| `queue_for_offpeak` | spu_available | Delays execution to next off-peak window |
| `use_fallback_config` | config_valid | Switches to pre-approved fallback config |
| `retry_with_backoff` | api_reachable | Retries with exponential backoff (1m, 2m, 4m...) |
| `use_cached_data` | data_fresh | Serves cached data from last successful run |
| `throttle_requests` | quota_ok | Reduces request rate to 25% |
| `hard_fail` | output_writable | Aborts execution immediately |

**Degradation Lifecycle:**
```
Gate fails -> degrade_engine.evaluate(failing_gate, context)
    -> Selects action -> Applies action -> Logs to db_v2
    -> Sets auto-recovery conditions -> Triggers on_degrade hook
```

### 6. db_v2 (db_v2.py)

**Purpose:** v2 database layer for logging, metrics, and persistence.

**Location:** `tkads_v4/db_v2.py`

**Database:** SQLite (file: `tkads_v4/data/tkads_v2.db`)

**Tables:**
- `pipeline_runs`: Pipeline execution records
- `gate_results`: Per-gate pass/fail results
- `evolution_cycles`: Self-evolution run records
- `daily_collections`: Daily collection records
- `degradations`: Active degradation records

### 7. self-evolve.js (Internal 2h Cycle)

**Purpose:** Internal self-improvement system that runs every 2 hours.

**Location:** `tkads_v4/self-evolve.js`

**Process:**
1. Query `db_v2` for recent pipeline traces (last 2 hours)
2. Score performance per store (success rate, gate pass rate, execution time)
3. Analyze prompt templates in `hooks/` directory
4. Apply mutations to underperforming templates
5. Validate mutations against a test suite
6. Commit validated mutations
7. Log cycle results to `evolution_cycles` table

### 8. evolution-engine.py (Daily External Cycle)

**Purpose:** External audit and retraining system that runs daily.

**Location:** `tkads_v4/evolution-engine.py`

**Components:**
- **Explorer:** Deploys experimental configurations
- **AutoLoader:** Loads execution traces from db_v2
- **Reviewer:** Scores and classifies execution outcomes
- **Orchestrator:** Coordinates the full cycle

### 9. knowledge_v4/

**Purpose:** Three-layer knowledge base for execution trace storage and analysis.

**Location:** `tkads_v4/knowledge_v4/`

| Layer | Store | Content | Access Pattern |
|-------|-------|---------|----------------|
| **Stitch** | `stitch/` | Raw JSON traces, store metadata, API responses | Write-heavy, append-only |
| **Invoke** | `invoke/` | Processed patterns (gate pass/fail sequences) | Read-heavy, indexed |
| **Aggregate** | `aggregate/` | Store metrics (success rates, distributions) | Dashboard queries |

---

## Data Flow

### Full Pipeline Flow
```
1. stores.json           → Load master configuration
2. config_chain.py       → Resolve per-store config
3. hook_engine.pre_run   → Notify listeners
4. gate_engine           → Evaluate 7 gates
5. degrade_engine        → Apply degradation if needed
6. hook_engine.on_degrade → Notify of degradation
7. Execute collection    → Run data collection
8. hook_engine.post_run  → Notify completion
9. db_v2                 → Persist results
10. knowledge_v4/stitch  → Store raw trace
```

### Error Flow
```
Error at any step
    → hook_engine.on_error(error)
    → db_v2.log_error(run_id, error)
    → degrade_engine.escalate(store_id)
    → Return degraded status
```

---

## Command Reference

### Pipeline Commands
| Command | Description |
|---------|-------------|
| `tkads:help` | Show all available commands |
| `tkads:status` | Pipeline health and last-run timestamps |
| `tkads:run <store>` | Run full pipeline for a single store |
| `tkads:run:all` | Run full pipeline for all enabled stores |

### Gate Commands
| Command | Description |
|---------|-------------|
| `tkads:gate:test <store>` | Dry-run gate evaluation only |
| `tkads:gate:list` | List all gates with their current status |
| `tkads:gate:bypass <store> <gate>` | Bypass a specific gate for a store |

### Degrade Commands
| Command | Description |
|---------|-------------|
| `tkads:degrade:status` | Show active degradations |
| `tkads:degrade:revert <store>` | Manually revert degradation |
| `tkads:degrade:history <store>` | Show degradation history |

### Evolution Commands
| Command | Description |
|---------|-------------|
| `tkads:evolve:internal` | Trigger self-evolve cycle immediately |
| `tkads:evolve:external` | Trigger evolution-engine cycle immediately |
| `tkads:evolve:status` | Show evolution cycle metrics |

### Knowledge Base Commands
| Command | Description |
|---------|-------------|
| `tkads:kb:query <key>` | Query knowledge base |
| `tkads:kb:refresh` | Force refresh of knowledge base layers |
| `tkads:kb:stats` | Show knowledge base statistics |

### Collection Commands
| Command | Description |
|---------|-------------|
| `tkads:collection:run` | Run daily collection immediately |
| `tkads:collection:status` | Show collection status for today |
| `tkads:collection:history <store>` | Show collection history |

### Database Commands
| Command | Description |
|---------|-------------|
| `tkads:db:stats` | Show database statistics |
| `tkads:db:cleanup <days>` | Clean records older than N days |
| `tkads:log:tail` | Tail recent pipeline logs |

---

## Gate Reference

### Gate 1: not_legacy
**Purpose:** Prevent execution on legacy/disabled stores.
**Check:** `store_id not in LEGACY_STORES`
**Fail Action:** Skip (no degrade — store is intentionally excluded)
**Data Source:** `stores.json` legacy list + runtime exclude list

### Gate 2: spu_available
**Purpose:** Ensure SPU has processing capacity.
**Check:** `spu.current_load() < spu.max_load * 0.8`
**Fail Action:** `queue_for_offpeak`
**Data Source:** SPU metrics API

### Gate 3: config_valid
**Purpose:** Validate resolved configuration.
**Check:** `config_chain.validate(resolved_config)`
**Fail Action:** `use_fallback_config`
**Data Source:** Config schema definition

### Gate 4: api_reachable
**Purpose:** Verify target API is responding.
**Check:** HTTP health check to `config.api_endpoint + "/health"`
**Fail Action:** `retry_with_backoff`
**Data Source:** Target API health endpoint

### Gate 5: data_fresh
**Purpose:** Check if existing data is within freshness window.
**Check:** `(now - last_data_timestamp) < freshness_window`
**Fail Action:** `use_cached_data`
**Data Source:** `db_v2.pipeline_runs` last successful run

### Gate 6: quota_ok
**Purpose:** Verify API quota is not exhausted.
**Check:** `api.quota_remaining() > config.min_quota`
**Fail Action:** `throttle_requests`
**Data Source:** API quota endpoint + local counter

### Gate 7: output_writable
**Purpose:** Verify output destination is accessible and writable.
**Check:** Write test to output path
**Fail Action:** `hard_fail`
**Data Source:** Filesystem/network check to output destination

---

## API Endpoints

| Endpoint | Method | Request Body | Response |
|----------|--------|-------------|----------|
| `/api/v4/pipeline/run` | POST | `{"store_id": "..."}` or `{"all": true}` | `{"run_id", "status", "gates"}` |
| `/api/v4/pipeline/status` | GET | — | `{"health", "last_runs", "degradations"}` |
| `/api/v4/gates/evaluate` | POST | `{"store_id": "..."}` | `{"gates": [{name, passed, detail}]}` |
| `/api/v4/degrade/list` | GET | — | `{"degradations": [...]}` |
| `/api/v4/degrade/revert` | POST | `{"store_id": "..."}` | `{"status", "reverted"}` |
| `/api/v4/evolve/status` | GET | — | `{"last_internal", "last_external", "metrics"}` |
| `/api/v4/kb/query` | GET | `?key=...&layer=stitch\|invoke\|aggregate` | `{"results": [...]}` |
| `/api/v4/collection/run` | POST | `{"store_id": "..."}` or `{"all": true}` | `{"run_id", "status", "stores"}` |
| `/api/v4/collection/status` | GET | `?date=...` | `{"date", "stores", "summary"}` |

---

## Database Schema (db_v2)

### Full Schema

```sql
-- Pipeline runs
CREATE TABLE pipeline_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id TEXT NOT NULL,
    started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at TIMESTAMP,
    status TEXT NOT NULL CHECK(status IN ('running','passed','failed','degraded')),
    gates_passed INTEGER DEFAULT 0,
    gates_total INTEGER DEFAULT 7,
    error TEXT,
    trace_id TEXT UNIQUE
);

-- Per-gate results
CREATE TABLE gate_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES pipeline_runs(id),
    gate_name TEXT NOT NULL,
    passed BOOLEAN NOT NULL,
    detail TEXT,
    evaluated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Evolution cycles
CREATE TABLE evolution_cycles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_type TEXT NOT NULL CHECK(cycle_type IN ('internal','external')),
    started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at TIMESTAMP,
    stores_processed INTEGER DEFAULT 0,
    mutations_applied INTEGER DEFAULT 0,
    performance_delta REAL
);

-- Daily collections
CREATE TABLE daily_collections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collection_date DATE NOT NULL,
    store_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('running','completed','failed','skipped','degraded')),
    records_collected INTEGER DEFAULT 0,
    started_at TIMESTAMP NOT NULL,
    finished_at TIMESTAMP,
    UNIQUE(collection_date, store_id)
);

-- Active degradations
CREATE TABLE degradations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id TEXT NOT NULL,
    gate_name TEXT NOT NULL,
    action TEXT NOT NULL,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP,
    is_active BOOLEAN DEFAULT TRUE,
    detail TEXT
);

-- Indexes
CREATE INDEX idx_pipeline_runs_store ON pipeline_runs(store_id);
CREATE INDEX idx_pipeline_runs_status ON pipeline_runs(status);
CREATE INDEX idx_gate_results_run ON gate_results(run_id);
CREATE INDEX idx_daily_collections_date ON daily_collections(collection_date);
CREATE INDEX idx_degradations_active ON degradations(is_active);
```
