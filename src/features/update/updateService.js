'use strict';

const fs = require('node:fs');
const path = require('node:path');
const updateCheckDefault = require('../../services/updateCheck.cjs');
const updateChannelDefault = require('../../services/updateChannel.cjs');

function noteUpdateResult(reason, latestVersion, heartbeat) {
  const r = String(reason || '');
  const result = r === 'ok' || r === 'no-update' || r === 'timeout' || r === 'network' || r === 'bad-payload'
    ? r
    : (r.startsWith('http-') ? (r === 'http-403' ? 'http-403' : 'network') : 'error');
  try {
    const hb = typeof heartbeat === 'function' ? heartbeat() : heartbeat;
    if (hb && hb.noteUpdate) {
      hb.noteUpdate({ result, checkedAt: Date.now(), latestSeen: latestVersion || null });
    }
  } catch {
    /* telemetri asla güncelleme akışını düşürmez */
  }
}

function attachAutoUpdaterEvents(autoUpdater, {
  setUpdateState,
  getUpdateState,
  pushUpdateState,
  noteUpdate,
  logLine,
}) {
  autoUpdater.on('update-available', (info) => {
    const current = getUpdateState();
    setUpdateState({
      ...current,
      checked: true,
      updateAvailable: true,
      latestVersion: `v${info.version}`,
      lastCheckedAt: Date.now(),
      phase: current.phase === 'downloaded' ? 'downloaded' : 'available',
    });
    logLine(`update-check(updater): yeni sürüm var → v${info.version}`);
    noteUpdate('ok', `v${info.version}`);
    pushUpdateState();
  });

  autoUpdater.on('update-not-available', (info) => {
    const current = getUpdateState();
    setUpdateState({
      ...current,
      checked: true,
      updateAvailable: false,
      latestVersion: info && info.version ? `v${info.version}` : current.latestVersion,
      lastCheckedAt: Date.now(),
      phase: 'idle',
      progressPercent: null,
    });
    logLine('update-check(updater): güncel');
    noteUpdate('no-update', info && info.version ? `v${info.version}` : null);
    pushUpdateState();
  });

  autoUpdater.on('download-progress', (p) => {
    const current = getUpdateState();
    setUpdateState({ ...current, phase: 'downloading', progressPercent: Math.round(p.percent) });
    pushUpdateState();
  });

  autoUpdater.on('update-downloaded', (info) => {
    const current = getUpdateState();
    setUpdateState({
      ...current,
      phase: 'downloaded',
      progressPercent: 100,
      latestVersion: `v${info.version}`,
    });
    logLine(`updater: v${info.version} indirildi — kullanıcı onayı bekleniyor (Yeniden başlat)`);
    pushUpdateState();
  });

  autoUpdater.on('error', (err) => {
    logLine(`update-check(updater): sessiz geçildi (${err && err.message ? err.message.split('\n')[0] : 'error'})`);
    noteUpdate(/403/.test(String(err && err.message)) ? 'http-403' : 'network', null);
    const current = getUpdateState();
    if (current.phase === 'downloading') {
      setUpdateState({ ...current, phase: 'available', progressPercent: null });
      pushUpdateState();
    }
  });
}

function createAutoUpdaterInstance({
  app,
  updateChannel,
  channel,
  logLine,
  setUpdateState,
  getUpdateState,
  pushUpdateState,
  noteUpdate,
}) {
  try {
    const devConfig = process.env.CREWPANE_UPDATE_CONFIG || null;
    if (!devConfig) {
      if (!app.isPackaged) return null;
      if (!fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'))) return null;
    }
    const { autoUpdater } = require('electron-updater');
    if (devConfig) {
      autoUpdater.updateConfigPath = devConfig;
      autoUpdater.forceDevUpdateConfig = true;
    }
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    logLine(`updater: yayın kanalı = ${updateChannel.applyChannel(autoUpdater, channel)}`);
    autoUpdater.logger = {
      info: (m) => logLine(`updater: ${m}`),
      warn: (m) => logLine(`updater[warn]: ${m}`),
      error: (m) => logLine(`updater[error]: ${m}`),
      debug: () => {},
    };
    attachAutoUpdaterEvents(autoUpdater, {
      setUpdateState,
      getUpdateState,
      pushUpdateState,
      noteUpdate,
      logLine,
    });
    return autoUpdater;
  } catch (err) {
    logLine(`updater init başarısız → Faz 1 notify fallback (${err && err.message})`);
    return null;
  }
}

function evaluateLicenseGate(getSeatGate, updateCheck, logLine) {
  try {
    const seatGate = getSeatGate();
    return updateCheck.updateLicenseGate(seatGate ? seatGate.state() : null);
  } catch (e) {
    logLine(`update-gate: değerlendirilemedi (${e && e.message}) — kanal AÇIK bırakıldı`);
    return { allowed: true };
  }
}

function buildRendererState({
  updateState,
  agentSettings,
  app,
  autoUpdaterRef,
  currentChannel,
  gate,
  defaultDownloadUrl,
  updateChannel,
}) {
  const s = agentSettings.readSettings();
  return {
    ...updateState,
    currentVersion: app.getVersion(),
    licenseBlocked: gate.allowed === false,
    licenseMessage: gate.allowed === false ? gate.message : null,
    licenseBillingUrl: gate.allowed === false ? (gate.billingUrl || null) : null,
    autoCheck: s.updateAutoCheck !== false,
    dismissed: Boolean(updateState.latestVersion && s.updateDismissedVersion === updateState.latestVersion),
    downloadUrl: updateState.downloadUrl || defaultDownloadUrl,
    mode: autoUpdaterRef ? 'updater' : 'notify',
    channel: currentChannel,
    channelPref: updateChannel.normalizeChannel(s.updateChannel) || 'auto',
  };
}

async function executeNotifyCheck({
  app,
  channel,
  trigger,
  updateCheck,
  updateState,
  setUpdateState,
  noteUpdate,
  pushUpdateState,
  logLine,
}) {
  const res = await updateCheck.checkForUpdate({
    currentVersion: app.getVersion(),
    channel,
    url: process.env.CREWPANE_UPDATE_FEED_URL || null,
  });
  if (res.ok) {
    setUpdateState({
      ...updateState,
      checked: true,
      updateAvailable: res.updateAvailable,
      latestVersion: res.latestVersion,
      lastCheckedAt: Date.now(),
      phase: res.updateAvailable ? 'available' : 'idle',
      downloadUrl: res.downloadUrl || null,
    });
    logLine(`update-check(${trigger},${res.channel || channel}): latest=${res.latestVersion} current=${res.currentVersion} → ${res.updateAvailable ? 'yeni sürüm var' : 'güncel'}`);
    noteUpdate(res.updateAvailable ? 'ok' : 'no-update', res.latestVersion);
    pushUpdateState();
  } else {
    logLine(`update-check(${trigger}): sessiz geçildi (${res.reason})`);
    noteUpdate(res.reason, null);
  }
}

async function executeAutoUpdaterCheck(autoUpdaterRef, updateChannel, channel) {
  updateChannel.applyChannel(autoUpdaterRef, channel);
  try {
    await autoUpdaterRef.checkForUpdates();
  } catch {
    /* sessiz — error event'i logladı */
  }
}

function setupUpdateTimers({ instancePaths, runCheck, intervalMs }) {
  if (
    instancePaths.instanceId() === 'test' &&
    !process.env.CREWPANE_UPDATE_FEED_URL &&
    !process.env.CREWPANE_UPDATE_CONFIG
  ) return;
  setTimeout(() => { runCheck().catch(() => {}); }, 2500);
  const timer = setInterval(() => { runCheck().catch(() => {}); }, intervalMs);
  timer.unref?.();
}

/**
 * Auto-Updater Core Service (Faz 3.6.14)
 */
function createUpdateService(deps = {}) {
  const {
    app,
    BrowserWindow,
    instancePaths,
    agentSettings,
    updateCheck = updateCheckDefault,
    updateChannel = updateChannelDefault,
    logLine = () => {},
    getSeatGate = () => null,
    heartbeat = () => null,
  } = deps;

  let updateState = {
    checked: false,
    updateAvailable: false,
    latestVersion: null,
    lastCheckedAt: null,
    phase: 'idle',
    progressPercent: null,
    downloadUrl: null,
  };

  let autoUpdaterRef = null;
  let updateChecksScheduled = false;

  const getUpdateState = () => updateState;
  const setUpdateState = (s) => { updateState = s; };
  const getAutoUpdaterRef = () => autoUpdaterRef;
  const isAutoUpdaterActive = () => Boolean(autoUpdaterRef);

  const currentUpdateChannel = () => updateChannel.resolveChannel({
    settingsValue: agentSettings.readSettings().updateChannel,
    instanceId: instancePaths.instanceId(),
    envValue: process.env.CREWPANE_UPDATE_CHANNEL || null,
  });

  const noteUpdate = (reason, latestVer) => noteUpdateResult(reason, latestVer, heartbeat);
  const updateLicenseGateNow = () => evaluateLicenseGate(getSeatGate, updateCheck, logLine);

  const updateStateForRenderer = () => buildRendererState({
    updateState,
    agentSettings,
    app,
    autoUpdaterRef,
    currentChannel: currentUpdateChannel(),
    gate: updateLicenseGateNow(),
    defaultDownloadUrl: updateCheck.DOWNLOAD_URL,
    updateChannel,
  });

  function pushUpdateState() {
    if (!BrowserWindow) return;
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        if (!w.isDestroyed()) w.webContents.send('update:state', updateStateForRenderer());
      } catch {
        /* best-effort */
      }
    }
  }

  const initAutoUpdater = () => createAutoUpdaterInstance({
    app,
    updateChannel,
    channel: currentUpdateChannel(),
    logLine,
    setUpdateState,
    getUpdateState,
    pushUpdateState,
    noteUpdate,
  });

  async function runUpdateCheck(trigger) {
    if (trigger === 'auto' && agentSettings.readSettings().updateAutoCheck === false) {
      return updateStateForRenderer();
    }
    const gate = updateLicenseGateNow();
    if (!gate.allowed) {
      logLine(`update-check(${trigger}): LİSANS KAPISI (${gate.reason}) — yeni sürüm sorulmadı/indirilmedi`);
      pushUpdateState();
      return updateStateForRenderer();
    }
    const channel = currentUpdateChannel();
    if (autoUpdaterRef) {
      await executeAutoUpdaterCheck(autoUpdaterRef, updateChannel, channel);
      return updateStateForRenderer();
    }
    await executeNotifyCheck({
      app,
      channel,
      trigger,
      updateCheck,
      updateState,
      setUpdateState,
      noteUpdate,
      pushUpdateState,
      logLine,
    });
    return updateStateForRenderer();
  }

  function scheduleUpdateChecks() {
    if (updateChecksScheduled) return;
    updateChecksScheduled = true;
    autoUpdaterRef = initAutoUpdater();
    setupUpdateTimers({
      instancePaths,
      runCheck: () => runUpdateCheck('auto'),
      intervalMs: updateCheck.CHECK_INTERVAL_MS,
    });
  }

  return {
    getUpdateState,
    setUpdateState,
    getAutoUpdaterRef,
    isAutoUpdaterActive,
    currentUpdateChannel,
    initAutoUpdater,
    updateLicenseGateNow,
    updateStateForRenderer,
    pushUpdateState,
    runUpdateCheck,
    noteUpdateResult: noteUpdate,
    scheduleUpdateChecks,
  };
}

module.exports = {
  createUpdateService,
  noteUpdateResult,
};
