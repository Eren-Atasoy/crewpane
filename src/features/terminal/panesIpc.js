'use strict';

/**
 * Panes & Terminal Management IPC Handlers
 * Channels:
 *   - panes:restoreRecoverable
 *   - tmux:selectWindow
 *   - paneView:get, paneView:set
 *   - paneDraft:get, paneDraft:set
 *   - paneAsk:list, paneAsk:answer, paneAsk:dismiss
 */
function registerPanesIpc({
  ipcMain,
  BrowserWindow,
  acceptRecoverablePanes = () => ({ ok: false }),
  tmuxWindows = null,
  paneViewState = null,
  broadcastPaneView = () => {},
  paneDraft = null,
  broadcastPaneDraft = () => {},
  paneAskRuntime = null,
  getPaneAskRuntime = () => paneAskRuntime,
  logLine = () => {},
}) {
  // ADP-734 Kapı 2 — "N pane kurtarılabilir" teklifini UYGULA.
  ipcMain.handle('panes:restoreRecoverable', (event) =>
    acceptRecoverablePanes(BrowserWindow.fromWebContents(event.sender)));

  // ADP-136 — auto-switch the operator's tmux window to the team Jarvis is about to delegate to
  ipcMain.handle('tmux:selectWindow', (_event, department) => {
    try {
      if (!tmuxWindows) return { ok: false, reason: 'no-tmux' };
      const res = tmuxWindows.selectWindowForDepartment(department);
      logLine(`tmux:selectWindow dept=${department ?? '-'} ok=${res.ok} target=${res.target ?? '-'} reason=${res.reason ?? '-'}`);
      return res;
    } catch (err) {
      return { ok: false, reason: 'error', error: String((err && err.message) || err) };
    }
  });

  // ADP-712 — PANE GÖRÜNÜM DURUMU
  ipcMain.handle('paneView:get', (_event, paneId) => {
    if (!paneViewState) return { readable: false };
    return paneViewState.getPaneView(paneId);
  });

  ipcMain.handle('paneView:set', (_event, payload) => {
    if (!paneViewState) return { ok: false };
    const p = payload && typeof payload === 'object' ? payload : {};
    const res = paneViewState.setPaneView(p.paneId, p);
    if (res.ok && res.changed) broadcastPaneView(res.paneId, res.readable);
    return res;
  });

  // ADP-786 — GÖNDERİLMEMİŞ PROMPT TASLAĞI
  ipcMain.handle('paneDraft:get', (_event, paneId) => {
    if (!paneDraft) return { text: '' };
    return paneDraft.getPaneDraft(paneId);
  });

  ipcMain.handle('paneDraft:set', (_event, payload) => {
    if (!paneDraft) return { ok: false };
    const p = payload && typeof payload === 'object' ? payload : {};
    const res = paneDraft.setPaneDraft(p.paneId, p.text);
    if (res.ok && res.changed) broadcastPaneDraft(res.paneId, res.text);
    return res;
  });

  // ASK-CARD-01 (FB-1009) — LİDERİN KARAR SORUSU
  ipcMain.handle('paneAsk:list', () => {
    const runtime = getPaneAskRuntime();
    return runtime ? runtime.list() : [];
  });

  ipcMain.handle('paneAsk:answer', (_e, p) => {
    const runtime = getPaneAskRuntime();
    if (!runtime) return { ok: false };
    const o = p && typeof p === 'object' ? p : {};
    return runtime.answer({
      askId: String(o.askId || ''),
      choiceId: typeof o.choiceId === 'string' && o.choiceId ? o.choiceId : null,
      text: typeof o.text === 'string' ? o.text : '',
      via: 'card',
    });
  });

  ipcMain.handle('paneAsk:dismiss', (_e, askId) => {
    const runtime = getPaneAskRuntime();
    return runtime ? runtime.dismiss(String(askId || '')) : { ok: false };
  });
}

module.exports = { registerPanesIpc };
