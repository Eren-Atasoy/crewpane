// CrewPane — TASK-MRDXOGZJDQLJG (ADP-REGISTRY-WIPE) quit-aware explicit pane kill.
//
// WHY: the `pty:kill` IPC handler treated EVERY kill as "the user deliberately
// closed this pane" and erased its live-pane registry entry (ADP-192 restart-resume
// data). But a pty:kill can also land WHILE THE APP IS QUITTING — e.g. the
// renderer's pane recycler kills a "vanished" pane racing the teardown (the
// 2026-07-09 22:50 self-update wiped live-panes.json exactly this way: the app was
// TERM'd mid-flight and the restart found an empty registry → zero panes resumed).
// A kill that arrives mid-quit is NOT an intentional close; it must behave like the
// killAllPtys teardown path: kill the child, KEEP the registry entry (preserve).
//
// Its own module (main.overlay.test.cjs pattern) so `node --test` can prove both
// branches without booting Electron; main.js passes the live collaborators.

'use strict';

/**
 * Execute an EXPLICIT pane kill (the `pty:kill` IPC), quit-aware.
 *
 * @param {object} ctx
 *   paneId       — pane key (log/registry).
 *   entry        — the live ptys-Map entry ({ child, ... }) or undefined.
 *   isQuitting   — app.isQuitting === true → teardown semantics (preserve).
 *   registry     — livePaneRegistry (removePane).
 *   homedir      — crewpaneHome() seam handed to the registry.
 *   resumeDaemon — pty resume daemon or null (forgetPane on intentional close).
 *   log          — logLine.
 * @returns {{ killed: boolean, preserved: boolean }} killed=false → unknown pane
 *   (caller must not delete anything); preserved=true → registry entry kept for
 *   restart-resume.
 */
function killPaneExplicit(ctx) {
  const { paneId, entry, isQuitting, registry, homedir, resumeDaemon, log } = ctx;
  if (!entry) return { killed: false, preserved: false };
  try { entry.child.kill(); } catch { /* already dead */ }
  if (isQuitting === true) {
    // App teardown in progress — this kill is a race, not a user close. Mark the
    // entry like killAllPtys does so a late onExit can never removePane either.
    entry.preserve = true;
    log(`pty killed (quit-preserve) paneId=${paneId}`);
    return { killed: true, preserved: true };
  }
  // ADP-192 — an EXPLICIT close is intentional: forget it so a restart does NOT
  // resurrect a pane the user deliberately killed.
  try { registry.removePane(paneId, homedir); } catch { /* best-effort */ }
  // ADP-limit — same intent for auto-resume: a queued limit on this pane must
  // not respawn an agent the user just closed.
  if (resumeDaemon) { try { resumeDaemon.forgetPane(paneId); } catch { /* best-effort */ } }
  log(`pty killed paneId=${paneId}`);
  return { killed: true, preserved: false };
}

module.exports = { killPaneExplicit };
