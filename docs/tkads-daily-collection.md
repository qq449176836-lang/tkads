# TKADS Daily Collection (v4)

## Overview

The daily collection pipeline (`daily_collection.py`) is a cron-triggered process that runs at **07:00 daily**. It collects ad performance data from configured stores, applies the full gate pipeline, and logs results to `db_v2`.

---

## Flow Diagram

```
Cron (07:00)
    |
    v
daily_collection.py
    |
    +--> Read stores.json
    |       |
    |       +--> For each store:
    |               |
    |               +--> skip_today() check ------> Skip if already collected today
    |               |       |
    |               |       +--> query db_v2.daily_collections for today's date
    |               |       +--> if exists AND status != 'failed' → skip
    |               |
    |               +--> skip_existing() check ---> Skip if data already exists
    |               |       |
    |               |       +--> query store's output for current period
    |               |       +--> if data exists → skip
    |               |
    |               +--> config_chain.py resolve --> Resolved Config
    |               |
    |               +--> gate-engine evaluation ---> 7 gates
    |               |       |
    |               |       +--> all pass → proceed
    |               |       +--> gate fails → degrade-engine
    |               |
    |               +--> execute collection
    |               |
    |               +--> db_v2.log_collection() ---> Insert into daily_collections
    |
    +--> evolution-engine trigger ---> (if evolution day)
```

---

## config_chain.py Usage

The daily collection uses `config_chain.py` to resolve per-store configuration:

```python
from tkads_v4.config_chain import resolve_config

# Resolve configuration for a store
config = resolve_config("store_alpha")
# Returns:
#   Config(
#       source="facebook",
#       spu="spu-01",
#       collection_interval=3600,
#       max_retries=3,
#       freshness_window=86400,
#       api_endpoint="https://graph.facebook.com/v18.0/...",
#       credentials=<resolved_from_vault>
#   )
```

### Config Chain Steps
1. **Load** `stores.json` global defaults
2. **Apply** per-store overrides (merged on top of globals)
3. **Validate** schema (required fields, types, range checks)
4. **Resolve** environment variables and credential references
5. **Inject** computed fields (derived intervals, endpoint URLs)
6. **Return** immutable `Config` namedtuple

---

## db_v2.py Logging

All collection results are logged via `db_v2.py`:

### Insert Collection Record
```python
from tkads_v4.db_v2 import log_collection

log_collection(
    store_id="store_alpha",
    status="completed",       # 'completed' | 'failed' | 'skipped' | 'degraded'
    records_collected=1423,
    started_at=datetime.now(),
    finished_at=datetime.now()
)
```

### Query Collection Status
```python
from tkads_v4.db_v2 import get_collection_status

status = get_collection_status(store_id="store_alpha", date="2026-06-12")
# Returns: DailyCollection(store_id="store_alpha", status="completed", records_collected=1423, ...)
```

### Query All Stores for Today
```python
from tkads_v4.db_v2 import get_today_collections

collections = get_today_collections()
# Returns list of DailyCollection records for today
```

---

## Cron Trigger (07:00)

The daily collection is triggered by a cron job defined in the Hermes profile:

```yaml
# ~/.hermes/profiles/default/cron/daily_collection.yaml
schedule: "0 7 * * *"
command: "tkads:collection:run"
description: "Daily TKADS data collection at 07:00"
enabled: true
```

The cron job can also be triggered manually:
- **Hermes command:** `tkads:collection:run`
- **API:** `POST /api/v4/collection/run`

---

## Skip Logic

### skip_today()
Prevents collecting data for a store that has already been collected today.

```python
def skip_today(store_id: str) -> bool:
    """Check if collection already completed today for this store."""
    last = get_collection_status(store_id, date=today())
    if last and last.status != "failed":
        logger.info(f"Skipping {store_id}: already collected today ({last.status})")
        return True
    return False
```

**Edge cases:**
- If last collection was `failed`, re-attempt is allowed
- If last collection was `degraded`, re-attempt is allowed (previous run had partial data)
- If `status == "running"`, waits 60s and re-checks

### skip_existing()
Prevents collecting data that already exists in the store's output.

```python
def skip_existing(config: Config) -> bool:
    """Check if data for the current period already exists at the output."""
    existing = query_store_output(config)
    if existing and len(existing) > 0:
        logger.info(f"Skipping {config.store_id}: data already exists for current period")
        return True
    return False
```

**Edge cases:**
- Partial data (some records for period) → does NOT skip; continues with incremental sync
- Stale data (older than freshness window) → does NOT skip; triggers refresh
- Empty result from store → does NOT skip; proceeds with collection

---

## Collection Status Output

After collection, results are visible via:

```bash
# CLI
tkads:collection:status

# API response example:
# {
#   "date": "2026-06-12",
#   "stores": {
#     "store_alpha": {"status": "completed", "records": 1423},
#     "store_beta": {"status": "skipped", "reason": "already collected"},
#     "store_gamma": {"status": "failed", "error": "API quota exceeded"}
#   },
#   "total_stores": 10,
#   "collected": 8,
#   "skipped": 1,
#   "failed": 1,
#   "duration_seconds": 342
# }
```
