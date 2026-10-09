'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const envPath = require('../../../platform/envPath.cjs');
const { dirForDepartment } = require('../departmentDirs.cjs');
const { normalizeDepartment } = require('../teamResolve.cjs');
const instancePaths = require('../../config/instancePaths.cjs');
const crewpaneEnv = require('../../config/crewpaneEnv.cjs');
const { VENDOR_TELEMETRY_ENV_KEYS } = require('../../../telemetry/channel.cjs');

const MAX_ENV_KEYS = 64;

/** Validate a requested cwd; fall back to home if missing/not a directory. */
function sanitizeCwd(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return os.homedir();
  try {
    if (fs.statSync(cwd).isDirectory()) return cwd;
  } catch {
    /* not a usable dir */
  }
  return os.homedir();
}

/**
 * ADP-154 — resolve the spawn cwd so a delegated/office WORKER (an agent CLI) lands
 * in a real PROJECT tree, not HOME.
 */
function resolveCwd(opts, repoRoot, isAgent, deptMapping, log, taskWorktree) {
  // ── Kademe 0 (B-01) ──────────────────────────────────────────────────────
  if (typeof taskWorktree === 'string' && taskWorktree.length > 0) {
    try {
      if (fs.statSync(taskWorktree).isDirectory()) {
        if (typeof log === 'function') log(`resolveCwd: görev worktree'si kullanıldı → ${taskWorktree}`);
        return taskWorktree;
      }
      if (typeof log === 'function') log(`resolveCwd: taskWorktree DİZİN DEĞİL, yok sayıldı → ${taskWorktree}`);
    } catch {
      if (typeof log === 'function') log(`resolveCwd: taskWorktree YOK, yok sayıldı → ${taskWorktree}`);
    }
  }
  const cwd = opts && opts.cwd;
  if (typeof cwd === 'string' && cwd.length > 0) {
    try {
      if (fs.statSync(cwd).isDirectory()) return cwd;
    } catch {
      /* explicit cwd is gone — fall through to the department/root resolution */
    }
  }
  const root = typeof repoRoot === 'string' && repoRoot.length > 0 ? repoRoot : '';
  if (root && isAgent) {
    const dept = normalizeDepartment(opts && opts.department);
    return dirForDepartment(dept, root, deptMapping, log) || sanitizeCwd(cwd);
  }
  return sanitizeCwd(cwd);
}

const DEFAULT_LANG = 'en_US.UTF-8';

/** Bir locale değeri UTF-8 mi (büyük/küçük harf ve "UTF8" yazımı dahil)? */
function isUtf8Locale(v) {
  return typeof v === 'string' && /utf-?8/i.test(v);
}

/**
 * Çocuk env'inde UTF-8 locale garanti et (saf; env nesnesini KOPYALAMAZ, günceller).
 */
function ensureUtf8Locale(env) {
  const e = env && typeof env === 'object' ? env : {};
  if (e.LC_ALL !== undefined && !isUtf8Locale(e.LC_ALL)) e.LC_ALL = DEFAULT_LANG;
  if (!isUtf8Locale(e.LANG)) e.LANG = DEFAULT_LANG;
  if (!isUtf8Locale(e.LC_CTYPE)) e.LC_CTYPE = DEFAULT_LANG;
  return e;
}

/**
 * GUI apps on macOS inherit a truncated PATH (launchd, not a login shell), so a
 * direct `pty.spawn('claude', …)` can fail to find a Homebrew/npm-global binary.
 */
function augmentedPath(basePath, opts = {}) {
  return envPath.augment(basePath, { home: os.homedir(), ...opts, readRegistry: false });
}

const INHERITED_ENGINE_ENV = Object.freeze([
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_EFFORT',
  'CLAUDECODE',
]);

const PANE_SCOPED_ENV_BASES = Object.freeze([
  'LEADER_ID',
  'AGENT_ID',
  'DEPARTMENT',
  'BRIDGE_PORT',
  'BRIDGE_TOKEN',
  'BRIDGE_HOST',
  'HOST_PID',
  'PANE_PIDS',
]);
const PANE_SCOPED_ENV_KEYS = Object.freeze(crewpaneEnv.bothNamesAll(PANE_SCOPED_ENV_BASES));

const INTEGRATION_SECRET_ENV_PREFIX = 'CREWPANE_SECRET_';

const { setPathVar, getPathVar } = envPath;

function sanitizeEnv(extra, baseEnv) {
  const base = { ...(baseEnv || process.env) };
  for (const k of INHERITED_ENGINE_ENV) delete base[k];
  for (const k of PANE_SCOPED_ENV_KEYS) delete base[k];
  for (const k of Object.keys(base)) {
    if (k.startsWith(INTEGRATION_SECRET_ENV_PREFIX)) delete base[k];
  }
  for (const k of VENDOR_TELEMETRY_ENV_KEYS) delete base[k];
  const instancePins = crewpaneEnv.pinnedValuesPresent('INSTANCE', base);
  if (instancePins.length && instancePins.every((v) => instancePaths.normalize(v) === instancePaths.PROD)) {
    crewpaneEnv.dualDelete(base, 'INSTANCE');
  }
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
    let n = 0;
    for (const [k, v] of Object.entries(extra)) {
      if (n >= MAX_ENV_KEYS) break;
      if (typeof k === 'string' && typeof v === 'string' && k.length <= 256) {
        base[k] = v;
        n++;
      }
    }
  }
  setPathVar(base, augmentedPath(getPathVar(base)));
  ensureUtf8Locale(base);
  return base;
}

module.exports = {
  DEFAULT_LANG,
  isUtf8Locale,
  ensureUtf8Locale,
  augmentedPath,
  INHERITED_ENGINE_ENV,
  PANE_SCOPED_ENV_BASES,
  PANE_SCOPED_ENV_KEYS,
  INTEGRATION_SECRET_ENV_PREFIX,
  setPathVar,
  getPathVar,
  sanitizeEnv,
  sanitizeCwd,
  resolveCwd,
};
