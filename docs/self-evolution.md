# Self-Evolution System

## Overview

TKADS v4 features a **dual self-evolution system** that continuously improves pipeline performance through automated mutation and retraining. The system combines a high-frequency internal cycle with a deep-analysis external cycle.

```
                    +-------------------------+
                    |    Dual Evolution       |
                    |                         |
            +-------v--------+    +----------v--------+
            | Internal       |    | External          |
            | self-evolve.js |    | evolution-engine  |
            | (2-hour cycle) |    | (daily cycle)     |
            +-------+--------+    +--------+----------+
                    |                       |
            +-------v--------+    +----------v--------+
            | Prompt/Agent   |    | Classifier/       |
            | Mutation       |    | Embedding Retrain |
            +-------+--------+    +--------+----------+
                    |                       |
                    +-----------+-----------+
                                |
                        +-------v--------+
                        | knowledge_v4/  |
                        | (all layers)   |
                        +----------------+
```

---

## Internal: self-evolve.js

**Cycle:** Every 2 hours
**Scope:** Prompt templates, agent behavior, execution logic
**Trigger:** Hermes cron schedule `0 */2 * * *`

### Process Flow

```
1. QUERY db_v2 for traces since last cycle
       |
2. SCORE each store's performance
   - Gate pass rate (gates_passed / gates_total)
   - Execution time (p95, p50)
   - Error rate (failed_runs / total_runs)
       |
3. IDENTIFY underperforming areas
   - Stores with < 80% gate pass rate
   - Prompt templates with > 20% error rate
   - Gates with > 50% failure rate
       |
4. ANALYZE prompt templates in hooks/
   - Parse all registered hook callables
   - Extract prompt strings and configuration
   - Score each prompt template:
     * Response quality (based on execution outcomes)
     * Consistency score (variance across runs)
     * Error correlation
       |
5. APPLY MUTATIONS to underperforming templates
   - Mutation types:
     a) Prompt rephrasing (paraphrase with preserved semantics)
     b) Threshold adjustment (tighten/loosen gate thresholds)
     c) Fallback modification (change degrade engine fallback config)
     d) Retry strategy change (adjust backoff params)
       |
6. VALIDATE mutations
   - Run test suite against mutated templates
   - Compare before/after scores
   - Reject mutations that degrade performance
       |
7. COMMIT validated mutations
   - Write new templates to hooks/ directory
   - Trigger hook engine reload
       |
8. LOG cycle results
   - stores_processed, mutations_applied
   - performance_delta (before/after aggregate score)
```

### Mutation Strategies

| Strategy | Target | Trigger | Rollback |
|----------|--------|---------|----------|
| Rephrase | Prompt text | Error rate > 20% | Previous template version |
| Threshold | Gate params | Gate fail rate > 50% | Original threshold |
| Fallback | Degrade config | Degrade trigger rate > 30% | Original fallback |
| Retry | Backoff params | API failures > 3 consecutive | Original backoff |

### Performance Scoring

```javascript
// self-evolve.js scoring logic (pseudocode)
function scoreStore(traces) {
    const gatePassRate = traces.filter(t => t.gates_passed === t.gates_total).length / traces.length;
    const execTimeScore = 1 - (p95ExecTime / maxAcceptableTime);
    const errorScore = 1 - (errorCount / traces.length);
    return (gatePassRate * 0.5) + (execTimeScore * 0.3) + (errorScore * 0.2);
}
```

---

## External: evolution-engine (Daily)

**Cycle:** Every day at 06:00
**Scope:** Classifiers, embeddings, knowledge base retraining
**Trigger:** `tkads:evolve:external` command or 06:00 cron

### Process Flow

```
1. EXPLORER phase
   - Deploy experimental configurations to canary stores
   - Monitor execution outcomes
   - Collect performance data
       |
2. AUTOLOADER phase
   - Load all execution traces from db_v2 (last 24h)
   - Parse knowledge_v4/stitch/ raw traces
   - Normalize into analysis format
       |
3. REVIEWER phase
   - Score each execution outcome
   - Classify gate failure patterns
   - Identify systemic issues
       |
4. ORCHESTRATOR phase
   - Aggregate findings from Explorer, AutoLoader, Reviewer
   - Determine which retraining actions to take
   - Update knowledge_v4/invoke/ and knowledge_v4/aggregate/
   - Retrain gate classifier models
   - Update embedding vectors in knowledge base
```

See [evolution-engine.md](./evolution-engine.md) for detailed specification.

---

## Interaction Between Cycles

```
Timeline:
   00:00 -- External cycle runs (analysis + retraining)
   02:00 -- Internal cycle (prompt mutation)
   04:00 -- Internal cycle
   06:00 -- External cycle + Internal
   08:00 -- Internal cycle
   10:00 -- Internal cycle
   12:00 -- Internal cycle
   14:00 -- Internal cycle
   16:00 -- Internal cycle
   18:00 -- External cycle + Internal
   20:00 -- Internal cycle
   22:00 -- Internal cycle

External cycles provide the foundation (classifiers, embeddings)
Internal cycles iterate on top (prompts, thresholds)
```

### Data Sharing

| Data | Produced By | Consumed By |
|------|-------------|-------------|
| Execution traces | Pipeline runs | Both |
| Gate pass rates | Pipeline runs | Internal |
| Classifier models | External | Gate engine |
| Embedding vectors | External | Knowledge base queries |
| Prompt templates | Internal | Hook engine |
| Performance scores | Both | Dashboard |

---

## Configuration

### self-evolve.js Configuration
```yaml
# ~/.hermes/profiles/default/cron/self_evolve.yaml
schedule: "0 */2 * * *"
command: "tkads:evolve:internal"
description: "Internal self-evolution every 2 hours"
enabled: true
```

### evolution-engine Configuration
```yaml
# ~/.hermes/profiles/default/cron/evolution_engine.yaml
schedule: "0 6 * * *"
command: "tkads:evolve:external"
description: "External evolution engine daily at 06:00"
enabled: true
```

---

## Monitoring

### Commands
- `tkads:evolve:status` — Show last cycle times and metrics
- `tkads:evolve:internal` — Trigger internal cycle immediately
- `tkads:evolve:external` — Trigger external cycle immediately

### Dashboard Metrics
```json
// tkads:evolve:status response
{
  "internal": {
    "last_run": "2026-06-12T04:00:00Z",
    "stores_processed": 12,
    "mutations_applied": 3,
    "performance_delta": 0.05,
    "next_run": "2026-06-12T06:00:00Z"
  },
  "external": {
    "last_run": "2026-06-12T06:00:00Z",
    "stores_processed": 12,
    "classifiers_retrained": 3,
    "embeddings_updated": 142,
    "next_run": "2026-06-13T06:00:00Z"
  }
}
```
