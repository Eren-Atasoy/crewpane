'use strict';

const { BrowserWindow } = require('electron');

/**
 * Office IPC Handlers (Faz 3.5 — Sıra 2)
 * Channels: office:exportPack, office:readPack, office:state:get,
 *           office:state:set, office:recover
 */
function registerOfficeIpc({
  ipcMain,
  officePkg,
  readOfficeState,
  writeOfficeState,
  keepPanesAliveOnWindowClose,
  crashWatchdog,
  getAppWindow = () => null,
  getAppBaseUrl = () => null,
  ptys,
  createAppWindow,
  logLine = () => {},
}) {
  let officeRecoveryHistory = [];

  ipcMain.handle('office:exportPack', async (_event, payload) => {
    const pack = payload && payload.pack;
    const skills = (payload && payload.skills) || [];
    try {
      logLine(`office:exportPack başla → ${pack && pack.meta && pack.meta.name}`);
      const result = await officePkg.handleExportOfficePack(pack, skills, {});
      if (result.ok) logLine(`office:exportPack OK → ${result.path} (${result.bytes} bayt)`);
      else logLine(`office:exportPack FAIL → ${result.error}`);
      return result;
    } catch (err) {
      logLine(`office:exportPack crash → ${err.message}`);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('office:readPack', async (_event, zipPath) => {
    if (!zipPath || typeof zipPath !== 'string') {
      return { ok: false, error: 'Dosya yolu gerekli' };
    }
    try {
      logLine(`office:readPack başla → ${zipPath}`);
      const result = await officePkg.handleReadOfficePack(zipPath);
      if (result.ok) {
        logLine(`office:readPack OK → ${result.pack.meta && result.pack.meta.name} (${result.skills.length} skill)`);
      } else {
        logLine(`office:readPack FAIL → ${result.error}`);
      }
      return result;
    } catch (err) {
      logLine(`office:readPack crash → ${err.message}`);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.on('office:state:get', (event) => { event.returnValue = readOfficeState(); });
  ipcMain.handle('office:state:set', (_event, state) => writeOfficeState(state));

  ipcMain.handle('office:recover', (event, payload) => {
    const action = payload && typeof payload === 'object' ? String(payload.action || '') : '';
    if (process.env.CREWPANE_E2E_NO_OFFICE_SHELL_RECOVERY === '1') {
      if (action === 'capabilities') return { ok: true, reloadRenderer: false, recreateWindow: false };
      return { ok: false, reason: 'e2e-disabled' };
    }
    const win = BrowserWindow.fromWebContents(event.sender);
    const alive = !!(win && !win.isDestroyed());
    const appWindow = getAppWindow();
    const canRecreate = alive && win === appWindow && keepPanesAliveOnWindowClose();
    if (action === 'capabilities') {
      return { ok: true, reloadRenderer: alive, recreateWindow: canRecreate };
    }
    if (!alive) return { ok: false, reason: 'no-window' };

    const { reload, history } = crashWatchdog.decideReload(officeRecoveryHistory, Date.now());
    officeRecoveryHistory = history;
    if (!reload) {
      logLine(
        `HATA-06 office:recover REDDEDİLDİ (${action}) — ${history.length} deneme / `
          + `${crashWatchdog.RELOAD_WINDOW_MS}ms bütçesi doldu; statik görünümde kalınıyor`,
      );
      return { ok: false, reason: 'budget-exhausted' };
    }
    if (action === 'reload-renderer') {
      logLine(`HATA-06 office:recover: renderer yeniden yükleniyor (deneme ${history.length}/${crashWatchdog.MAX_RELOADS}) — pane'lere DOKUNULMUYOR`);
      setTimeout(() => { try { win.reload(); } catch (e) { logLine(`office:recover reload hata: ${e.message}`); } }, 250);
      return { ok: true, started: true };
    }
    if (action === 'recreate-window') {
      if (!canRecreate) {
        logLine('HATA-06 office:recover: pencere yeniden yaratma REDDEDİLDİ — bu platformda pane\'ler pencere kapanışında ölür');
        return { ok: false, reason: 'would-kill-panes' };
      }
      logLine(`HATA-06 office:recover: pencere yeniden yaratılıyor (deneme ${history.length}/${crashWatchdog.MAX_RELOADS}) — ${ptys.size} pane YAŞAMAYA DEVAM EDER`);
      const url = getAppBaseUrl();
      setTimeout(() => {
        try {
          win.close();
          createAppWindow(url);
        } catch (e) {
          logLine(`office:recover pencere yeniden yaratma hata: ${e.message}`);
        }
      }, 250);
      return { ok: true, started: true };
    }
    return { ok: false, reason: 'unknown-action' };
  });
}

module.exports = { registerOfficeIpc };
