'use strict';

const defaultQuitFunnel = require('../../core/quitFunnel.cjs');
const defaultCrashJournal = require('../../core/crashJournal.cjs');
const defaultInstancePaths = require('../../config/instancePaths.cjs');

const defaultLifecycleOptions = {
  app: null,
  quitFunnel: defaultQuitFunnel,
  crashJournal: defaultCrashJournal,
  instancePaths: defaultInstancePaths,
  getSeatGate: () => null,
  isAutotest: false,
  crewpaneHome: () => '',
  armQuitBrake: () => {},
  stopCrashWatchdog: () => {},
  killAllPtys: () => {},
  stopNextServer: () => {},
  noteQuit: () => {},
  getLivePaneCount: () => 0,
  getQuitReason: () => 'user-quit',
  getQuitSignal: () => null,
  appStartedAt: Date.now(),
  logLine: () => {},
  getTeardownSteps: () => [],
};

function normalizeLifecycleDeps(deps = {}) {
  return Object.assign({}, defaultLifecycleOptions, deps);
}

/**
 * Attempt to gracefully release device lease before quitting.
 */
function tryReleaseLease(seat, app, onReleased) {
  const s = (() => {
    try {
      return seat.state();
    } catch {
      return null;
    }
  })();

  if (!s || !s.signedIn || !s.device || !s.device.device_id) return false;

  const failsafe = setTimeout(() => app.quit(), 2000);
  if (typeof failsafe.unref === 'function') failsafe.unref();

  seat.releaseDeviceLease({ timeoutMs: 1200 })
    .catch(() => {})
    .finally(() => {
      clearTimeout(failsafe);
      onReleased();
    });
  return true;
}

/**
 * Creates the Application Lifecycle Manager.
 * Consolidates before-quit, window-all-closed, quit brake and teardown funnel (HATA-14, SEC-02, ADP-905).
 */
function createLifecycleManager(rawDeps = {}) {
  const deps = normalizeLifecycleDeps(rawDeps);
  let leaseReleaseAttempted = false;
  let quitJournalWritten = false;

  function recordQuitJournal() {
    if (quitJournalWritten) return;
    quitJournalWritten = true;
    try {
      const home = typeof deps.crewpaneHome === 'function' ? deps.crewpaneHome() : deps.crewpaneHome;
      deps.crashJournal.record(deps.instancePaths.instanceHome(home), {
        reason: deps.getQuitReason() || 'user-quit',
        signal: deps.getQuitSignal(),
        uptimeMs: Date.now() - deps.appStartedAt,
        panes: typeof deps.getLivePaneCount === 'function' ? deps.getLivePaneCount() : 0,
        version: deps.app ? deps.app.getVersion() : '0.0.0',
        pid: process.pid,
      });
    } catch {
      /* defter ASLA kapanışı geciktirmez */
    }
  }

  function handleBeforeQuit(event) {
    recordQuitJournal();

    const seat = typeof deps.getSeatGate === 'function' ? deps.getSeatGate() : deps.getSeatGate;
    if (!leaseReleaseAttempted && seat && !deps.isAutotest) {
      leaseReleaseAttempted = true;
      const delayed = tryReleaseLease(seat, deps.app, () => deps.app.quit());
      if (delayed) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        return;
      }
    }

    if (deps.app) deps.app.isQuitting = true;
    deps.armQuitBrake('quit');
    deps.stopCrashWatchdog();

    const steps = typeof deps.getTeardownSteps === 'function' ? deps.getTeardownSteps() : [];
    const teardown = deps.quitFunnel.runTeardown(steps, { log: deps.logLine });
    deps.logLine(`[quit] kapanış hunisi: ${teardown.ran.length}/${teardown.ran.length + teardown.failed.length} adım tamam`
      + (teardown.failed.length ? ` — BAŞARISIZ: ${teardown.failed.map((f) => f.name).join(', ')}` : ''));
  }

  function handleWindowAllClosed({ platform = process.platform } = {}) {
    if (platform !== 'darwin' || deps.isAutotest) {
      deps.killAllPtys();
      deps.stopNextServer();
      deps.armQuitBrake('window-all-closed');
      deps.noteQuit('user-quit', 'window-all-closed');
      if (deps.app) deps.app.quit();
    } else {
      const count = typeof deps.getLivePaneCount === 'function' ? deps.getLivePaneCount() : 0;
      deps.logLine(`ADP-905 window-all-closed: darwin — ${count} pane yaşamaya devam ediyor (quit YOK)`);
    }
  }

  function register() {
    if (!deps.app) return;
    deps.app.on('before-quit', (event) => handleBeforeQuit(event));
    deps.app.on('window-all-closed', () => handleWindowAllClosed());
  }

  return {
    handleBeforeQuit,
    handleWindowAllClosed,
    recordQuitJournal,
    register,
  };
}

module.exports = {
  createLifecycleManager,
};
