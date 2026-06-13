#!/usr/bin/env node
/**
 * explorer.js — Hermes Evolution Engine: GitHub explorer
 *
 * Searches GitHub for trending tools/patterns related to AI agent skills,
 * rates them 1-10, and outputs findings with score >= 8 in Feishu-ready format.
 *
 * Usage:
 *   node explorer.js                # Normal run (fetches GitHub live)
 *   node explorer.js --dry-run      # Use cached/simulated data only
 *
 * Output: JSON array to stdout + human-readable summary to stderr
 * Cache: ~/.tkads/evolution/explorer_cache.json (TTL 24h)
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// ---- Constants ----
const CACHE_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '~', '.tkads', 'evolution');
const CACHE_FILE = path.join(CACHE_DIR, 'explorer_cache.json');
const TOKEN_FILE = path.join(CACHE_DIR, '..', '.ghtoken');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const QUERIES = [
  'agent skills',
  'spec driven development',
  'AI coding agent framework',
  'developer tools cli'
];

const SIMULATED_SKILLS_HUB = [
  {
    name: 'hermes-agent-skill-template',
    full_name: 'NousResearch/hermes-agent-skill-template',
    description: 'Template for creating spec-driven agent skills for Hermes Agent',
    html_url: 'https://github.com/NousResearch/hermes-agent-skill-template',
    stargazers_count: 142,
    pushed_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  },
  {
    name: 'spec-driven-agent',
    full_name: 'community/spec-driven-agent',
    description: 'Spec-driven development patterns for AI agent tooling',
    html_url: 'https://github.com/community/spec-driven-agent',
    stargazers_count: 89,
    pushed_at: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString(),
    updated_at: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString()
  },
  {
    name: 'mcp-server-boilerplate',
    full_name: 'mcp/mcp-server-boilerplate',
    description: 'Boilerplate for building MCP servers with spec-driven design patterns',
    html_url: 'https://github.com/mcp/mcp-server-boilerplate',
    stargazers_count: 320,
    pushed_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    updated_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()
  },
  {
    name: 'ai-coding-agent',
    full_name: 'tools/ai-coding-agent',
    description: 'AI coding agent framework with autonomous development capabilities',
    html_url: 'https://github.com/tools/ai-coding-agent',
    stargazers_count: 520,
    pushed_at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(),
    updated_at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
  },
  {
    name: 'devtools-cli',
    full_name: 'devtools/cli',
    description: 'Modern developer tools CLI for AI-assisted workflows',
    html_url: 'https://github.com/devtools/cli',
    stargazers_count: 60,
    pushed_at: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString(),
    updated_at: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString()
  }
];

// ---- Helpers ----

function httpsGet(url, token) {
  return new Promise((resolve, reject) => {
    const opts = {
      headers: {
        'User-Agent': 'Hermes-Evolution-Explorer/1.0',
        'Accept': 'application/vnd.github.v3+json'
      }
    };
    if (token) {
      opts.headers['Authorization'] = `token ${token}`;
    }
    https.get(url, opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 403) {
          const resetEpoch = parseInt(res.headers['x-ratelimit-reset'] || '0', 10);
          const remaining = parseInt(res.headers['x-ratelimit-remaining'] || '0', 10);
          reject(Object.assign(new Error(`Rate limited (${res.statusCode})`), {
            statusCode: 403,
            remaining,
            resetEpoch,
            body: data
          }));
          return;
        }
        if (res.statusCode >= 400) {
          reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { statusCode: res.statusCode, body: data }));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message}`));
        }
      });
    }).on('error', reject);
  });
}

function daysSince(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return Infinity;
  return Math.floor((Date.now() - d.getTime()) / (24 * 60 * 60 * 1000));
}

/**
 * Rate a repo finding on a scale of 1-10.
 * Formula:
 *   base = min(stars / 100, 5)
 *   freshness = days_since_update < 30 ? 2 : (days_since_update < 90 ? 1 : 0)
 *   keywords = fuzzy match in description (max +3)
 */
function rateFinding(repo) {
  const stars = repo.stargazers_count || repo.stars || 0;
  const updatedAt = repo.pushed_at || repo.updated_at || repo.date || '';
  const desc = (repo.description || repo.reason || '').toLowerCase();
  const fullName = (repo.full_name || repo.title || '').toLowerCase();
  const name = (repo.name || '').toLowerCase();

  // Base score: 0-5 from stars
  const base = Math.min(stars / 100, 5);

  // Freshness score
  const ds = daysSince(updatedAt);
  const freshness = ds < 30 ? 2 : (ds < 90 ? 1 : 0);

  // Keyword relevance (fuzzy match in description + name)
  const keywords = [
    'agent', 'skill', 'spec', 'mcp', 'llm', 'cli', 'tool',
    'framework', 'autonomous', 'coding', 'developer', 'assistant',
    'plugin', 'extension', 'workflow', 'pipeline', 'orchestration',
    'prompt', 'function calling', 'tool use'
  ];
  let keywordScore = 0;
  for (const kw of keywords) {
    if (desc.includes(kw) || fullName.includes(kw) || name.includes(kw)) {
      keywordScore += 0.3;
    }
  }
  keywordScore = Math.min(keywordScore, 3);

  // Bonus for matching query-specific terms
  const premiumTerms = ['spec-driven', 'spec driven', 'agent skill', 'agent framework', 'mcp server'];
  for (const pt of premiumTerms) {
    if (desc.includes(pt) || fullName.includes(pt)) {
      keywordScore = Math.min(keywordScore + 0.5, 3);
    }
  }

  const total = Math.round((base + freshness + keywordScore) * 10) / 10;
  return Math.min(Math.max(Math.round(total), 1), 10);
}

function buildFinding(repo, source) {
  const title = repo.full_name || repo.name || repo.title || 'Unknown';
  const url = repo.html_url || repo.url || '';
  const description = repo.description || repo.reason || '';
  const date = repo.pushed_at || repo.updated_at || repo.date || '';
  const stars = repo.stargazers_count || repo.stars || 0;
  const score = rateFinding(repo);
  const ds = daysSince(date);

  let reasonParts = [];
  if (stars > 0) reasonParts.push(`${stars} stars`);
  if (ds < 30) reasonParts.push('fresh (<30d)');
  else if (ds < 90) reasonParts.push('moderately recent (<90d)');
  else reasonParts.push(`last push ${ds}d ago`);
  const descPreview = description ? description.slice(0, 80) : '';
  if (descPreview) reasonParts.push(`"${descPreview}"`);

  return {
    title,
    url,
    score,
    reason: reasonParts.join('; '),
    source,
    date
  };
}

// ---- Cache ----

function loadCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
    const cached = JSON.parse(raw);
    if (Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.data;
    }
    return null;
  } catch {
    return null;
  }
}

function saveCache(data) {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ timestamp: Date.now(), data }, null, 2), 'utf-8');
  } catch (e) {
    console.error(`[cache] Warning: could not write cache: ${e.message}`);
  }
}

function getToken() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      return fs.readFileSync(TOKEN_FILE, 'utf-8').trim();
    }
  } catch {}
  return null;
}

// ---- GitHub Search ----

async function searchGitHub(query, token) {
  const encoded = encodeURIComponent(query);
  const url = `https://api.github.com/search/repositories?q=${encoded}&sort=stars&order=desc&per_page=10`;
  const result = await httpsGet(url, token);
  return (result.items || []).map(repo => ({
    ...repo,
    _query: query
  }));
}

// ---- Simulated Local Hub ----

function searchLocalHub() {
  return SIMULATED_SKILLS_HUB.map(repo => ({
    ...repo,
    _query: 'local-skills-hub'
  }));
}

// ---- Main ----

async function main() {
  const isDryRun = process.argv.includes('--dry-run');
  const token = getToken();

  if (!isDryRun && token) {
    console.error(`[auth] GitHub token found (${token.slice(0, 4)}...${token.slice(-4)})`);
  } else if (!isDryRun && !token) {
    console.error('[auth] No GitHub token found — running with reduced rate limits');
  }

  let findings = [];

  // 1. Try cache first
  const cached = loadCache();
  if (cached && !isDryRun) {
    console.error('[cache] Using cached results (TTL 24h)');
    findings = cached;
  } else {
    // 2. Simulated local hub (always available)
    console.error('[hub] Searching local skills hub...');
    const localResults = searchLocalHub();
    for (const repo of localResults) {
      findings.push(buildFinding(repo, 'local-skills-hub'));
    }

    // 3. GitHub search (skip in dry-run or if rate-limited)
    if (!isDryRun) {
      let allGithubResults = [];
      let rateLimited = false;

      for (const query of QUERIES) {
        if (rateLimited) {
          console.error(`[github] Skipping "${query}" (rate limited earlier)`);
          continue;
        }
        console.error(`[github] Searching: "${query}"`);
        try {
          const repos = await searchGitHub(query, token);
          allGithubResults = allGithubResults.concat(repos);
          // Polite delay between queries
          await new Promise(r => setTimeout(r, 500));
        } catch (err) {
          if (err.statusCode === 403) {
            console.error(`[github] Rate limited! ${err.message}`);
            if (err.resetEpoch) {
              const resetDate = new Date(err.resetEpoch * 1000);
              console.error(`[github] Resets at ${resetDate.toISOString()}`);
            }
            rateLimited = true;
          } else {
            console.error(`[github] Error: ${err.message}`);
          }
        }
      }

      // Deduplicate by full_name
      const seen = new Set();
      for (const repo of allGithubResults) {
        const key = repo.full_name || repo.id;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push(buildFinding(repo, `github:${repo._query}`));
      }

      // Save to cache (even if partially rate-limited)
      if (findings.length > 0) {
        saveCache(findings);
        console.error(`[cache] Saved ${findings.length} findings to cache`);
      }
    } else {
      console.error('[dry-run] Skipping live GitHub API calls');
    }
  }

  // 4. Filter high-scoring findings (>= 8)
  const highScorers = findings.filter(f => f.score >= 8)
    .sort((a, b) => b.score - a.score);

  // 5. Human-readable summary to stderr
  console.error('');
  console.error('='.repeat(60));
  console.error(`  Hermes Evolution Explorer — Summary`);
  console.error(`  Total findings: ${findings.length}`);
  console.error(`  High-scorers (>=8): ${highScorers.length}`);
  console.error('='.repeat(60));
  console.error('');

  if (highScorers.length === 0) {
    console.error('  No findings scored >= 8. Top 3 for reference:');
    const top3 = findings.sort((a, b) => b.score - a.score).slice(0, 3);
    for (const f of top3) {
      console.error(`    [${f.score}] ${f.title} — ${f.reason}`);
    }
  } else {
    for (const f of highScorers) {
      console.error(`  ⭐ [${f.score}/10] ${f.title}`);
      console.error(`     ${f.url}`);
      console.error(`     ${f.reason}`);
      console.error(`     source: ${f.source} | date: ${f.date}`);
      console.error('');
    }
  }

  // 6. Feishu-ready JSON output to stdout
  const output = {
    timestamp: new Date().toISOString(),
    total: findings.length,
    high_scorers: highScorers.length,
    findings: highScorers
  };
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');

  return output;
}

main().catch(err => {
  console.error(`[fatal] ${err.message}`);
  process.exit(1);
});
