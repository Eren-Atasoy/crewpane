// ADP-154 — department → PROJECT DIRECTORY mapping (the spawn-cwd sibling of
// tmuxWindows.DEPARTMENT_WINDOW, which maps department → tmux window).
//
// THE BUG THIS CLOSES: a delegated/office worker pane was spawned with no cwd, so
// agentRunner.sanitizeCwd fell back to `os.homedir()` → the worker opened in $HOME.
// Its task used REPO-RELATIVE paths (`git`, `docs/agent-results/`, `supabase/
// migrations/`) which then resolved under HOME and fell on the floor: the leader
// saw a "done" status but 0 result files. A "done" marker is NOT proof — the file
// landing in the right tree is. ([[delegate-spawns-wrong-cwd]])
//
// So a delegated/office worker MUST land in a real project tree. The office wings
// map to the CrewPane project dirs under (or next to) the workspace root:
//   crewpane → <root>                              (unchanged — delegation/evidence
//                                                    akışı bu davranışa göre çalışıyor)
//   chatflow  → <root>/chatflow  (else <root>/../chatflow)
//   education → <root>/skool     (else <root>/../skool — skool community workspace)
// Default (unknown/empty department) → root. HOME is NEVER a default here.
//
// Pure (node builtins only, no Electron) so agentRunner.test.cjs can exercise it.

'use strict';

const path = require('node:path');
const fs = require('node:fs');

// Office wing (agents.department) → project dir name RELATIVE to the root. Kept in
// sync with tmuxWindows.DEPARTMENT_WINDOW (same three wings). Only the DIRECTORY
// PATH is referenced — this util never reads or writes their files.
//
// ADP-502 — the old map hopped a level up (['..', 'skool']), assuming the root it
// gets is the crewpane CHECKOUT. But the root threaded in from main.js is
// `agentWorkspaceRoot` (settings.workspaceRoot), which in real installs is the
// WORKSPACE PARENT ("CrewPane Apps") — the hop then landed one level too high
// (".../Downloads/skool", absent) and every education worker silently degraded to
// the root (canlı kanıt: live-panes.json'da tüm pane'ler aynı cwd). The project
// dirs are now probed DIRECTLY under the root first; the legacy sibling hop is
// kept as a fallback candidate for installs where the root IS the crewpane repo.
const DEPARTMENT_SUBPATH = Object.freeze({
  crewpane: [],
  chatflow: ['chatflow'],
  education: ['skool'],
});

// ADP-234 — a user-configurable `settings.departmentDirs` mapping overrides the
// built-in CrewPane sibling layout above. Shape: { "<department>": "<path>" } where
// the path is either ABSOLUTE or RELATIVE to the workspace root. Only string→string
// entries are honored; anything else means "no override for that department".
function mappedSubpath(mapping, department) {
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) return undefined;
  const v = mapping[department];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

/**
 * Resolve a department to its project directory, anchored at `repoRoot` (main.js
 * passes its authoritative workspace root). An unknown or empty department falls
 * back to `repoRoot`. A candidate dir is used only if it actually exists on this
 * machine; otherwise we still return `repoRoot` (a real tree) rather than HOME.
 * Returns null only when no usable root can be derived. Pure.
 *
 * ADP-502 — candidate probe: `<root>/<sub>` first (root = workspace parent, the
 * real install), then the legacy `<root>/../<sub>` sibling hop (root = crewpane
 * checkout). First existing directory wins; none → `repoRoot`, and the silent
 * fallback is now REPORTED via `log` (it used to swallow the miss with no trace —
 * education workers degraded to the root for weeks unnoticed).
 *
 * ADP-234 — optional `mapping` (settings.departmentDirs, main-sourced) replaces the
 * built-in CrewPane layout per department: a relative value resolves against
 * `repoRoot`, an absolute value is used as-is. A department absent from the mapping
 * (or an invalid mapping) falls back to the built-in DEPARTMENT_SUBPATH — so with no
 * setting the behavior is bit-for-bit the pre-ADP-234 one. The existing-dir guard
 * applies to mapped paths too: a missing target still degrades to `repoRoot`, never HOME.
 *
 * `log` (optional): a `(line: string) => void` sink (main.js's logLine). No-op when
 * absent so the module stays pure for tests.
 */
function dirForDepartment(department, repoRoot, mapping, log) {
  const logLine = typeof log === 'function' ? log : () => {};
  const root =
    typeof repoRoot === 'string' && repoRoot.length > 0 ? repoRoot : process.cwd();
  if (!root) return null;
  const d = typeof department === 'string' ? department.trim().toLowerCase() : '';
  const mapped = mappedSubpath(mapping, d);
  const candidates = [];
  if (mapped) {
    const target = path.isAbsolute(mapped) ? path.normalize(mapped) : path.resolve(root, mapped);
    if (path.resolve(target) === path.resolve(root)) return root;
    candidates.push(target);
  } else {
    const sub = DEPARTMENT_SUBPATH[d];
    if (!sub || sub.length === 0) return root; // crewpane / unknown / empty → repo root
    // Direct child of the root first, legacy sibling hop second (ADP-502).
    candidates.push(path.resolve(root, ...sub), path.resolve(root, '..', ...sub));
  }
  for (const target of candidates) {
    try {
      if (fs.statSync(target).isDirectory()) return target;
    } catch {
      /* candidate not present here — try the next, then the repo root, never HOME */
    }
  }
  logLine(
    `dirForDepartment: dept='${d}' → root fallback (${root}); ` +
      `hiçbir aday dizin yok: ${candidates.join(' | ')}`,
  );
  return root;
}

module.exports = { DEPARTMENT_SUBPATH, dirForDepartment };
