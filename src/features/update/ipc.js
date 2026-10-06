'use strict';

/**
 * Auto-Update IPC Handlers (Faz 3.5 — Sıra 2)
 * Channels: update:get, update:checkNow, update:download, update:install, update:dismiss
 */
function registerUpdateIpc({
  ipcMain,
  updateStateForRenderer,
  runUpdateCheck,
  updateLicenseGateNow,
  getAutoUpdaterRef = () => null,
  getUpdateState = () => ({}),
  setUpdateState = () => {},
  pushUpdateState = () => {},
  updateCheck,
  shell,
  noteQuit = () => {},
  agentSettings,
  logLine = () => {},
}) {
  ipcMain.handle('update:get', () => updateStateForRenderer());
  ipcMain.handle('update:checkNow', () => runUpdateCheck('manual'));

  ipcMain.handle('update:download', () => {
    const licenseGate = updateLicenseGateNow();
    if (!licenseGate.allowed) {
      logLine(`update:download REDDEDİLDİ (${licenseGate.reason}) — lisans kapısı`);
      return {
        ok: false,
        reason: 'license_required',
        denial: licenseGate.reason,
        message: licenseGate.message,
        billingUrl: licenseGate.billingUrl,
      };
    }

    const autoUpdaterRef = getAutoUpdaterRef();
    const updateState = getUpdateState();

    if (autoUpdaterRef) {
      if (updateState.phase === 'downloaded') return updateStateForRenderer();
      setUpdateState({ ...updateState, phase: 'downloading', progressPercent: 0 });
      pushUpdateState();
      autoUpdaterRef.downloadUpdate().catch(() => { /* sessiz — error event'i düşürür */ });
      return { ok: true, mode: 'updater' };
    }

    const url = updateState.downloadUrl || updateCheck.DOWNLOAD_URL;
    shell.openExternal(url);
    return { ok: true, mode: 'notify', url };
  });

  ipcMain.handle('update:install', () => {
    const autoUpdaterRef = getAutoUpdaterRef();
    const updateState = getUpdateState();

    if (!autoUpdaterRef || updateState.phase !== 'downloaded') {
      return { ok: false, reason: 'not-downloaded' };
    }
    logLine('updater: kullanıcı onayladı → quitAndInstall');
    noteQuit('update');
    setImmediate(() => {
      try {
        autoUpdaterRef.quitAndInstall();
      } catch (err) {
        logLine(`updater: quitAndInstall hata (${err && err.message})`);
      }
    });
    return { ok: true };
  });

  ipcMain.handle('update:dismiss', () => {
    const updateState = getUpdateState();
    if (updateState.latestVersion) {
      agentSettings.writeSettings({ updateDismissedVersion: updateState.latestVersion });
    }
    pushUpdateState();
    return updateStateForRenderer();
  });
}

module.exports = { registerUpdateIpc };
