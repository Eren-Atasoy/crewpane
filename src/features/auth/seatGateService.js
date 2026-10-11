'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { createSeatGate } = require('../../security/seatGate.cjs');
const { crewpaneIdConfig, devEscapeProbeEnv } = require('../../config/crewpaneId.cjs');
const buildChannel = require('../../config/buildChannel.cjs');
const planLimitsDefault = require('../../config/planLimits.cjs');
const accountScope = require('../../config/accountScope.cjs');

function resolveCrewpaneAuthDir() {
  const local = path.join(__dirname, '..', '..', '..', 'packages', 'crewpane-auth');
  if (fs.existsSync(local)) return local;
  return path.join(__dirname, '..', '..', '..', '..', 'packages', 'crewpane-auth');
}

function pushDeviceDenial({ snapshot, planLimits, pushPlanLimit, state }) {
  const dev = snapshot && snapshot.device;
  if (!dev || dev.denied !== true || !dev.feature) {
    state.lastDeviceDenialKey = null;
    return;
  }
  const key = `${dev.feature}:${dev.active}/${dev.limit}`;
  if (key === state.lastDeviceDenialKey) return;
  state.lastDeviceDenialKey = key;
  const denial = planLimits.decide({
    snapshot,
    feature: dev.feature,
    current: Number(dev.active) || 0,
  });
  if (denial.allowed) return;
  pushPlanLimit(denial);
}

function pushAccountState({ snapshot, getAppWindow, pushDeviceDenialFn, reconcileAccountBinding, logLine }) {
  try {
    const win = getAppWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('crewpane:state', snapshot);
    }
  } catch (e) {
    logLine(`[account] push state hatası: ${e.message}`);
  }
  try {
    pushDeviceDenialFn(snapshot);
  } catch (e) {
    logLine(`[device] nudge hatası: ${e.message}`);
  }
  try {
    reconcileAccountBinding(snapshot);
  } catch (e) {
    logLine(`[account] reconcile hatası: ${e.message}`);
  }
}

function createEscapeProbe(env) {
  return () => ({
    env: {
      ...devEscapeProbeEnv(env),
      CREWPANE_INSTANCE: env.CREWPANE_INSTANCE ?? null,
    },
    asCustomer: crewpaneIdConfig(env, { customerBuild: true }),
    asDeveloper: crewpaneIdConfig(env, { customerBuild: false }),
    actual: crewpaneIdConfig(env),
  });
}

function createPlanProbe(seatGate, ptys, planLimits) {
  return (feature, current, tier) => {
    const snapshot = seatGate.evaluate();
    const s = tier === undefined ? snapshot : { ...snapshot, tier };
    return {
      snapshot: { requireSeat: s.requireSeat, tier: s.tier, seat: s.seat, accessAllowed: s.accessAllowed },
      decision: planLimits.decide({ snapshot: s, feature, current }),
      describe: planLimits.describe(s, { agents: ptys.size }),
    };
  };
}

function createSpawnIntentProbe(ptys, getAppWindow, spawnPty) {
  return (intent, agentId) => {
    const before = ptys.size;
    const win = typeof getAppWindow === 'function' ? getAppWindow() : null;
    const res = spawnPty(win, {
      command: 'claude',
      department: 'crewpane',
      agentId: agentId || null,
      forceFresh: true,
      spawnIntent: intent,
    });
    return {
      planLimited: Boolean(res && res.planLimited),
      paneId: (res && res.paneId) || null,
      reused: Boolean(res && res.reused),
      liveBefore: before,
      liveAfter: ptys.size,
    };
  };
}

function createPaneCensusProbe(ptys, crewpaneHome, livePaneRegistry, getRestoreSkippedByPlan) {
  return () => {
    let ledger = null;
    let file = null;
    try {
      const home = crewpaneHome();
      file = livePaneRegistry ? livePaneRegistry.registryPath(home) : null;
      ledger = Object.keys((livePaneRegistry && livePaneRegistry.loadRegistry(home).panes) || {}).length;
    } catch {
      ledger = null;
    }
    const skipped = typeof getRestoreSkippedByPlan === 'function' ? getRestoreSkippedByPlan() : 0;
    return { live: ptys.size, ledger, file, restoreSkippedByPlan: skipped };
  };
}

function setupAuthTestSeam({ seatGate, instancePaths, testSeamDeps, getAppWindow = () => null }) {
  if (instancePaths.instanceId() !== instancePaths.TEST || buildChannel.isCustomerBuild()) return;
  const d = testSeamDeps || {};
  const ptys = d.ptys || new Map();
  const planLimits = d.planLimits || planLimitsDefault;
  const crewpaneHome = d.crewpaneHome || (() => '');

  let supervisorBlockedCount = 0;
  global.__crewpaneAuthTest = {
    state: () => seatGate.evaluate(),
    signInWithEmail: (email) => seatGate.signInWithEmail(email),
    handleUrl: (url) => seatGate.handleUrl(url),
    requireSeat: (action) => seatGate.requireSeat(action),
    refreshLicense: () => seatGate.refreshLicense(),
    signOut: () => seatGate.signOut(),
    heartbeat: () => seatGate.heartbeat(),
    updateGate: () => (d.updateCheck ? d.updateCheck.updateLicenseGate(seatGate.evaluate()) : null),
    escapeProbe: createEscapeProbe(process.env),
    supervisorPush: async (channel, payload) => {
      const before = typeof d.getSupervisorAdvanceBlocked === 'function' ? d.getSupervisorAdvanceBlocked() : supervisorBlockedCount;
      const ok = d.supervisorPushRenderer ? await d.supervisorPushRenderer(channel, payload || {}) : false;
      const after = typeof d.getSupervisorAdvanceBlocked === 'function' ? d.getSupervisorAdvanceBlocked() : (!ok ? ++supervisorBlockedCount : supervisorBlockedCount);
      return { ok, blocked: after > before, blockedTotal: after };
    },
    planWaveProbe: (requested) => (d.planWaveLimit ? d.planWaveLimit(requested) : null),
    spawnIntentProbe: createSpawnIntentProbe(ptys, getAppWindow, d.spawnPty || (() => {})),
    paneCensus: createPaneCensusProbe(ptys, crewpaneHome, d.livePaneRegistry, d.getRestoreSkippedByPlan),
    killPaneProbe: (paneId) => {
      const entry = ptys.get(paneId);
      if (!entry) return { ok: false };
      if (typeof d.killPane === 'function') d.killPane(paneId, entry, entry.agentId, 'PLAN-FIX-01 e2e');
      return { ok: true, live: ptys.size };
    },
    mobilePlanProbe: () => {
      const denial = typeof d.mobilePlanDenial === 'function' ? d.mobilePlanDenial({ notify: false }) : null;
      return { denied: Boolean(denial), denial };
    },
    designPlanProbe: () => {
      const denial = typeof d.designPlanDenial === 'function' ? d.designPlanDenial({ notify: false }) : null;
      return { denied: Boolean(denial), denial };
    },
    designWindowCount: () => {
      const bw = d.BrowserWindow;
      if (!bw || !bw.getAllWindows) return 0;
      return bw.getAllWindows().filter((w) => !w.isDestroyed() && /\/design(\?|$)/.test(w.webContents.getURL())).length;
    },
    planProbe: createPlanProbe(seatGate, ptys, planLimits),
  };
}

/**
 * Seat Gate & License Enforcement Service (Faz 3.6.8)
 */
function createSeatGateService(deps = {}) {
  let {
    app,
    shell,
    safeStorage,
    instancePaths,
    planLimits = planLimitsDefault,
    pushPlanLimit = () => {},
    reconcileAccountBinding = () => {},
    integrityReportOnce = () => null,
    getAppWindow = () => null,
    logLine = () => {},
    testSeamDeps = {},
  } = deps;

  if (!safeStorage) {
    try {
      const electron = require('electron');
      if (electron && electron.safeStorage) {
        safeStorage = electron.safeStorage;
      }
    } catch {}
  }
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function') {
    safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (str) => Buffer.from(str, 'utf8'),
      decryptString: (buf) => buf.toString('utf8'),
    };
  }

  const authDir = resolveCrewpaneAuthDir();
  const crewpaneAuth = require(path.join(authDir, 'index.cjs'));
  const denialState = { lastDeviceDenialKey: null };

  let seatGate = null;
  let seatGateReady = null;

  function pushDeviceDenialFn(snapshot) {
    pushDeviceDenial({ snapshot, planLimits, pushPlanLimit, state: denialState });
  }

  function pushAccountStateFn(snapshot) {
    pushAccountState({
      snapshot,
      getAppWindow,
      pushDeviceDenialFn,
      reconcileAccountBinding,
      logLine,
    });
  }

  function initSeatGate() {
    if (seatGate) return seatGate;
    const cfg = crewpaneIdConfig(process.env);
    seatGate = createSeatGate({
      authPkg: crewpaneAuth,
      safeStorage,
      homeDir: instancePaths.instanceHome(),
      supabaseUrl: cfg.supabaseUrl,
      anonKey: cfg.anonKey,
      scheme: cfg.scheme,
      loginUrl: cfg.loginUrl,
      openExternal: (url) => shell.openExternal(url),
      log: (line) => logLine(line),
      onChange: (snapshot) => pushAccountStateFn(snapshot),
      billingUrl: cfg.billingUrl,
      appVersion: app ? app.getVersion() : '0.0.0',
      requireSeat: cfg.requireSeat,
      requireLogin: cfg.requireLogin,
      getIntegrityReport: () => integrityReportOnce(),
      device: (() => {
        try {
          return {
            id: accountScope.ensureDeviceId(instancePaths.instanceHome()),
            name: `${os.hostname()} · ${process.platform}`,
            platform: process.platform,
          };
        } catch (e) {
          logLine(`seatGate: cihaz kimliği okunamadı (${e.message}) — cihaz tavanı bu koşuda uygulanmaz`);
          return null;
        }
      })(),
    });

    logLine(
      `seatGate kurulumu: customerBuild=${cfg.customerBuild} requireLogin=${cfg.requireLogin} requireSeat=${cfg.requireSeat}`,
    );

    seatGateReady = seatGate.init().catch((e) => {
      logLine(`seatGate init error: ${e.message}`);
      return null;
    });

    setupAuthTestSeam({ seatGate, instancePaths, testSeamDeps, getAppWindow });
    return seatGate;
  }

  function requireSeatOrThrow(action, appI18n) {
    const gate = seatGate ? seatGate.requireSeat(action) : {
      allowed: !crewpaneIdConfig(process.env).requireSeat,
      reason: 'not_ready',
      message: appI18n && appI18n.t ? appI18n.t('main.error.seatNotReady') : 'CrewPane paketi gerekli.',
    };
    if (gate.allowed) return;
    const err = new Error(gate.message || 'CrewPane paketi gerekli.');
    err.code = 'ERR_SEAT_REQUIRED';
    err.reason = gate.reason;
    throw err;
  }

  function seatDenial(action) {
    const gate = seatGate ? seatGate.requireSeat(action) : { allowed: false, reason: 'not_ready' };
    return gate.allowed ? null : gate;
  }

  return {
    initSeatGate,
    getSeatGate: () => seatGate,
    getSeatGateReady: () => seatGateReady,
    pushAccountState: pushAccountStateFn,
    pushDeviceDenial: pushDeviceDenialFn,
    requireSeatOrThrow,
    seatDenial,
    crewpaneIdConfig,
  };
}

module.exports = {
  createSeatGateService,
};
