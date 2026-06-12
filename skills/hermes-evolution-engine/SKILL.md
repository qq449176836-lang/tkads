---
name: hermes-evolution-engine
description: >
  Daily self-evolution engine for the tkads v4 system. Orchestrates autonomous
  ad strategy improvement through exploration, autoloading, review, and
  orchestration. Runs daily at 23:00, analyzing TikTok ad patterns and
  optimizing campaign configurations.
---

# hermes-evolution-engine

## Overview

The Evolution Engine is the autonomous learning heart of the tkads v4 system. It runs daily at **23:00** and follows a four-stage pipeline to discover, validate, and apply improvements to ad campaign strategies without human intervention.

### Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                   Evolution Engine (Daily 23:00)                  │
│                                                                   │
│   ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│   │  explorer.js  │───→│ autoloader.js│───→│  reviewer.js │      │
│   │  (Discover)   │    │  (Ingest)    │    │  (Validate)  │      │
│   └──────────────┘    └──────────────┘    └──────────────┘      │
│           │                    │                  │               │
│           ▼                    ▼                  ▼               │
│   ┌──────────────────────────────────────────────────────────┐   │
│   │                 orchestrator.js                          │   │
│   │  (Coordination, reporting, decision-making)             │   │
│   └──────────────────────────────────────────────────────────┘   │
│           │                                                       │
│           ▼                                                       │
│   ┌──────────────────────────────────────────────────────────┐   │
│   │              ~/.tkads/knowledge_v4/                       │   │
│   │  Updated patterns, strategies, and learned rules          │   │
│   └──────────────────────────────────────────────────────────┘   │
│                                                                   │
│   Complementary: self-evolve.js (every 2h — tactical tuning)     │
│   Evolution Engine (23:00 — strategic learning)                   │
└──────────────────────────────────────────────────────────────────┘
```

## Components

### explorer.js (Discovery Phase)
- Scrapes TikTok for new ad formats, targeting options, and creative trends
- Monitors competitor ad patterns via public feeds
- Analyzes TikTok's official best practices and changelogs
- Outputs raw findings to `~/.tkads/evolution/explorations/YYYY-MM-DD.json`

### autoloader.js (Ingestion Phase)
- Parses explorer.js output into structured knowledge entries
- Cross-references new findings with existing knowledge base
- Normalizes data into the knowledge_v4 schema
- Handles deduplication and versioning of entries
- Writes to `~/.tkads/knowledge_v4/patterns/` and `~/.tkads/knowledge_v4/strategies/`

### reviewer.js (Validation Phase)
- Validates new knowledge against historical campaign performance
- Runs A/B test simulations using stored operation logs
- Assigns confidence scores (0.0–1.0) to each knowledge entry
- Rejects entries below configurable confidence threshold (default: 0.7)
- Produces a validation report in `~/.tkads/evolution/reviews/`

### orchestrator.js (Coordination Phase)
- Coordinates the full pipeline: explorer → autoloader → reviewer
- Handles error recovery and partial-failure scenarios
- Generates the final evolution report with:
  - New patterns discovered
  - Patterns accepted/rejected
  - Confidence scores
  - Recommended config changes
- Applies high-confidence recommendations to config chain
- Archives report to `~/.tkads/evolution/reports/YYYY-MM-DD.md`

## Dual Self-Evolution System

| Aspect | self-evolve.js (Tactical) | Evolution Engine (Strategic) |
|---|---|---|
| **Frequency** | Every 2 hours | Daily at 23:00 |
| **Scope** | API tuning, rate limits, timing | Ad formats, targeting, creative strategy |
| **Input** | Recent API call results | External exploration + historical data |
| **Output** | Config adjustments | Knowledge base updates |
| **Risk** | Low (config only) | Medium (pattern changes) |

## Data Storage

| Path | Contents |
|---|---|
| `~/.tkads/evolution/` | Root evolution directory |
| `~/.tkads/evolution/explorations/` | Raw explorer findings (JSON) |
| `~/.tkads/evolution/reviews/` | Reviewer validation reports |
| `~/.tkads/evolution/reports/` | Orchestrator daily reports (MD) |
| `~/.tkads/knowledge_v4/` | Knowledge base root |
| `~/.tkads/knowledge_v4/patterns/` | Ad pattern knowledge entries |
| `~/.tkads/knowledge_v4/strategies/` | Campaign strategy entries |

## Usage

### Manual Trigger
```bash
# Full evolution cycle
tkads evolve run

# Dry-run (no changes applied, report only)
tkads evolve run --dry-run

# Run specific stage only
tkads evolve run --stage explorer

# View last evolution report
tkads evolve report --last
```

### Scheduled Run
The engine is triggered daily via cron at 23:00:
```cron
0 23 * * * cd ~/.tkads && node skills/hermes-evolution-engine/orchestrator.js >> ~/.tkads/logs/evolution.log 2>&1
```

### Report Format
Daily reports are generated as Markdown files:
```markdown
# Evolution Report — 2026-06-12

## New Patterns Discovered: 3
- Pattern: "Short-form video CTAs" (confidence: 0.92) — ACCEPTED
- Pattern: "Incentivized engagement ads" (confidence: 0.85) — ACCEPTED
- Pattern: "Long-tail keyword targeting" (confidence: 0.43) — REJECTED

## Config Changes Applied: 2
- daily.collection.time → 05:30 (better latency window)
- store.abc123.rate_limit.cooldown → 1500ms

## System Health: OK
```

## Dependencies

- Node.js >= 18.0.0
- Python 3.12 with `requests`, `beautifulsoup4`
- Access to TikTok public feeds
- SQLite (for reading operation logs via db_v2)
- `config-chain.js` (for applying config recommendations)

## Error Handling

| Scenario | Behaviour |
|---|---|
| explorer.js fails | Retry once after 60s; if still fails, skip exploration, use cached findings |
| autoloader.js finds duplicates | Merge metadata, increment version counter |
| reviewer.js confidence < threshold | Entry rejected, logged to rejections archive |
| orchestrator.js partial failure | Completed stages committed; failed stage reported |
| All stages fail | Report generated with error details, no knowledge changes |
