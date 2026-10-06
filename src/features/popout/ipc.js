'use strict';

/**
 * Popout IPC Handlers (Faz 3.5 — Sıra 2)
 * Channels: popout:open, popout:close, popout:list, popout:toggleMaximize, popout:state
 */
function registerPopoutIpc({
  ipcMain,
  openPopoutWindow,
  closePopoutWindow,
  listPopoutPanes,
  popoutWindowFor,
  logLine = () => {},
}) {
  ipcMain.handle('popout:open', (_event, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    try {
      return openPopoutWindow({ paneId: p.paneId, title: p.title, agentId: p.agentId });
    } catch (err) {
      logLine(`popout:open error: ${err.message}`);
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle('popout:close', (_event, paneId) => {
    try {
      return closePopoutWindow(paneId);
    } catch (err) {
      logLine(`popout:close error: ${err.message}`);
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle('popout:list', () => listPopoutPanes());

  ipcMain.handle('popout:toggleMaximize', (_event, paneId) => {
    const win = popoutWindowFor(paneId);
    if (!win) return { ok: false, error: 'dışarıda değil' };
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return { ok: true, paneId, maximized: win.isMaximized() };
  });

  ipcMain.handle('popout:state', (_event, paneId) => {
    const win = popoutWindowFor(paneId);
    if (!win) return null;
    return { paneId, maximized: win.isMaximized() };
  });
}

module.exports = { registerPopoutIpc };
