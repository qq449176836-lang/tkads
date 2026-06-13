#!/usr/bin/env node
/**
 * Hermes Evolution Engine — Autoloader
 * 
 * Tracks Hermes skill/feature usage and auto-promotes high-frequency
 * skills to "always_on" load state. Generates autoload shell scripts
 * for session initialization.
 *
 * Usage: node autoloader.js [--dry-run] [--status]
 *   --dry-run: show what would change without modifying files
 *   --status : show current usage stats
 *   --track <event> <skill_id>: record a usage event for a skill
 *
 * Events:
 *   after:collect   — data collection done
 *   after:report    — daily report sent
 *   after:create_ad — ad created
 *   after:update_roi — ROI updated
 *   after:pause_ad  — ad paused
 *   after:evolve    — self-evolution cycle
 */

const fs = require('fs');
const path = require('path');

// ── Config ──────────────────────────────────────────────────────────────────

const EVOLUTION_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || '.',
  '.tkads',
  'evolution'
);
const USAGE_FILE = path.join(EVOLUTION_DIR, 'usage.json');
const AUTOLOAD_SCRIPT = path.join(EVOLUTION_DIR, 'autoload.sh');

const SCHEMA_VERSION = '1.0';
const AUTO_LOAD_THRESHOLD = 10;       // usage_count >= 10 → auto-load
const RECENT_DAYS = 3;                // used within last 3 days → auto-load
const DEPRECATION_DAYS = 30;          // not used in 30+ days → flag for deprecation

const VALID_EVENTS = [
  'after:collect',
  'after:report',
  'after:create_ad',
  'after:update_roi',
  'after:pause_ad',
  'after:evolve',
];

// ── Helpers ─────────────────────────────────────────────────────────────────

function today() {
  const d = new Date();
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function daysSince(dateStr) {
  const then = new Date(dateStr);
  const now = new Date();
  return Math.floor((now - then) / (1000 * 60 * 60 * 24));
}

function dateFromDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function log(msg) {
  console.log(`[autoloader] ${msg}`);
}

function warn(msg) {
  console.warn(`[autoloader] WARNING: ${msg}`);
}

// ── Data Layer ──────────────────────────────────────────────────────────────

function loadUsage(createIfMissing = true) {
  let data = null;

  if (fs.existsSync(USAGE_FILE)) {
    try {
      const raw = fs.readFileSync(USAGE_FILE, 'utf-8');
      data = JSON.parse(raw);
    } catch (err) {
      warn(`Failed to parse ${USAGE_FILE}: ${err.message}. Reinitializing.`);
      data = null;
    }
  }

  if (!data && createIfMissing) {
    data = {
      schema_version: SCHEMA_VERSION,
      updated_at: today(),
      skills: {},
      auto_load_list: [],
    };
    log('Created new usage database.');
  }

  return data;
}

function saveUsage(data) {
  data.updated_at = today();
  // Ensure directory exists
  if (!fs.existsSync(EVOLUTION_DIR)) {
    fs.mkdirSync(EVOLUTION_DIR, { recursive: true });
  }
  fs.writeFileSync(USAGE_FILE, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

function ensureSkill(data, skillId, skillName) {
  if (!data.skills[skillId]) {
    data.skills[skillId] = {
      name: skillName || skillId,
      usage_count: 0,
      last_used: null,
      auto_load: false,
      hooks_required: [],
    };
  }
  return data.skills[skillId];
}

// ── Core Logic ──────────────────────────────────────────────────────────────

/**
 * Evaluate all skills and promote those meeting auto-load criteria.
 * Returns a list of changes made (for --dry-run).
 */
function evaluateAutoLoad(data, dryRun = false) {
  const changes = [];

  for (const [skillId, skill] of Object.entries(data.skills)) {
    const shouldAutoLoad = shouldPromoteToAutoLoad(skill);

    if (shouldAutoLoad && !skill.auto_load) {
      if (!dryRun) {
        skill.auto_load = true;
      }
      changes.push({
        action: 'promote',
        skill_id: skillId,
        name: skill.name,
        reason: reasonForPromotion(skill),
      });
    } else if (!shouldAutoLoad && skill.auto_load) {
      // Demote if no longer meeting criteria (only if it was previously auto)
      // Check if it was manually set — we don't demote manual ones without
      // strong evidence. But if usage is 0 and never used, we can demote.
      if (skill.usage_count === 0 && !skill.last_used) {
        if (!dryRun) {
          skill.auto_load = false;
        }
        changes.push({
          action: 'demote',
          skill_id: skillId,
          name: skill.name,
          reason: 'No usage history',
        });
      }
    }
  }

  // Rebuild auto_load_list from skills flagged auto_load
  const newAutoLoadList = Object.entries(data.skills)
    .filter(([_, s]) => s.auto_load)
    .map(([id, _]) => id);

  if (!dryRun) {
    data.auto_load_list = newAutoLoadList;
  }

  return { changes, auto_load_list: newAutoLoadList };
}

function shouldPromoteToAutoLoad(skill) {
  if (skill.auto_load) return true; // already promoted
  if (skill.usage_count >= AUTO_LOAD_THRESHOLD) return true;
  if (skill.last_used) {
    const days = daysSince(skill.last_used);
    if (days <= RECENT_DAYS) return true;
  }
  return false;
}

function reasonForPromotion(skill) {
  if (skill.usage_count >= AUTO_LOAD_THRESHOLD) {
    return `usage_count=${skill.usage_count} >= ${AUTO_LOAD_THRESHOLD}`;
  }
  if (skill.last_used) {
    const days = daysSince(skill.last_used);
    if (days <= RECENT_DAYS) {
      return `last_used ${days} day(s) ago (within ${RECENT_DAYS} day window)`;
    }
  }
  return 'unknown';
}

/**
 * Find skills that haven't been used in DEPRECATION_DAYS+ days.
 */
function findDeprecatedCandidates(data) {
  const candidates = [];
  const cutoff = dateFromDaysAgo(DEPRECATION_DAYS);

  for (const [skillId, skill] of Object.entries(data.skills)) {
    if (!skill.last_used) continue;
    const days = daysSince(skill.last_used);
    if (days >= DEPRECATION_DAYS) {
      candidates.push({
        skill_id: skillId,
        name: skill.name,
        days_since_use: days,
        last_used: skill.last_used,
        usage_count: skill.usage_count,
        flagged_for_deprecation: true,
      });
    }
  }

  return candidates;
}

/**
 * Record a usage event for a skill.
 */
function trackEvent(data, eventName, skillId, skillName) {
  if (!VALID_EVENTS.includes(eventName)) {
    warn(`Unknown event "${eventName}". Valid events: ${VALID_EVENTS.join(', ')}`);
    return false;
  }

  const skill = ensureSkill(data, skillId, skillName);
  skill.usage_count = (skill.usage_count || 0) + 1;
  skill.last_used = today();

  // Track which hooks this skill uses
  if (!skill.hooks_required) {
    skill.hooks_required = [];
  }
  if (!skill.hooks_required.includes(eventName)) {
    skill.hooks_required.push(eventName);
  }

  log(`Recorded "${eventName}" for "${skill.name}" (${skillId}) — total: ${skill.usage_count}`);
  return true;
}

// ── Script Generation ───────────────────────────────────────────────────────

function generateAutoLoadScript(autoLoadList, skills) {
  let lines = [
    '#!/usr/bin/env bash',
    '# Auto-generated by autoloader.js',
    `# Generated: ${today()}`,
    `# Skills to load on session start:`,
  ];

  for (const skillId of autoLoadList) {
    const skill = skills[skillId];
    const desc = skill ? ` — ${skill.name}` : '';
    lines.push(`#   ${skillId}${desc}`);
  }

  lines.push('');
  lines.push('# Load each skill');
  for (const skillId of autoLoadList) {
    lines.push(`hermes skill load --id "${skillId}" 2>/dev/null || echo "[autoload] Failed to load ${skillId}"`);
  }

  return lines.join('\n') + '\n';
}

function writeAutoLoadScript(data) {
  const content = generateAutoLoadScript(data.auto_load_list, data.skills);
  fs.writeFileSync(AUTOLOAD_SCRIPT, content, 'utf-8');
  // Make executable on Unix-like systems
  try {
    fs.chmodSync(AUTOLOAD_SCRIPT, '755');
  } catch (_) {
    // Windows may not support chmod; ignore
  }
  log(`Generated ${AUTOLOAD_SCRIPT} with ${data.auto_load_list.length} skill(s).`);
}

// ── Status Report ───────────────────────────────────────────────────────────

function printStatus(data) {
  const skills = Object.keys(data.skills);

  console.log('\n========================================');
  console.log('  Hermes Autoloader — Status Report');
  console.log('========================================\n');

  console.log(`Schema version : ${data.schema_version}`);
  console.log(`Last updated   : ${data.updated_at}`);
  console.log(`Total skills   : ${skills.length}`);
  console.log(`Auto-load list : ${data.auto_load_list.length} skill(s)\n`);

  if (skills.length === 0) {
    console.log('  (no skills tracked yet)\n');
    return;
  }

  // Sort by usage_count descending
  const sorted = skills
    .map(id => ({ id, ...data.skills[id] }))
    .sort((a, b) => (b.usage_count || 0) - (a.usage_count || 0));

  console.log('Skills:\n');
  for (const s of sorted) {
    const autoLoadFlag = s.auto_load ? ' [AUTO-LOAD]' : '';
    const deprecationFlag = s.last_used && daysSince(s.last_used) >= DEPRECATION_DAYS
      ? ' [DEPRECATED]'
      : '';
    const hooks = (s.hooks_required && s.hooks_required.length > 0)
      ? ` hooks:${s.hooks_required.join(',')}`
      : '';
    const daysAgo = s.last_used ? ` (${daysSince(s.last_used)}d ago)` : ' (never)';
    console.log(`  ${s.id}${autoLoadFlag}${deprecationFlag}`);
    console.log(`    Name        : ${s.name}`);
    console.log(`    Usage       : ${s.usage_count}${daysAgo}`);
    if (hooks) console.log(`    Hooks       : ${hooks}`);
    console.log();
  }

  // Deprecation candidates
  const deprecated = findDeprecatedCandidates(data);
  if (deprecated.length > 0) {
    console.log(`Skills flagged for deprecation (not used in ${DEPRECATION_DAYS}+ days):\n`);
    for (const d of deprecated) {
      console.log(`  ${d.skill_id} — ${d.name}`);
      console.log(`    Last used: ${d.last_used} (${d.days_since_use} days ago)`);
      console.log(`    Total uses: ${d.usage_count}`);
      console.log();
    }
  }

  console.log('========================================\n');
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const isDryRun = args.includes('--dry-run');
  const isStatus = args.includes('--status');

  // Handle --track <event> <skill_id> [skill_name]
  const trackIdx = args.indexOf('--track');
  if (trackIdx !== -1 && args.length > trackIdx + 2) {
    const event = args[trackIdx + 1];
    const skillId = args[trackIdx + 2];
    const skillName = args[trackIdx + 3] || null;

    const data = loadUsage(true);
    trackEvent(data, event, skillId, skillName);
    evaluateAutoLoad(data, false);
    saveUsage(data);
    writeAutoLoadScript(data);
    log('Tracking complete.');
    return;
  }

  // Load data
  const data = loadUsage(true);
  let needsSave = false;

  // Evaluate auto-load candidates
  if (isDryRun) {
    const { changes, auto_load_list } = evaluateAutoLoad(data, true);
    log(`DRY RUN — no files modified.\n`);

    if (changes.length === 0) {
      log('No changes needed. All skills already meet criteria.');
    } else {
      for (const c of changes) {
        const emoji = c.action === 'promote' ? '⬆' : '⬇';
        log(`${emoji} ${c.action}: ${c.skill_id} — ${c.reason}`);
      }
      log(`\nWould set auto_load_list = ${JSON.stringify(auto_load_list)}`);
    }
  } else {
    const { changes } = evaluateAutoLoad(data, false);

    if (changes.length > 0) {
      needsSave = true;
      for (const c of changes) {
        const emoji = c.action === 'promote' ? '⬆' : '⬇';
        log(`${emoji} ${c.action}: ${c.skill_id} — ${c.reason}`);
      }
    }
  }

  // Detect deprecated skills
  const deprecated = findDeprecatedCandidates(data);
  if (deprecated.length > 0 && !isDryRun) {
    log(`Found ${deprecated.length} skill(s) not used in ${DEPRECATION_DAYS}+ days:`);
    for (const d of deprecated) {
      log(`  ⚠  ${d.skill_id} — last used ${d.days_since_use} days ago`);
    }
  }

  // Save and generate script
  if (!isDryRun && needsSave) {
    saveUsage(data);
    writeAutoLoadScript(data);
  } else if (!isDryRun && !needsSave) {
    // Still refresh the auto-load script (might have new skills added by --track)
    writeAutoLoadScript(data);
  }

  // Print status if requested
  if (isStatus) {
    printStatus(data);
  }

  log('Done.');
}

// ── Entry ───────────────────────────────────────────────────────────────────

if (require.main === module) {
  main();
}

module.exports = {
  loadUsage,
  saveUsage,
  evaluateAutoLoad,
  findDeprecatedCandidates,
  trackEvent,
  generateAutoLoadScript,
  shouldPromoteToAutoLoad,
  AUTO_LOAD_THRESHOLD,
  RECENT_DAYS,
  DEPRECATION_DAYS,
  VALID_EVENTS,
};
