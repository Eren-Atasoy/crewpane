'use strict';

const fs = require('node:fs');
const { BrowserWindow, shell, Notification, app } = require('electron');
const { tagTestWindow } = require('./tagTestWindow');
const { attachWebviewGuards } = require('./webviewGuards');
const { attachHtmlFullscreenGuard } = require('./htmlFullscreenGuard');

/**
 * Creates the main application window that loads the embedded Next server.
 */
function createAppWindow(url, deps) {
  const {
    logLine = () => {},
    sharedWebPreferences,
    APP_PROBE = false,
    PROBE_WAIT = 5000,
    PROBE_CLICKS = 0,
    PROBE_PATH = '',
    START_PATH = '',
    isTest = false,
    rebindOrphanPanes = () => {},
    restoreLivePanes = () => {},
    startPtyResumeDaemonOnce = () => {},
    ptys = new Map(),
    noteQuit = () => {},
    crashWatchdog,
    appI18n,
    keepPanesAliveOnWindowClose = () => false,
    liveAgentPaneCount = () => 0,
    killPtysForWindow = () => {},
    quitFunnel,
    AUTOTEST = false,
    armQuitBrake = () => {},
    broadcastJarvisWidget = () => {},
    reportsWatcher,
    getAgentWorkspaceRoot = () => null,
    activeWorktreePaths = () => [],
    mappedProjectRootsForReports = () => [],
    setAppWindow = () => {},
    setAppBaseUrl = () => {},
    setPanesRestored = () => {},
  } = deps;

  logLine('boot: ana uygulama penceresi açılıyor (lisans durumu çözülmüş olmalı)');

  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    title: 'CrewPane',
    show: !APP_PROBE || !!process.env.CREWPANE_PROBE_SHOT,
    backgroundColor: '#0d0f17',
    autoHideMenuBar: true,
    webPreferences: { ...sharedWebPreferences(), webviewTag: true },
  });

  attachWebviewGuards(win, deps);
  tagTestWindow(win, 'CrewPane', isTest);

  win.webContents.once('did-finish-load', () => {
    rebindOrphanPanes(win);
    restoreLivePanes(win);
    startPtyResumeDaemonOnce();
  });

  try {
    win.webContents.session.setPermissionRequestHandler((wc, permission, callback) => {
      const granted = permission === 'media';
      callback(granted);
    });
  } catch (e) {
    logLine(`permission handler wire error: ${e.message}`);
  }

  if (APP_PROBE) {
    win.webContents.on('did-finish-load', async () => {
      setTimeout(async () => {
        try {
          const proof = await win.webContents.executeJavaScript(
            `(async () => {
              for (let i = 0; i < ${PROBE_CLICKS}; i++) {
                const add = document.querySelector('[title="New terminal"]');
                if (add) add.click();
                await new Promise((r) => setTimeout(r, 900));
              }
              return JSON.stringify({ title: document.title, hasApp: !!document.querySelector("main, #__next, [data-crewpane]"), xterms: document.querySelectorAll(".xterm").length, bodyLen: document.body.innerText.length });
            })()`,
          );
          logLine('app-probe loaded: ' + proof + ` livePtys=${ptys.size} paneIds=[${[...ptys.keys()].join(',')}]`);
          const shot = process.env.CREWPANE_PROBE_SHOT;
          if (shot) {
            try {
              const img = await win.webContents.capturePage();
              fs.writeFileSync(shot, img.toPNG());
              logLine('app-probe screenshot saved: ' + shot);
            } catch (e) {
              logLine('app-probe screenshot error: ' + e.message);
            }
          }
        } catch (e) {
          logLine('app-probe eval error: ' + e.message);
        }
        noteQuit('probe');
        app.quit();
      }, PROBE_WAIT);
    });
    setTimeout(() => {
      logLine('app-probe watchdog timeout');
      noteQuit('probe', 'watchdog-timeout');
      app.quit();
    }, 30000);
  }

  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:|^mailto:/.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith(url)) {
      event.preventDefault();
      if (/^https?:/.test(target)) shell.openExternal(target);
    }
  });

  win.webContents.on('will-prevent-unload', (event) => {
    if (!app.isQuitting) return;
    logLine('[quit] beforeunload kutusu bastırıldı (kasıtlı kapanış) — uygulama askıda kalmaz');
    event.preventDefault();
  });

  let renderCrashHistory = [];
  win.webContents.on('render-process-gone', (_e, details) => {
    logLine('RENDERER GONE: ' + JSON.stringify(details));
    if (win.isDestroyed()) return;
    if (crashWatchdog && !crashWatchdog.isRecoverableGone(details && details.reason)) return;
    if (crashWatchdog) {
      const { reload, history } = crashWatchdog.decideReload(renderCrashHistory, Date.now());
      renderCrashHistory = history;
      if (reload) {
        logLine(`render-process-gone RECOVERY: reloading window (attempt ${history.length}/${crashWatchdog.MAX_RELOADS} in window)`);
        try {
          win.reload();
        } catch (e) {
          logLine(`render-process-gone recovery reload failed: ${e.message}`);
        }
      } else {
        logLine(`render-process-gone RECOVERY GIVING UP: ${history.length} crashes within ${crashWatchdog.RELOAD_WINDOW_MS}ms — not reloading again`);
        try {
          new Notification({
            title: appI18n.t('main.notify.crashLoop.title'),
            body: appI18n.t('main.notify.crashLoop.body'),
          }).show();
        } catch {
          /* headless / notifications unavailable */
        }
      }
    }
  });

  let unresponsiveSince = null;
  win.webContents.on('unresponsive', () => {
    unresponsiveSince = Date.now();
    logLine('RENDERER UNRESPONSIVE');
  });
  win.webContents.on('responsive', () => {
    if (unresponsiveSince) {
      logLine(`renderer responsive again after ${Date.now() - unresponsiveSince}ms`);
      unresponsiveSince = null;
    }
  });

  win.on('closed', () => {
    if (keepPanesAliveOnWindowClose()) {
      const agents = liveAgentPaneCount();
      setPanesRestored(false);
      logLine(
        `ADP-905 window-close: pencere kapandı ama ${ptys.size} pane (${agents} ajan) ` +
          "YAŞIYOR — macOS'ta uygulama Dock'ta sürüyor, pty'lere dokunulmadı " +
          '(dock ikonuna basınca geri gelirler)',
      );
    } else {
      killPtysForWindow(win.id);
      if (quitFunnel) {
        const verdict = quitFunnel.decideQuitOnMainWindowClose({
          platform: process.platform,
          autotest: AUTOTEST,
        });
        if (verdict.quit && !app.isQuitting) {
          const aux = BrowserWindow.getAllWindows().filter((w) => w !== win && !w.isDestroyed()).length;
          logLine(`HATA-14 main-window-closed: ÇIKILIYOR (${verdict.reason}) — ${aux} yardımcı pencere açıktı`);
          armQuitBrake('window-close');
          noteQuit('user-quit', 'main-window-closed');
          app.quit();
        }
      }
    }
    setAppWindow(null);
    broadcastJarvisWidget();
  });

  attachHtmlFullscreenGuard(win, win.webContents, logLine);

  const sendWindowVisible = () => {
    try {
      if (!win.isDestroyed()) win.webContents.send('app:window-visible', win.isVisible() && !win.isMinimized());
    } catch {
      /* pencere kapanıyor — best-effort */
    }
  };
  for (const ev of ['show', 'hide', 'minimize', 'restore']) win.on(ev, sendWindowVisible);

  const attachReportsWatcher = () => {
    if (win._reportsWatch) {
      try {
        win._reportsWatch.close();
      } catch {
        /* already gone */
      }
    }
    if (reportsWatcher && reportsWatcher.createReportsWatcher) {
      win._reportsWatch = reportsWatcher.createReportsWatcher({
        workspaceRoot: getAgentWorkspaceRoot(),
        worktreePaths: activeWorktreePaths(),
        projectRoots: mappedProjectRootsForReports(),
        log: logLine,
        onChange: () => {
          try {
            if (!win.isDestroyed()) win.webContents.send('reports:changed', { at: Date.now() });
          } catch {
            /* pencere kapanıyor — best-effort */
          }
        },
      });
      logLine(`reports watcher: ${win._reportsWatch.dirs.length} dizin izleniyor, ${win._reportsWatch.pendingAncestors.length} aday bekleniyor (root=${getAgentWorkspaceRoot() ?? '-'})`);
    }
  };
  win._attachReportsWatcher = attachReportsWatcher;
  attachReportsWatcher();
  win.on('closed', () => {
    try {
      win._reportsWatch?.close();
    } catch {
      /* best-effort */
    }
  });

  setAppWindow(win);
  setAppBaseUrl(url);
  win.loadURL(url + (PROBE_PATH || START_PATH));
  return win;
}

module.exports = {
  createAppWindow,
};
