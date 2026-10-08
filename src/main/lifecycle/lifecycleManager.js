'use strict';

const defaultQuitFunnel = require('../../core/quitFunnel.cjs');
const defaultCrashJournal = require('../../core/crashJournal.cjs');
const defaultInstancePaths = require('../../config/instancePaths.cjs');

const defaultLifecycleOptions = {
  app: null,
  process: null,
  quitFunnel: defaultQuitFunnel,
  crashJournal: defaultCrashJournal,
  instancePaths: defaultInstancePaths,
  getSeatGate: () => null,
  isAutotest: false,
  crewpaneHome: () => '',
  armQuitBrake: () => {},
  crashWatchdogService: null,
  stopCrashWatchdog: () => {},
  killAllPtys: () => {},
  nextServerManager: null,
  stopNextServer: () => {},
  noteQuit: () => {},
  getLivePaneCount: () => 0,
  getQuitReason: () => 'user-quit',
  getQuitSignal: () => null,
  appStartedAt: Date.now(),
  logLine: () => {},
  getTeardownSteps: null,
  globalShortcut: null,
  paneQueryService: null,
  livePaneRegistry: null,
  ptyResumeService: null,
  adapter: null,
  jarvisVoice: null,
  delegationBridgeService: null,
  delegationSupervisorService: null,
  resetDelegationBridge: () => {},
  listenSignals: true,
  authService: null,
};

function normalizeLifecycleDeps(deps = {}) {
  const d = Object.assign({}, defaultLifecycleOptions, deps);
  if (d.crashWatchdogService && d.stopCrashWatchdog === defaultLifecycleOptions.stopCrashWatchdog) {
    d.stopCrashWatchdog = () => d.crashWatchdogService.stopCrashWatchdog();
  }
  if (d.nextServerManager && d.stopNextServer === defaultLifecycleOptions.stopNextServer) {
    d.stopNextServer = () => d.nextServerManager.stopNextServer();
  }
  if (d.authService && d.getSeatGate === defaultLifecycleOptions.getSeatGate) {
    d.getSeatGate = () => d.authService.getSeatGate();
  }
  return d;
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

function _appendCoreTeardownSteps(steps, deps) {
  const home = typeof deps.crewpaneHome === 'function' ? deps.crewpaneHome() : deps.crewpaneHome;
  const pqs = deps.paneQueryService;
  const reg = deps.livePaneRegistry;
  const gs = deps.globalShortcut;
  const rst = deps.ptyResumeService;
  const log = typeof deps.logLine === 'function' ? deps.logLine : () => {};

  if (pqs && typeof pqs.persistScreenTails === 'function') {
    steps.push({ name: 'persist-screen-tails', run: () => pqs.persistScreenTails() });
  }
  if (reg && typeof reg.writeQuitSnapshot === 'function') {
    steps.push({
      name: 'quit-snapshot',
      run: () => {
        const n = reg.writeQuitSnapshot(home);
        if (n) log(`quit: live-pane registry snapshot written (${n} pane(s))`);
      },
    });
  }
  if (gs && typeof gs.unregisterAll === 'function') {
    steps.push({ name: 'global-shortcuts', run: () => gs.unregisterAll() });
  }
  if (rst && typeof rst.stop === 'function') {
    steps.push({ name: 'pty-resume-daemon', run: () => rst.stop() });
  }
}

function _appendServiceTeardownSteps(steps, deps) {
  const adp = deps.adapter;
  const jv = deps.jarvisVoice;
  const pqs = deps.paneQueryService;
  const dbs = deps.delegationBridgeService;

  if (adp && typeof adp.isRunning === 'function') {
    steps.push({
      name: 'adapter',
      run: () => { if (adp.isRunning() && typeof adp.stopAdapter === 'function') adp.stopAdapter(); },
    });
  }
  if (jv && jv.whisperLocal && typeof jv.whisperLocal.stopServer === 'function') {
    steps.push({ name: 'whisper-local', run: () => jv.whisperLocal.stopServer() });
  }
  if (jv && typeof jv.stopBrain === 'function') {
    steps.push({ name: 'jarvis-brain', run: () => jv.stopBrain() });
  }
  if (typeof deps.stopNextServer === 'function') {
    steps.push({ name: 'next-server', run: () => deps.stopNextServer() });
  }
  if (pqs && typeof pqs.killAllPtys === 'function') {
    steps.push({ name: 'ptys', run: () => pqs.killAllPtys() });
  } else if (typeof deps.killAllPtys === 'function') {
    steps.push({ name: 'ptys', run: () => deps.killAllPtys() });
  }
  if (dbs && typeof dbs.stopBridge === 'function') {
    steps.push({
      name: 'delegation-bridge',
      run: () => {
        if (typeof deps.resetDelegationBridge === 'function') deps.resetDelegationBridge();
        dbs.stopBridge();
      },
    });
  }
}

function buildStandardTeardownSteps(deps) {
  const steps = [];
  _appendCoreTeardownSteps(steps, deps);
  _appendServiceTeardownSteps(steps, deps);
  return steps;
}

function registerSignalHandlers(deps) {
  const proc = deps.process || process;
  const sup = deps.delegationSupervisorService;
  const app = deps.app;
  const log = typeof deps.logLine === 'function' ? deps.logLine : () => {};
  const noteQuit = typeof deps.noteQuit === 'function' ? deps.noteQuit : () => {};

  if (!proc || typeof proc.on !== 'function') return;

  let externalShutdownSignal = null;
  for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) {
    proc.on(sig, () => {
      if (externalShutdownSignal) return;
      externalShutdownSignal = sig;
      try { log(`⚠️ DIŞ KAPANIŞ: ${sig} alındı — uygulama kapanıyor (bu quit'i biz istemedik)`); } catch { /* log çıkışı tutmaz */ }
      try {
        if (sup && typeof sup.markExternalShutdown === 'function') {
          const hits = sup.markExternalShutdown(sig);
          if (hits && hits.length && typeof sup.externalShutdownNote === 'function') {
            const note = sup.externalShutdownNote(hits);
            if (note) log(note);
          }
        }
      } catch { /* damga çıkışı ASLA geciktirmez */ }
      noteQuit('signal', sig);
      try {
        if (app && typeof app.quit === 'function') app.quit();
        else proc.exit(143);
      } catch {
        proc.exit(143);
      }
    });
  }
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

    const steps = typeof deps.getTeardownSteps === 'function'
      ? deps.getTeardownSteps()
      : buildStandardTeardownSteps(deps);
    const teardown = deps.quitFunnel.runTeardown(steps, { log: deps.logLine });
    deps.logLine(`[quit] kapanış hunisi: ${teardown.ran.length}/${teardown.ran.length + teardown.failed.length} adım tamam`
      + (teardown.failed.length ? ` — BAŞARISIZ: ${teardown.failed.map((f) => f.name).join(', ')}` : ''));
  }

  function handleWindowAllClosed({ platform = process.platform } = {}) {
    if (platform !== 'darwin' || deps.isAutotest) {
      if (deps.paneQueryService && typeof deps.paneQueryService.killAllPtys === 'function') {
        deps.paneQueryService.killAllPtys();
      } else {
        deps.killAllPtys();
      }
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
    if (deps.listenSignals) registerSignalHandlers(deps);
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
