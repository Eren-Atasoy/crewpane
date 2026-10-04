// ADP-136 (ADR-009) — department → tmux window auto-switch (best-effort).
//
// When Jarvis delegates to a team while the operator is on ANOTHER team's tmux
// window, switch the visible tmux window to the target team so the work is SEEN
// starting (Eren's req #2). Mirrors the spawn-worker routing (`~/bin/spawn-worker`,
// INFRA-01/02): the office "wing" department maps to a `crewpane` session window.
//
//   crewpane (Transformers) → adteam
//   chatflow  (Marvel HQ)    → agents
//   education (skool)        → skoolcommunity
//
// PURE `windowForDepartment` is unit-tested (no tmux). `selectWindowForDepartment`
// is a thin, best-effort shell: a missing tmux / session / window is a no-op (never
// throws), because the app must keep working when it isn't launched from tmux. The
// tmux binary + session are env-overridable so the e2e fixture can drive a fake.

'use strict';

const { spawnSync } = require('node:child_process');
const instancePaths = require('../config/instancePaths.cjs'); // ADP-206 — instance-scoped tmux session

/** Resolve the tmux binary (env override lets a test inject a fake). */
function tmuxBin() {
  return process.env.CREWPANE_TMUX_BIN || 'tmux';
}

/**
 * The tmux session the team windows live in. ADP-206 — instance-scoped via
 * instancePaths (PROD 'crewpane', DEV 'crewpane-dev') so a DEV launch never
 * selects/disturbs PROD's operator session. CREWPANE_TMUX_SESSION still overrides.
 */
function tmuxSession() {
  return instancePaths.tmuxSession();
}

// Office wing (agents.department) → tmux window name. Kept in sync with spawn-worker.
const DEPARTMENT_WINDOW = Object.freeze({
  crewpane: 'adteam',
  chatflow: 'agents',
  education: 'skoolcommunity',
});

/**
 * Map a department to its tmux window name. Known wings use the curated map; an
 * unknown department falls back to its own id (a team whose window is named after
 * it). Returns null for an empty/invalid department. Pure.
 */
function windowForDepartment(department) {
  const d = typeof department === 'string' ? department.trim().toLowerCase() : '';
  if (!d) return null;
  return DEPARTMENT_WINDOW[d] || d;
}

/**
 * Best-effort: switch the tmux session's active window to the team that owns
 * `department`. No-op (typed result, never throws) when tmux is absent, the session
 * is gone, or the window doesn't exist — the app isn't always launched from tmux.
 * @returns {{ ok: boolean, reason?: string, target?: string }}
 */
function selectWindowForDepartment(department, opts = {}) {
  const win = windowForDepartment(department);
  if (!win) return { ok: false, reason: 'no-department' };
  const session = opts.session || tmuxSession();
  const target = `${session}:${win}`;
  try {
    // Only switch if the window actually exists (avoid spurious tmux errors /
    // creating nothing). list-windows also confirms the session is reachable.
    const ls = spawnSync(tmuxBin(), ['list-windows', '-t', session, '-F', '#{window_name}'], {
      encoding: 'utf8',
    });
    if (ls.status !== 0) return { ok: false, reason: 'no-session', target };
    const names = String(ls.stdout || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!names.includes(win)) return { ok: false, reason: 'no-window', target };
    const r = spawnSync(tmuxBin(), ['select-window', '-t', target], { encoding: 'utf8' });
    return { ok: r.status === 0, target };
  } catch (err) {
    return { ok: false, reason: 'error', target, error: String((err && err.message) || err) };
  }
}

module.exports = {
  tmuxBin,
  tmuxSession,
  DEPARTMENT_WINDOW,
  windowForDepartment,
  selectWindowForDepartment,
};
