'use strict';

const accountScope = require('../../config/accountScope.cjs');
const crewpaneEnv = require('../../config/crewpaneEnv.cjs');
const buildChannel = require('../../config/buildChannel.cjs');
const singleInstanceLock = require('../../core/singleInstanceLock.cjs');

function runningPaneSummary(ptys) {
  const panes = [];
  if (!ptys) return panes;
  for (const [paneId, entry] of ptys) {
    if (!entry) continue;
    panes.push({
      paneId,
      agentId: entry.agentId || null,
      label: entry.label || entry.agentId || paneId,
    });
  }
  return panes;
}

function signOutConfirmCopy(panes) {
  const agentIds = new Set();
  for (const p of panes) {
    if (p.agentId) agentIds.add(p.agentId);
  }
  return { terminals: panes.length, agents: agentIds.size };
}

function closePanesForSignOut({ ptys, persistScreenTails, livePaneRegistry, crewpaneHome, killAllPtys, logLine }) {
  const open = ptys ? ptys.size : 0;
  if (!open) return 0;
  if (typeof persistScreenTails === 'function') persistScreenTails();
  try {
    const home = typeof crewpaneHome === 'function' ? crewpaneHome() : '';
    const n = livePaneRegistry ? livePaneRegistry.writeQuitSnapshot(home) : 0;
    if (n) logLine(`[signout] pane defteri yazıldı (${n} pane) — hesap kökü DEĞİŞMEDEN önce`);
  } catch (e) {
    logLine(`[signout] pane defteri yazılamadı: ${e.message}`);
  }
  if (typeof killAllPtys === 'function') killAllPtys();
  logLine(`[signout] ${open} pane temiz kapatıldı (oturum kapatılmadan ÖNCE)`);
  return open;
}

function performRelaunch({ singleInstanceLockMod, instancePaths, app, logLine, reason }) {
  try {
    singleInstanceLockMod.releaseForRelaunch({
      dataRoot: instancePaths.instanceHome(),
      log: (m) => logLine(`[relaunch] ${m}`),
    });
  } catch (e) {
    logLine(`[relaunch] kilit bırakılamadı (${reason}): ${e && e.message}`);
  }
  try {
    app.relaunch();
  } catch (e) {
    logLine(`[relaunch] app.relaunch hatası (${reason}): ${e && e.message}`);
  }
  app.exit(0);
}

function relaunchForAccountChange({
  nextKey,
  reason,
  boundAccount,
  instancePaths,
  app,
  noteQuit = () => {},
  armQuitBrake = () => {},
  logLine = () => {},
}) {
  const instanceRoot = instancePaths.instanceHome();
  try {
    accountScope.writeActiveAccount(instanceRoot, { accountKey: nextKey });
  } catch (e) {
    logLine(`[account] geçişte active-account yazılamadı: ${e.message}`);
  }
  const suppressRelaunch = instancePaths.instanceId() === instancePaths.TEST
    && !buildChannel.isCustomerBuild()
    && String(process.env.CREWPANE_ACCOUNT_NO_RELAUNCH || '') === '1';

  logLine(`[account] HESAP DEĞİŞİMİ (${reason}): ${boundAccount ? boundAccount.key : '-'} → ${nextKey}`
    + (suppressRelaunch ? ' — süreç kapanıyor (relaunch test dikişiyle bastırıldı)' : ' — uygulama yeniden başlatılıyor'));

  if (!suppressRelaunch) {
    try {
      singleInstanceLock.releaseForRelaunch({
        dataRoot: instancePaths.instanceHome(),
        log: (m) => logLine(`[account] ${m}`),
      });
    } catch (e) {
      logLine(`[account] kilit bırakılamadı: ${e.message}`);
    }
    try {
      app.relaunch();
    } catch (e) {
      logLine(`[account] relaunch hatası: ${e.message}`);
    }
  }
  noteQuit('relaunch');
  app.quit();
  armQuitBrake('account-relaunch');
}

function applyResourceGovernor(agentSettings, getResourceGovernor) {
  const gov = getResourceGovernor();
  if (gov && agentSettings && agentSettings.readSettings) {
    try {
      const freshGov = agentSettings.readSettings().resourceGovernor;
      if (freshGov) gov.configure(freshGov);
    } catch {
      /* ignore invalid governor settings */
    }
  }
}

async function resolveAccountSnapshot(seatGatePromise, logLine) {
  let snapshot = null;
  try {
    if (seatGatePromise) {
      const sg = await seatGatePromise;
      snapshot = sg && typeof sg.evaluate === 'function' ? sg.evaluate() : sg;
    }
  } catch (e) {
    logLine(`[account] oturum okunamadı (${e.message}) — anonim köke bağlanılıyor`);
  }
  return snapshot;
}

function claimLegacyDataSafe(instanceRoot, key, logLine) {
  try {
    return accountScope.claimLegacyData(instanceRoot, key, { log: (l) => logLine(l) });
  } catch (e) {
    logLine(`[account] eski veri devralınamadı: ${e.message} — mevcut veri OLDUĞU GİBİ bırakıldı`);
    return { claimed: false, alreadyClaimed: true, moved: [], skipped: [] };
  }
}

function persistActiveAccountSafe(instanceRoot, key, snapshot, logLine) {
  try {
    accountScope.writeActiveAccount(instanceRoot, {
      accountKey: key,
      userId: (snapshot && snapshot.userId) || null,
      email: (snapshot && snapshot.email) || null,
    });
  } catch (e) {
    logLine(`[account] active-account.json yazılamadı: ${e.message}`);
  }
}

/**
 * Account-Scoped Data Binding Service (Faz 3.6.8)
 */
function createAccountBindingService(deps = {}) {
  const {
    instancePaths,
    app,
    agentSettings,
    getResourceGovernor = () => null,
    ptys = null,
    persistScreenTails = () => {},
    livePaneRegistry = null,
    crewpaneHome = () => '',
    killAllPtys = () => {},
    noteQuit = () => {},
    armQuitBrake = () => {},
    logLine = () => {},
  } = deps;

  let boundAccount = null;
  let accountBindInFlight = null;

  async function bindAccountRoot(seatGatePromise, reason = 'boot') {
    if (accountBindInFlight) return accountBindInFlight;
    accountBindInFlight = (async () => {
      const instanceRoot = instancePaths.instanceHome();
      const snapshot = await resolveAccountSnapshot(seatGatePromise, logLine);
      const key = accountScope.accountKeyForSession(snapshot);
      const claim = claimLegacyDataSafe(instanceRoot, key, logLine);
      const deviceId = accountScope.ensureDeviceId(instanceRoot);

      let root;
      try {
        root = accountScope.ensureAccountRoot(instanceRoot, key, {
          userId: (snapshot && snapshot.userId) || null,
          email: (snapshot && snapshot.email) || null,
          deviceId,
        });
      } catch (e) {
        logLine(`[account] hesap kökü kurulamadı (${e.message}) — kapsamsız köke düşülüyor`);
        accountBindInFlight = null;
        return null;
      }

      crewpaneEnv.dualWrite(process.env, 'ACCOUNT', key);
      if (agentSettings && agentSettings.invalidateCache) agentSettings.invalidateCache();
      applyResourceGovernor(agentSettings, getResourceGovernor);
      persistActiveAccountSafe(instanceRoot, key, snapshot, logLine);

      boundAccount = {
        key,
        userId: (snapshot && snapshot.userId) || null,
        email: (snapshot && snapshot.email) || null,
        root,
        deviceId,
      };
      logLine(
        `[account] bağlandı (${reason}): key=${key} signedIn=${Boolean(snapshot && snapshot.signedIn)} `
        + `kök=${root} devralma=${claim.claimed ? `${claim.moved.length} girdi` : 'gerek yok'}`,
      );
      accountBindInFlight = null;
      return boundAccount;
    })();
    return accountBindInFlight;
  }

  function reconcileAccountBinding(snapshot) {
    if (!boundAccount) return;
    if (!snapshot || !snapshot.signedIn) return;
    const nextKey = accountScope.accountKeyForSession(snapshot);
    if (nextKey === boundAccount.key) return;
    relaunchForAccountChange({
      nextKey,
      reason: 'signIn',
      boundAccount,
      instancePaths,
      app,
      noteQuit,
      armQuitBrake,
      logLine,
    });
  }

  return {
    getBoundAccount: () => boundAccount,
    bindAccountRoot,
    reconcileAccountBinding,
    runningPaneSummary: () => runningPaneSummary(ptys),
    signOutConfirmCopy,
    closePanesForSignOut: () => closePanesForSignOut({
      ptys, persistScreenTails, livePaneRegistry, crewpaneHome, killAllPtys, logLine,
    }),
    relaunchApp: (r) => performRelaunch({ singleInstanceLockMod: singleInstanceLock, instancePaths, app, logLine, reason: r }),
    relaunchForAccountChange: (nextKey, r) => relaunchForAccountChange({
      nextKey, reason: r, boundAccount, instancePaths, app, noteQuit, armQuitBrake, logLine,
    }),
    accountScope,
  };
}

module.exports = {
  createAccountBindingService,
  runningPaneSummary,
  signOutConfirmCopy,
  closePanesForSignOut,
  relaunchForAccountChange,
};
