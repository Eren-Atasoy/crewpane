'use strict';

const guestPermissions = require('../../../platform/guestPermissions.cjs');
const { attachHtmlFullscreenGuard } = require('./htmlFullscreenGuard');

// WIN-FIX-01 (W5) — misafir oturumuna izin politikasını BİR KEZ bağla.
const boundGuestSessions = new WeakSet();

function applyGuestPermissionPolicy(ses, { logLine = () => {} } = {}) {
  if (!ses || boundGuestSessions.has(ses)) return false;
  try {
    ses.setPermissionRequestHandler((wc, permission, callback) => {
      const verdict = guestPermissions.decide(permission);
      if (!verdict.granted) {
        let origin = '?';
        try {
          origin = (wc && wc.getURL && new URL(wc.getURL()).origin) || '?';
        } catch {
          /* about:blank vb. */
        }
        logLine(`webview izin REDDEDİLDİ: ${permission} (${origin}) — sebep=${verdict.reason}`);
      }
      callback(verdict.granted);
    });

    ses.setPermissionCheckHandler((_wc, permission) => guestPermissions.decide(permission).granted);
    boundGuestSessions.add(ses);
    logLine(`webview izin politikası bağlandı (izinli: ${guestPermissions.ALLOWED.join(', ')}; diğer HEPSİ ret)`);
    return true;
  } catch (e) {
    logLine(`webview izin politikası BAĞLANAMADI (${e.message}) → oturum Electron varsayılanında (izinler AÇIK)`);
    return false;
  }
}

function attachWebviewGuards(win, deps) {
  const {
    logLine = () => {},
    shell,
    getAppWindow = () => null,
    browserGuests,
    ghostGuests,
    guestOwners,
    agentGuests,
    getPendingAgentTabs = () => 0,
    setAppWindowGuest = () => {},
    getAppWindowGuest = () => null,
    lastUnownedGuest = () => null,
  } = deps;

  const wc = win.webContents;

  // Before a guest attaches, neuter its webPreferences regardless of what the
  // <webview> tag asked for: no preload, no node, isolated + sandboxed.
  wc.on('will-attach-webview', (_event, webPreferences, params) => {
    delete webPreferences.preload;
    delete webPreferences.preloadURL;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    logLine('webview will-attach: ' + (params && params.src ? params.src : '(no src)'));
  });

  // After attach, govern the guest's navigation surface.
  wc.on('did-attach-webview', (_event, guest) => {
    try {
      guest.setWindowOpenHandler(({ url: target }) => {
        if (/^https?:/.test(target)) {
          try {
            const appWin = getAppWindow();
            if (appWin && !appWin.isDestroyed()) {
              appWin.webContents.send('browser:new-tab', { url: target });
            }
          } catch {
            /* best-effort */
          }
          logLine('webview new-tab (in-app): ' + target);
        } else if (/^mailto:/.test(target)) {
          if (shell) shell.openExternal(target);
        }
        return { action: 'deny' };
      });
    } catch {
      /* best-effort */
    }

    applyGuestPermissionPolicy(guest.session, { logLine });

    guest.on('will-navigate', (_e, target) => logLine('webview will-navigate: ' + target));
    guest.on('did-navigate', (_e, target) => logLine('webview did-navigate: ' + target));
    guest.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (code === -3) return; // -3 (ABORTED) normaldir
      logLine(`webview did-fail-load: code=${code} "${desc}" url=${url} mainFrame=${!!isMainFrame}`);
    });
    guest.on('render-process-gone', (_e, details) => {
      logLine(`webview render-process-gone: reason=${details && details.reason} exit=${details && details.exitCode}`);
    });
    guest.on('unresponsive', () => logLine('webview unresponsive (render süreci yanıt vermiyor)'));
    guest.on('responsive', () => logLine('webview responsive (yanıt vermeye döndü)'));

    attachHtmlFullscreenGuard(win, guest, logLine);

    if (browserGuests) browserGuests.set(guest.id, guest);

    if (getPendingAgentTabs() > 0) {
      logLine(
        `[adp396] ajan sekmesi attach oldu (id=${guest.id}, bekleyen=${getPendingAgentTabs()}) → İNSAN yolu hedefi korunuyor`,
      );
    } else {
      setAppWindowGuest(guest);
      logLine(`[adp396] sahipsiz sekme attach (id=${guest.id}) → İNSAN yolu hedefi`);
    }

    guest.once('destroyed', () => {
      if (browserGuests) browserGuests.delete(guest.id);
      const ghostSet = typeof ghostGuests === 'function' ? ghostGuests() : ghostGuests;
      if (ghostSet) ghostSet.delete(guest.id);
      if (guestOwners) {
        const owner = guestOwners.get(guest.id);
        if (owner) {
          guestOwners.delete(guest.id);
          if (agentGuests && agentGuests.get(owner) === guest) agentGuests.delete(owner);
        }
      }
      if (getAppWindowGuest() === guest) {
        setAppWindowGuest(lastUnownedGuest());
      }
    });

    logLine('webview attached: CDP target ready (headed automation)');
  });
}

module.exports = {
  applyGuestPermissionPolicy,
  attachWebviewGuards,
};
