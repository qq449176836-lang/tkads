---
name: tkads-automation
description: >
  Ad automation skill for the v4 tkads system. Manages TikTok ad campaigns,
  creatives, stores, and configurations through a dual self-evolution architecture.
  Integrates stores.json-based profile management, a config-chain for hierarchical
  settings, and a four-engine pipeline (hook, gate, degrade, database v2) for
  resilient ad operations.
---

# tkads-automation (v4 Architecture)

## Overview

The v4 tkads system is a complete rewrite focused on **resilience, self-evolution, and modularity**. It replaces monolithic scripts with a pipeline architecture and introduces autonomous learning cycles.

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        tkads v4 System                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  [stores.json] ──→ [config-chain.js] ──→ [hook-engine.js]        │
│       │                  │                      │                │
│       │                  │                      ▼                │
│       │                  │              [gate-engine.js]         │
│       │                  │                      │                │
│       │                  │                      ▼                │
│       │                  │              [degrade-engine.js]      │
│       │                  │                      │                │
│       │                  │                      ▼                │
│       └──────────────────┴────────────── [db_v2.js]             │
│                                                                   │
│  ┌──────────────────┐    ┌─────────────────────────────────┐     │
│  │  Self-Evolve      │    │  Evolution Engine (daily 23:00) │     │
│  │  (every 2h)       │    │  explorer.js + autoloader.js   │     │
│  │  self-evolve.js   │    │  + reviewer.js + orchestrator  │     │
│  └──────────────────┘    └─────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────┘
```

## Core Components

### stores.json
- Central store registry mapping store IDs to profiles (name, group, region, platform, credentials)
- Managed via `tkads.store.*` commands
- Each store has an independent config chain and execution pipeline

### Config Chain (`config-chain.js`)
- Hierarchical configuration system: `defaults → store-group → store → runtime overrides`
- Supports environment-specific profiles (dev/staging/production)
- All modules resolve config through the chain; no hardcoded values

### Hook Engine (`hook-engine.js`)
- Pre- and post-execution hooks for every ad operation
- Hooks include: auth refresh, rate-limit check, budget validation, status logging
- Pluggable: custom hooks can be registered per store or per command

### Gate Engine (`gate-engine.js`)
- Decision gate for all API calls: checks account health, daily quota, cooldown periods
- Implements exponential backoff and circuit-breaker patterns
- Prevents cascading failures when TikTok API is throttled or down

### Degrade Engine (`degrade-engine.js`)
- Graceful degradation when dependencies fail
- Fallback strategies: cached results, mock responses (in dev), queued operations
- Maintains a `degrade_state.json` for system health awareness

### Database v2 (`db_v2.js`)
- SQLite-based logging and state persistence
- Replaces flat-file logging from v3
- Tables: operations_log, api_calls, errors, evolution_cycles, config_history

## Namespace Commands

All commands are under the `tkads.*` namespace:

| Command | Description |
|---|---|
| `tkads.ad.list [--store <id>]` | List ad campaigns with status filters |
| `tkads.ad.pause <ad-id>` | Pause an ad campaign |
| `tkads.ad.resume <ad-id>` | Resume a paused campaign |
| `tkads.ad.update <ad-id> <field> <value>` | Update ad campaign settings |
| `tkads.creative.list [--store <id>]` | List creatives per store |
| `tkads.creative.post <store-id> <creative-file>` | Upload new creative |
| `tkads.export <format> <scope>` | Export ad data (CSV/JSON) |
| `tkads.gmvrank [--period <d>]` | Show GMV rankings for active stores |
| `tkads.config [get|set|list]` | Read/write config chain values |
| `tkads.store.list` | List registered stores |
| `tkads.store.add <id> <name>` | Register a new store |
| `tkads.evolve.run` | Trigger evolution cycle manually |
| `tkads.status` | Show system health and pipeline status |

## Dual Self-Evolution

### Self-Evolve (every 2 hours) — `self-evolve.js`
- Analyzes recent API call results and error patterns
- Adjusts rate limits, retry strategies, and timing windows
- Writes improvements to `~/.tkads/evolution/`
- Updates knowledge base with learned patterns

### Evolution Engine (daily 23:00)
- **explorer.js**: Scans TikTok for new ad formats, targeting options, and best practices
- **autoloader.js**: Loads discovered patterns into the knowledge base
- **reviewer.js**: Validates new knowledge against historical performance data
- **orchestrator.js**: Coordinates the full daily cycle, generates evolution reports in `~/.tkads/evolution/reports/`

## Technology Stack

| Component | Technology |
|---|---|
| Runtime | Node.js (v18+) |
| Automation | Python 3.12 + AdsPower API + CDP |
| Database | SQLite (via better-sqlite3) |
| Scheduling | Cron expressions (self-evolve: `0 */2 * * *`, evolution: `0 23 * * *`) |
| API | TikTok Ads API (REST) |
| Auth | Token-based, refreshed via hook engine |

## Key Directories

| Path | Purpose |
|---|---|
| `~/.tkads/` | Root config, stores.json, secrets |
| `~/.tkads/evolution/` | Self-evolution configs and learned patterns |
| `~/.tkads/knowledge_v4/` | Knowledge base for evolution engine |
| `~/.tkads/evolution/reports/` | Daily evolution reports (JSON/MD) |
| `~/.tkads/logs/` | SQLite database and archived logs |

## Quick Reference

### Common Operations

```bash
# List all active ads across stores
tkads ad list --status ACTIVE

# Pause an underperforming campaign
tkads ad pause <ad-id>

# Check system health
tkads status

# Trigger evolution cycle (dry-run)
tkads evolve run --dry-run

# View current config
tkads config list

# Export yesterday's GMV rankings
tkads gmvrank --period 1d --format json
```

### First-Time Setup

1. Configure stores in `~/.tkads/stores.json`
2. Set TikTok API tokens per store
3. Run `tkads config set system.environment production`
4. Verify with `tkads status --verbose`
5. Evolution engine activates automatically after 24h

## Dependencies

- Node.js >= 18.0.0
- Python 3.12 with `requests`, `beautifulsoup4`, `pandas`
- SQLite 3.x
- AdsPower local API (port 50325)
- Chromium/Chrome for CDP-based browser automation

## Troubleshooting

| Symptom | Likely Cause | Resolution |
|---|---|---|
| `GATE_BLOCKED` | Rate limit hit | Wait for cooldown or adjust config |
| `HOOK_FAILED` | Auth token expired | Run `tkads config set store.<id>.auth.token <new-token>` |
| `DEGRADE_ACTIVE` | API unavailable | System is in fallback mode; check API status |
| Evolution not running | Cron misconfigured | Verify `crontab -l` entries for self-evolve and evolution-engine |
