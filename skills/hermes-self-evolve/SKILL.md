---
name: hermes-self-evolve
description: >
  Internal self-evolution system for tkads automation. Orchestrates catalog
  health checks, auto-fix strategies, degrade-engine integration, and logging.
  Runs self-evolve.js which calls catalog-check.js, attempts auto-fixes for
  missing scripts/paths, stale logs, and version drift, and logs results to
  operation_log_v2 with alert escalation for unfixable issues.
version: "1.0"
author: tkads-system
---

# hermes-self-evolve

Internal self-evolution skill for the tkads ad automation system.

## What It Does

- **Catalog Health Checks:** Runs `catalog-check.js` against
  `tkads-catalog.json` to validate script files exist, commands are registered
  in `tkads.js`, database files are present, and versioned engine files match.
- **Auto-Fix Strategies:** Attempts to repair detected issues:
  - Missing script `path` or `script_real` entries -> searches `~/.tkads/`,
    `~/.hermes/scripts/`, and other locations, updates catalog.json with the
    correct relative path.
  - Constitution / gate sync -> injects missing gate names into
    `stores.json.enabled_by_default` if derived from `constitution.rules`.
  - Stale log purge -> deletes operation_log_v2 entries > 90 days old
    (preserving ERROR/BLOCKED status).
  - Version drift sync -> reads version strings from actual files and updates
    `catalog.json.versions`.
- **Degrade Engine Integration:** If unfixable issues remain after all
  strategies, an alert is dispatched via webhook (read from
  `~/.hermes/scripts/.alert_webhook`). Status is also logged to
  `operation_log_v2` with `OK` / `ERROR` / `BLOCKED` for downstream gate
  consumers (`catalog_health` gate).
- **Cron Integration:** Designed to be triggered every 2 hours via
  `cron-guardian` (Hermes cron system).

## How to Trigger

```bash
node ~/.tkads/self-evolve.js
```

### Options

| Flag | Description |
|------|-------------|
| `--check-only` | Only run catalog checks, skip fixes |
| `--fix-only`   | Skip checks, only run fix strategies |
| `--verbose` / `-v` | Verbose output showing all checks |
| `--dry-run`    | Show what would be done without making changes |
| `--status`     | Print JSON status summary and exit |

## Related Gates

- `catalog_health` -- enabled by default in `stores.json.gates.enabled_by_default`.
  Blocked when self-evolve reports unfixable issues.

## Schedule

Recommended: every **2 hours** via Hermes cron-guardian.

```cron
*/120 * * * * node ~/.tkads/self-evolve.js
```

## Files

- `~/.tkads/self-evolve.js` -- Main orchestrator
- `~/.tkads/catalog-check.js` -- Catalog health checker
- `~/.tkads/stores.json` -- Master config (gates, constitution, store defs)
- `~/.tkads/tkads-catalog.json` -- Versioned catalog registry
- `~/.hermes/scripts/.alert_webhook` -- Optional webhook URL file
