// CrewPane — ADP-089 (ADR-007 v2) pane→session registry.
//
// WHY (incident fix, requirement #5 cross-pane isolation): the ADP-088 daemon had
// no authoritative per-pane identity. It hardcoded engine='claude' and resolved a
// session id from `~/.claude/projects/<encoded-cwd>/<newest>.jsonl`. When the lead
// pane and a worker share the same cwd (both in crewpane/), "newest jsonl" can be
// the LEAD's live session — the exact cross-pane leak that nearly resumed Optimus.
//
// This registry is the authoritative source: a small JSON map written at spawn
// time (paneRef → { agentId, engine, cwd, sessionId }). When present, the daemon
// trusts it instead of guessing; a pane absent from the registry is treated with
// the safe fallbacks (engine inferred from limit phrasing, session resolved from
// jsonl ONLY when unambiguous — resumeTmux.resolveSessionIdFromJsonl).
//
// File: ~/.crewpane/pane-sessions.json (same dir as the resume-queue, ADR-004).
// PURE-ish: every fn takes an optional `homedir` so it is unit-testable on a tmp
// dir. Reads never throw (a bad file → empty map); writes are atomic (tmp+rename).
//
// Populated by: spawn-worker / spawnPty at spawn (recordPaneSession). Wiring those
// runners is a follow-up (spawn-worker lives outside crewpane/); until then the
// daemon's fallbacks keep it safe, and dry-run surfaces exactly what it resolved.

'use strict';

const os = require('node:os');
const fs = require('node:fs');
// ADP-835 (790 K1) — atomik yazımın rename adımı platform boğazından geçer:
// Windows'ta Defender/Search hedefi açık tutunca EPERM/EBUSY gelir ve bu çağrıların
// çoğu best-effort catch içinde OLDUĞU İÇİN kayıt SESSİZCE kaybolurdu.
const { renameWithRetrySync } = require('../../platform/atomicWrite.cjs');
const path = require('node:path');
const crypto = require('node:crypto');
const instancePaths = require('../config/instancePaths.cjs'); // ADP-206 — instance-scoped config dir

const REGISTRY_VERSION = 1;

/** Per-instance config dir (ADP-206): PROD ~/.crewpane, DEV ~/.crewpane-dev. */
function crewpaneDir(homedir) {
  return instancePaths.crewpaneHome(homedir);
}

/** Absolute path of the pane-session registry JSON. */
function registryPath(homedir) {
  return path.join(crewpaneDir(homedir), 'pane-sessions.json');
}

function emptyRegistry() {
  return { version: REGISTRY_VERSION, panes: {} };
}

/** Load the registry. Missing / corrupt / wrong-shape → empty (never throws). */
function loadRegistry(homedir) {
  try {
    const raw = fs.readFileSync(registryPath(homedir), 'utf8');
    const r = JSON.parse(raw);
    if (!r || typeof r !== 'object' || !r.panes || typeof r.panes !== 'object') {
      return emptyRegistry();
    }
    return { version: REGISTRY_VERSION, panes: r.panes };
  } catch {
    return emptyRegistry();
  }
}

/** Atomically persist (tmp+rename). Creates ~/.crewpane if needed. Returns path. */
function persist(reg, homedir) {
  const dir = crewpaneDir(homedir);
  fs.mkdirSync(dir, { recursive: true });
  const file = registryPath(homedir);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(
    tmp,
    JSON.stringify({ version: REGISTRY_VERSION, panes: reg.panes || {} }, null, 2),
  );
  renameWithRetrySync(tmp, file);
  return file;
}

/**
 * Authoritative info for a pane, or null if the pane is not registered. Shape:
 * { agentId, engine:'claude'|'codex', cwd, sessionId, updatedAt }.
 */
function lookupPane(paneRef, homedir) {
  if (typeof paneRef !== 'string' || !paneRef) return null;
  const reg = loadRegistry(homedir);
  const info = reg.panes[paneRef];
  return info && typeof info === 'object' ? info : null;
}

/**
 * Record (upsert) a pane's identity at spawn time. `engine` defaults to 'claude';
 * anything not 'codex' normalizes to 'claude'. Called by spawn-worker / spawnPty.
 */
function recordPaneSession(paneRef, info, homedir, now) {
  if (typeof paneRef !== 'string' || !paneRef) return null;
  const reg = loadRegistry(homedir);
  const i = info && typeof info === 'object' ? info : {};
  reg.panes[paneRef] = {
    agentId: typeof i.agentId === 'string' ? i.agentId : null,
    engine: i.engine === 'codex' ? 'codex' : 'claude',
    cwd: typeof i.cwd === 'string' ? i.cwd : null,
    sessionId: typeof i.sessionId === 'string' ? i.sessionId : null,
    updatedAt: Number.isFinite(now) ? now : Date.now(),
  };
  persist(reg, homedir);
  return reg.panes[paneRef];
}

/** Forget a pane (e.g. when its worker exits). Returns true if one was removed. */
function removePane(paneRef, homedir) {
  const reg = loadRegistry(homedir);
  if (!(paneRef in reg.panes)) return false;
  delete reg.panes[paneRef];
  persist(reg, homedir);
  return true;
}

module.exports = {
  REGISTRY_VERSION,
  crewpaneDir,
  registryPath,
  emptyRegistry,
  loadRegistry,
  persist,
  lookupPane,
  recordPaneSession,
  removePane,
};
