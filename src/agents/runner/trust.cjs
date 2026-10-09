'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { mkdirpSync } = require('../../../platform/mkdirp.cjs');
const { winSafeAtomicWrite } = require('./atomicFs.cjs');
const { engineCapability } = require('./registryBridge.cjs');

/**
 * ADP-283 — a trust key must be the CANONICAL path. macOS `/var`, `/tmp` are symlinks
 * into `/private/…`, and both CLIs canonicalize their cwd before looking the project up.
 */
function canonicalCwd(cwd) {
  try {
    return fs.realpathSync(cwd);
  } catch {
    return cwd;
  }
}

/** Pure: return a NEW config object with `cwd` marked trusted (merge, no clobber). */
function claudeTrustPatch(config, cwd) {
  const base = config && typeof config === 'object' ? config : {};
  const projects = base.projects && typeof base.projects === 'object' ? base.projects : {};
  const existing = projects[cwd] && typeof projects[cwd] === 'object' ? projects[cwd] : {};
  return {
    ...base,
    projects: {
      ...projects,
      [cwd]: { ...existing, hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
    },
  };
}

/** True if `cwd` is already marked trusted (lets callers skip a redundant write). */
function isClaudeTrusted(config, cwd) {
  return !!(
    config &&
    config.projects &&
    config.projects[cwd] &&
    config.projects[cwd].hasTrustDialogAccepted === true
  );
}

/**
 * Best-effort: ensure `~/.claude.json` marks `cwd` as trusted so an interactive
 * claude pane opens straight at the prompt.
 */
function ensureClaudeTrusted(cwd, homedir) {
  try {
    const home = homedir || os.homedir();
    const key = canonicalCwd(cwd);
    const cfgPath = path.join(home, '.claude.json');
    let config = {};
    try {
      config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    } catch {
      config = {};
    }
    if (isClaudeTrusted(config, key)) return true;
    const next = claudeTrustPatch(config, key);
    fs.writeFileSync(cfgPath, JSON.stringify(next, null, 2));
    return true;
  } catch {
    return false;
  }
}

const CODEX_TRUST_ENTRY = (cwd) => `\n[projects.${JSON.stringify(cwd)}]\ntrust_level = "trusted"\n`;

/** Pure: is `cwd` already a trusted project in this config.toml text? */
function codexIsTrusted(toml, cwd) {
  if (typeof toml !== 'string') return false;
  const header = `[projects.${JSON.stringify(cwd)}]`;
  const at = toml.indexOf(header);
  if (at === -1) return false;
  const rest = toml.slice(at + header.length);
  const end = rest.search(/\n\[/);
  const body = end === -1 ? rest : rest.slice(0, end);
  return /trust_level\s*=\s*"trusted"/.test(body);
}

/** Pure: config.toml text with `cwd` appended as a trusted project (no-op if present). */
function codexTrustPatch(toml, cwd) {
  const base = typeof toml === 'string' ? toml : '';
  if (codexIsTrusted(base, cwd)) return base;
  return `${base.replace(/\s*$/, '')}\n${CODEX_TRUST_ENTRY(cwd)}`;
}

/** Where codex reads its config: $CODEX_HOME, else ~/.codex. */
function codexHomeDir(env, homedir) {
  const fromEnv = env && typeof env.CODEX_HOME === 'string' && env.CODEX_HOME.trim();
  return fromEnv ? env.CODEX_HOME : path.join(homedir || os.homedir(), '.codex');
}

/**
 * Best-effort: mark `cwd` trusted in codex's config.toml so an interactive codex pane
 * opens straight at the composer.
 */
function ensureCodexTrusted(cwd, env, homedir) {
  try {
    const key = canonicalCwd(cwd);
    const dir = codexHomeDir(env, homedir);
    const cfgPath = path.join(dir, 'config.toml');
    let toml = '';
    try {
      toml = fs.readFileSync(cfgPath, 'utf8');
    } catch {
      toml = '';
    }
    if (codexIsTrusted(toml, key)) return true;
    mkdirpSync(dir);
    fs.writeFileSync(cfgPath, codexTrustPatch(toml, key));
    return true;
  } catch {
    return false;
  }
}

function applyEngineEnvConsent(env, d, homedir) {
  if (!env || !d || !Array.isArray(d.entries) || !d.entries.length) return false;
  const home = homedir || os.homedir();
  const fromEnv = d.homeEnv && typeof env[d.homeEnv] === 'string' && env[d.homeEnv].trim()
    ? path.join(env[d.homeEnv].trim(), ...(d.homeSegments || []))
    : null;
  const root = fromEnv || path.join(home, ...(d.homeFallback || []));
  let cfgText = '';
  if (d.preferUser && d.configFile) {
    try { cfgText = fs.readFileSync(path.join(root, d.configFile), 'utf8'); } catch { cfgText = ''; }
  }
  let applied = 0;
  for (const entry of d.entries) {
    if (!entry || typeof entry.env !== 'string' || !entry.env) continue;
    if (typeof env[entry.env] === 'string' && env[entry.env].trim()) continue;
    if (cfgText) {
      const safe = entry.env.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`^\\s*${safe}\\s*:`, 'm').test(cfgText)) continue;
    }
    env[entry.env] = String(entry.value);
    applied += 1;
  }
  return applied > 0;
}

function ensureStateFileTrusted(cwd, env, homedir, d) {
  if (!cwd || !d || !d.dir) return false;
  const home = homedir || os.homedir();
  const root =
    d.homeEnv && env && typeof env[d.homeEnv] === 'string' && env[d.homeEnv].trim()
      ? env[d.homeEnv].trim()
      : path.join(home, ...(d.homeFallback || []));
  try {
    const abs = path.resolve(cwd);
    const slug =
      path
        .basename(abs)
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40)
        .replace(/^-+|-+$/g, '') || 'workspace';
    const safeSlug = slug === '.' || slug === '..' ? 'workspace' : slug;
    const hash = crypto.createHash('sha256').update(abs).digest('hex').slice(0, 12);
    const dir = path.join(root, d.dir);
    const file = path.join(dir, `${d.keyPrefix || 'wd_'}${safeSlug}_${hash}`);
    if (fs.existsSync(file)) return true;
    fs.mkdirSync(dir, { recursive: true });
    winSafeAtomicWrite(file, JSON.stringify({ root: abs, trustedAt: Date.now() }));
    return true;
  } catch {
    return false;
  }
}

const TRUST_WRITERS = Object.freeze({
  json: (cwd, env, homedir) => ensureClaudeTrusted(cwd, homedir),
  'toml-append': (cwd, env, homedir) => ensureCodexTrusted(cwd, env, homedir),
  'state-file': (cwd, env, homedir, d) => ensureStateFileTrusted(cwd, env, homedir, d),
  'env-consent': (cwd, env, homedir, d) => applyEngineEnvConsent(env, d, homedir),
});

/**
 * `cwd`u bu motorun güven defterinde ONAYLI yap.
 */
function ensureEngineTrusted(engineId, cwd, env, homedir) {
  const d = engineCapability(engineId, 'trust');
  if (!d) return false;
  const writer = TRUST_WRITERS[d.kind];
  if (!writer) return false;
  return writer(cwd, env, homedir, d);
}

/**
 * Güven yazımı SPAWN KURULUMU sırasında mı yapılmalı?
 */
function trustWritesAtSpawn(engineId) {
  const d = engineCapability(engineId, 'trust');
  return !!(d && d.homeScope === 'engine-home');
}

/**
 * ENG-07 L2 — bu spawn için güven durumu.
 */
function planEngineTrust(engineId, cwd, env, homedir) {
  const d = engineCapability(engineId, 'trust');
  if (!d) return null;
  if (trustWritesAtSpawn(engineId)) {
    return { kind: d.kind, homeScope: d.homeScope, applied: true, ok: ensureEngineTrusted(engineId, cwd, env, homedir), pending: false };
  }
  return { kind: d.kind, homeScope: d.homeScope || 'user-home', applied: false, ok: null, pending: true };
}

module.exports = {
  canonicalCwd,
  claudeTrustPatch,
  isClaudeTrusted,
  ensureClaudeTrusted,
  CODEX_TRUST_ENTRY,
  codexIsTrusted,
  codexTrustPatch,
  codexHomeDir,
  ensureCodexTrusted,
  applyEngineEnvConsent,
  ensureStateFileTrusted,
  TRUST_WRITERS,
  ensureEngineTrusted,
  trustWritesAtSpawn,
  planEngineTrust,
};
