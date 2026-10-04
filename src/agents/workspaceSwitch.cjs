// ADP-232-B — pure decision core for a LIVE workspace switch (restart-less).
//
// main.js owns the IO (validate the dir, persist settings, rebuild the reports
// watcher, emit `workspace:changed`); THIS module owns the state transition so the
// grandfather rule is node --test'able without electron. The rule:
//   • the PREVIOUS root is grandfathered — it stays in `activeRoots` (open panes /
//     running workers spawned there keep resolving their files + git) AND is recorded
//     in `grandfathered` (bookkeeping: "alive only because work still runs here");
//   • the NEXT root becomes the current base for every new relative-path resolution,
//     spawn cwd, memory/results dir and git diff.
// Switching to the SAME root, or a falsy root, is a no-op (never mutates the sets).

'use strict';

/**
 * @param {object}       p
 * @param {string|null}  p.current       current root (null = unconfigured / first-run)
 * @param {Set<string>}  p.activeRoots   roots the file/git guard accepts — MUTATED
 * @param {Set<string>}  p.grandfathered roots kept alive only for open work — MUTATED
 * @param {string}       p.next          validated new root (realpath + dir + not-in-bundle: caller's job)
 * @returns {{ changed: boolean, current: string|null, previous: string|null }}
 */
function applyWorkspaceSwitch({ current, activeRoots, grandfathered, next }) {
  if (!next || next === current) {
    return { changed: false, current: current ?? null, previous: current ?? null };
  }
  const previous = current ?? null;
  if (previous) {
    grandfathered.add(previous);
    activeRoots.add(previous); // idempotent — keeps grandfathered panes' access alive
  }
  activeRoots.add(next);
  return { changed: true, current: next, previous };
}

module.exports = { applyWorkspaceSwitch };
