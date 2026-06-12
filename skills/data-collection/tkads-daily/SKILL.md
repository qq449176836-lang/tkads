---
name: tkads-daily
description: >
  Daily data collection skill for TikTok ad platform. Uses config_chain.py
  for hierarchical configuration resolution and db_v2.py for structured
  SQLite-based logging. Implements namespace commands for streamlined
  daily ad operations and data export.
---

# tkads-daily

## Overview

tkads-daily is the daily data collection pipeline for TikTok ad operations. It collects campaign performance data, creative metrics, and account-level stats across all registered stores.

## Configuration

All configuration is resolved through **config_chain.py**, which implements a hierarchical chain:

```
defaults.conf → store-group.conf → store.conf → CLI overrides
```

### Configuration Namespace

| Key | Description | Default |
|---|---|---|
| `daily.collection.time` | Hour to run daily collection | `06:00` |
| `daily.collection.retention_days` | Days to retain raw data | `90` |
| `daily.export.format` | Default export format | `json` |
| `daily.export.path` | Export output directory | `~/.tkads/exports/` |
| `daily.rate_limit.max_requests` | Max API calls per run | `50` |
| `daily.rate_limit.cooldown_ms` | Cooldown between calls | `2000` |

### Using config_chain.py

```bash
# View current collection configuration
tkads config get daily.collection.time

# Override export format for a single run
tkads config set daily.export.format csv --ephemeral

# List all daily-related config keys
tkads config list --prefix daily
```

## Logging (db_v2.py)

All operations are logged to the SQLite database managed by `db_v2.py`:

- **operations_log**: Each daily collection run (start time, end time, stores collected, row count)
- **api_calls**: Individual API request/response records (endpoint, latency, status code)
- **errors**: Failed API calls with error codes and stack traces

### Querying Logs

```bash
# View last 5 collection runs
tkads log daily --limit 5

# Check for recent errors
tkads log errors --since 24h

# Full export of today's collection
tkads export json --scope daily
```

## Namespace Commands

| Command | Description |
|---|---|
| `tkads daily run` | Execute daily data collection |
| `tkads daily status` | Show last collection status |
| `tkads daily summary` | Generate daily summary report |
| `tkads export <format> [--scope]` | Export collected data |
| `tkads log daily [--limit N]` | View collection run logs |
| `tkads log errors [--since <period>]` | View recent errors |
| `tkads config [get|set|list]` | Manage config chain |

## Collection Pipeline

1. **Config Resolution**: Load settings via config_chain.py
2. **Auth Check**: Verify API tokens for all active stores
3. **Data Fetch**: Collect campaign stats, creative metrics, account balances
4. **Validation**: Sanity-check collected data (thresholds from config)
5. **Storage**: Write to SQLite via db_v2.py
6. **Export**: Generate exports in configured format

## Dependencies

- Python 3.12
- `config_chain.py` (in skill dependencies)
- `db_v2.py` (in skill dependencies)
- TikTok Ads API access
