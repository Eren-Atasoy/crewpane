'use strict';

const defaultDictationDelivery = require('../../voice/dictationDelivery.cjs');

/**
 * Dictation Delivery Service (Phase 3.6.66)
 * Delivers dictation text to the focused surface (app window or popout pane)
 * and dispatches the crewpane:dictation-delivered DOM event.
 */
function createDictationDeliveryService({
  BrowserWindow,
  getAppWindow = () => null,
  logLine = () => {},
  dictationDelivery = defaultDictationDelivery,
} = {}) {
  async function deliverDictationToFocusedSurface(text) {
    const win = (BrowserWindow && typeof BrowserWindow.getFocusedWindow === 'function'
      ? BrowserWindow.getFocusedWindow()
      : null) || getAppWindow();
    if (!win || win.isDestroyed()) return { ok: false, error: 'no app window' };

    const wc = win.webContents;
    const res = await dictationDelivery.deliverDictation(text, {
      probe: () => wc.executeJavaScript(dictationDelivery.FOCUS_PROBE_JS),
      insertText: async (t) => { wc.insertText(t); },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      log: logLine,
    });

    if (res && res.ok) {
      try {
        wc.executeJavaScript(
          "window.dispatchEvent(new CustomEvent('crewpane:dictation-delivered'))",
        ).catch(() => {});
      } catch {
        /* event dispatch is best-effort */
      }
    }
    return res;
  }

  return {
    deliverDictationToFocusedSurface,
  };
}

module.exports = {
  createDictationDeliveryService,
};
