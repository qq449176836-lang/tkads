# Evolution Engine

## Overview

The Evolution Engine (`evolution-engine.py`) is the **external** component of TKADS v4's dual self-evolution system. It runs daily at **06:00** and performs deep analysis, classifier retraining, and knowledge base updates. Unlike the internal `self-evolve.js` which iterates on prompt templates every 2 hours, the Evolution Engine focuses on structural improvements to the pipeline's analytical foundations.

---

## Architecture

```
+---------------------------+     +---------------------------+
|      AutoLoader            |     |        Explorer           |
| Loads execution traces    |     | Deploys experiment configs|
| from db_v2 + stitch/      |     | to canary stores          |
+------------+--------------+     +-------------+-------------+
             |                                  |
             +----------+   +-------------------+
                        |   |
               +--------v---v--------+
               |    Reviewer         |
               | Scores & classifies |
               +--------+-----------+
                        |
               +--------v-----------+
               |   Orchestrator      |
               | Coordinates actions |
               +--------+-----------+
                        |
          +-------------+-------------+
          |             |             |
    +-----v-----+ +----v----+ +-----v-----+
    | Classifier | |Embedding| |knowledge  |
    | Retrain    | | Update  | |_v4/ Update|
    +-----------+ +---------+ +-----------+
```

---

## Components

### 1. Explorer

**Purpose:** Deploy experimental configurations to canary stores and monitor outcomes.

**Trigger:** Start of external evolution cycle (06:00)

**Process:**
```
1. SELECT canary stores (10% of total, rotated daily)
2. GENERATE experimental configurations:
   a) Alternative gate thresholds (±10% variation)
   b) Alternative retry strategies (different backoff multipliers)
   c) Alternative fallback configurations
3. DEPLOY to canary stores for evaluation period (60 minutes)
4. MONITOR outcomes:
   - Gate pass rates
   - Execution times
   - Error rates
   - Resource consumption
5. COLLECT results for Reviewer phase
```

**Configuration:**
```python
# evolution-engine.py internal config
EXPLORER_CONFIG = {
    "canary_ratio": 0.1,           # 10% of stores are canaries
    "evaluation_period_minutes": 60,
    "max_experiments_per_cycle": 5,
    "mutation_types": ["threshold", "retry", "fallback"]
}
```

### 2. AutoLoader

**Purpose:** Load and normalize execution traces from all sources.

**Process:**
```
1. CONNECT to db_v2 database
2. QUERY pipeline_runs for last 24 hours:
   - Run records (passed, failed, degraded)
   - Gate results per run
   - Active degradation records
3. PARSE knowledge_v4/stitch/ raw trace files:
   - JSON trace files from recent pipeline runs
   - API response payloads
   - Error stack traces
4. NORMALIZE all data into unified format:
   - Standard timestamp fields
   - Consistent status codes
   - Merged metadata
5. INDEX by store_id, timestamp, gate_name
6. PASS to Reviewer for analysis
```

**Data Format:**
```python
# Normalized execution trace
{
    "trace_id": "trc_abc123",
    "store_id": "store_alpha",
    "timestamp": "2026-06-12T04:00:00Z",
    "status": "degraded",
    "gates": [
        {"name": "not_legacy", "passed": True},
        {"name": "spu_available", "passed": False, "detail": "SPU load 85%"}
    ],
    "degrade_action": "queue_for_offpeak",
    "execution_time_ms": 34200,
    "error": None,
    "metadata": {
        "config_version": "v4.2",
        "source": "facebook"
    }
}
```

### 3. Reviewer

**Purpose:** Score and classify execution outcomes, identify patterns.

**Process:**
```
1. RECEIVE normalized traces from AutoLoader
2. SCORE each execution:
   - Binary: Pass/Fail
   - Score: 0.0-1.0 based on:
     * All gates passed? (1.0)
     * Degraded but completed? (0.5)
     * Failed? (0.0)
     * Partial degradation? (weighted 0.3-0.7)
3. CLASSIFY gate failure patterns:
   - Pattern A: "Morning SPU congestion" (spu_available fails 06:00-09:00)
   - Pattern B: "API rate limiting" (quota_ok fails after peak calls)
   - Pattern C: "Stale data cascade" (data_fresh fails → cascade failures)
   - Pattern D: "Config drift" (config_valid fails after config changes)
4. IDENTIFY systemic issues:
   - Stores with consistent gate failures
   - Gates with high failure rates across stores
   - Time-based failure patterns (peak hours, day of week)
5. COMPUTE metrics for Orchestrator:
   - Per-store: success_rate, avg_execution_time, degradation_ratio
   - Per-gate: failure_rate, mean_time_between_failures
   - Global: overall_health_score, trend (improving/declining)
```

**Classification Schema:**
```python
FAILURE_PATTERNS = {
    "morning_congestion": {
        "gates": ["spu_available"],
        "time_range": ("06:00", "09:00"),
        "action": "adjust_offpeak_window"
    },
    "api_rate_limiting": {
        "gates": ["quota_ok"],
        "pattern": "increasing_failures_through_day",
        "action": "reduce_concurrency"
    },
    "stale_data_cascade": {
        "gates": ["data_fresh"],
        "pattern": "isolated_store_failures",
        "action": "refresh_cache"
    },
    "config_drift": {
        "gates": ["config_valid"],
        "pattern": "sudden_new_failures",
        "action": "rollback_config"
    }
}
```

### 4. Orchestrator

**Purpose:** Coordinate the full evolution cycle. Aggregates findings from Explorer, AutoLoader, and Reviewer, then executes retraining actions.

**Process:**
```
1. AGGREGATE inputs:
   - From Explorer: experiment results and performance deltas
   - From AutoLoader: normalized traces and indexes
   - From Reviewer: scores, classifications, patterns
2. DETERMINE actions:
   - Which classifiers need retraining
   - Which knowledge base layers need updating
   - Whether to accept/reject Explorer experiments
3. EXECUTE classifier retraining:
   - Gate gate-engine classifiers (ML models for gate evaluation)
   - Pattern classifiers (failure pattern detection)
   - Performance predictors (expected execution time, success probability)
4. UPDATE embedding vectors:
   - Re-compute embeddings for knowledge_v4/stitch/ entries
   - Update knowledge_v4/invoke/ indexed patterns
   - Refresh knowledge_v4/aggregate/ metrics
5. WRITE knowledge base updates:
   - knowledge_v4/stitch/: New raw traces from AutoLoader
   - knowledge_v4/invoke/: Updated pattern classifications from Reviewer
   - knowledge_v4/aggregate/: New aggregate metrics
6. ACCEPT/REJECT Explorer experiments:
   - Accept experiments with > 5% performance improvement
   - Reject experiments with performance degradation
   - Flag neutral experiments for re-evaluation next cycle
7. LOG cycle results to db_v2.evolution_cycles
```

**Orchestrator Decision Matrix:**
| Reviewer Score | Explorer Result | Orchestrator Action |
|---------------|----------------|-------------------|
| Improving (Δ>0) | Accepted | Promote config changes, retrain classifiers |
| Improving (Δ>0) | Rejected | Retrain classifiers only |
| Declining (Δ<0) | Accepted | Reject experiment, rollback config |
| Declining (Δ<0) | Rejected | Deep investigation, alert operator |
| Stable (Δ≈0) | Accepted | Cautious promote, monitor next cycle |
| Stable (Δ≈0) | Rejected | No action |

---

## Cycle Lifecycle

### Full Daily Cycle
```
06:00:00 -- Cycle started
06:00:01 -- EXPLORER phase begins (deploy experiments)
07:00:01 -- EXPLORER phase ends, AUTOLOADER begins
07:05:00 -- AUTOLOADER phase ends (data loaded and normalized)
07:05:01 -- REVIEWER phase begins
07:15:00 -- REVIEWER phase ends (scores, classifications, patterns)
07:15:01 -- ORCHESTRATOR phase begins
07:30:00 -- ORCHESTRATOR phase ends (retraining, embeddings, KB updates)
07:30:01 -- Cycle logged to db_v2
07:30:05 -- Cycle complete
```

Total cycle time: ~90 minutes (Explorer: 60min, Analysis: ~30min)

---

## Data Flow Details

### db_v2 → AutoLoader
```
db_v2.pipeline_runs       --> Traces for last 24h
db_v2.gate_results        --> Per-gate pass/fail data
db_v2.degradations        --> Active degradation records
db_v2.daily_collections   --> Collection completion status
```

### AutoLoader → Reviewer
```
Normalized traces         --> {trace_id, store_id, gates[], status, ...}
Pattern candidates        --> Groups of similar failure sequences
Metrics                   --> Per-store and per-gate statistics
```

### Reviewer → Orchestrator
```
Scores                    --> Per-execution pass/fail scores
Classifications           --> Failure pattern assignments
Systemic issues           --> Cross-store pattern alerts
Metrics                   --> Aggregate success rates, trends
```

### Orchestrator → Outputs
```
db_v2.evolution_cycles    --> Cycle record (stores_processed, mutations_applied, ...)
knowledge_v4/stitch/      --> New raw trace files
knowledge_v4/invoke/      --> Updated pattern indexes
knowledge_v4/aggregate/   --> Updated aggregate metrics
Classifier models         --> Updated ML models
Embedding vectors         --> Updated embeddings
```

---

## Configuration

### Cron Schedule
```yaml
# ~/.hermes/profiles/default/cron/evolution_engine.yaml
schedule: "0 6 * * *"
command: "tkads:evolve:external"
description: "External evolution engine daily at 06:00"
enabled: true
```

### Engine Parameters
```python
# evolution-engine.py config section
EVOLUTION_ENGINE_CONFIG = {
    "enabled": True,
    "cycle_time": "06:00",
    "explorer": {
        "canary_ratio": 0.1,
        "evaluation_minutes": 60,
        "max_experiments": 5
    },
    "autoloader": {
        "lookback_hours": 24,
        "batch_size": 1000
    },
    "reviewer": {
        "min_pattern_support": 3,
        "score_weights": {
            "gate_pass_rate": 0.4,
            "execution_time": 0.3,
            "error_rate": 0.2,
            "degradation_impact": 0.1
        }
    },
    "orchestrator": {
        "min_improvement_threshold": 0.05,
        "max_rollback_age_hours": 72,
        "retrain_frequency_days": 1
    }
}
```

---

## Error Handling

### Explorer Errors
| Error | Action |
|-------|--------|
| Canary store offline | Skip, select next available store |
| Config deployment fails | Log error, continue with other experiments |
| Evaluation timeout | Use partial data, flag for re-evaluation |

### AutoLoader Errors
| Error | Action |
|-------|--------|
| db_v2 connection fails | Use last-known-good cached data |
| Trace file corrupted | Skip file, log path for manual review |
| Normalization fails | Store raw data, flag for manual processing |

### Reviewer Errors
| Error | Action |
|-------|--------|
| Classification timeout | Proceed with binary pass/fail only |
| Pattern detection fails | Use default patterns, alert operator |
| Score computation error | Use zero scores, continue with available data |

### Orchestrator Errors
| Error | Action |
|-------|--------|
| Classifier retrain fails | Keep previous classifier version |
| Embedding update fails | Keep previous embeddings |
| KB write fails | Buffer to local queue, retry at next cycle |

---

## Monitoring

### Commands
- `tkads:evolve:status` — Show last cycle metrics
- `tkads:evolve:external` — Trigger immediate external cycle

### Metrics
```json
// tkads:evolve:status response (evolution-engine section)
{
  "external": {
    "last_run": "2026-06-12T06:00:00Z",
    "duration_minutes": 91,
    "stores_processed": 12,
    "classifiers_retrained": 3,
    "embeddings_updated": 142,
    "patterns_classified": 18,
    "explorer_experiments": 5,
    "experiments_accepted": 2,
    "performance_delta": 0.03,
    "next_run": "2026-06-13T06:00:00Z",
    "errors": []
  }
}
```

### Logs
- `db_v2.evolution_cycles` — Complete cycle records
- `knowledge_v4/stitch/last_cycle.json` — Raw traces from last cycle
- `knowledge_v4/invoke/pattern_manifest.json` — Pattern classifications
- `knowledge_v4/aggregate/metrics.json` — Aggregate metrics
