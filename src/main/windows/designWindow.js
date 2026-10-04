'use strict';

const { BrowserWindow, screen, shell } = require('electron');
const popoutBounds = require('../../../src/services/popoutBounds.cjs');

let designWindow = null;
const DESIGN_WINDOW_KEY = popoutBounds.boundsKey({ title: 'design-window' });
const DESIGN_WINDOW_MIN = { width: 900, height: 600 };

/** Canlı tasarım penceresi (yoksa/yıkıldıysa null). */
function designWindowAlive() {
  return designWindow && !designWindow.isDestroyed() ? designWindow : null;
}

function getDesignWindow() {
  return designWindow;
}

function setDesignWindow(win) {
  designWindow = win;
}

/** Ana penceredeki giriş düğmesi gerçeği yansıtsın (pencere açık mı). */
function notifyDesignWindowOpen(deps = {}) {
  const { getAppWindow = () => null } = deps;
  const appWin = getAppWindow();
  if (appWin && !appWin.isDestroyed()) {
    appWin.webContents.send('design:openState', { open: !!designWindowAlive() });
  }
}

function openDesignWindow(deps) {
  const {
    getAppBaseUrl = () => null,
    crewpaneHome = () => null,
    sharedWebPreferences,
    logLine = () => {},
    designPlanDenial = () => null,
  } = deps;

  const planGate = designPlanDenial();
  if (planGate) {
    logLine(`design window: plan tavanı — açılmadı (katman=${planGate.tier}); docs/design ağacı diskte KORUNUYOR`);
    return {
      ok: false,
      reason: 'plan_limit',
      error: planGate.message,
      denial: planGate,
      requiredTierLabel: planGate.requiredTierLabel,
    };
  }

  const existing = designWindowAlive();
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    logLine('design window: zaten açık → öne getirildi (tekillik)');
    return { ok: true, reused: true };
  }

  const appBaseUrl = getAppBaseUrl();
  if (!appBaseUrl) return { ok: false, error: 'uygulama adresi yok' };

  let workArea = null;
  try {
    workArea = screen.getPrimaryDisplay().workArea;
  } catch {
    workArea = null;
  }
  const saved = popoutBounds.openBounds(
    popoutBounds.loadBoundsStore(crewpaneHome()),
    DESIGN_WINDOW_KEY,
    workArea,
  );
  const bounds = typeof saved.x === 'number'
    ? saved
    : { width: 1440, height: 900, ...(workArea ? { x: workArea.x + 40, y: workArea.y + 40 } : {}) };

  const win = new BrowserWindow({
    ...bounds,
    minWidth: DESIGN_WINDOW_MIN.width,
    minHeight: DESIGN_WINDOW_MIN.height,
    title: 'Tasarım — CrewPane',
    backgroundColor: '#0d0f17',
    autoHideMenuBar: true,
    show: false,
    webPreferences: sharedWebPreferences(),
  });
  designWindow = win;

  // ⌘W = pencereyi kapat
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return;
    if ((input.meta || input.control) && String(input.key).toLowerCase() === 'w') {
      if (!win.isDestroyed()) win.close();
    }
  });

  win.on('close', () => {
    try {
      popoutBounds.rememberBounds(DESIGN_WINDOW_KEY, win.getBounds(), crewpaneHome());
    } catch {
      /* best-effort */
    }
  });
  win.on('closed', () => {
    if (designWindow === win) designWindow = null;
    logLine('design window kapandı');
    notifyDesignWindowOpen(deps);
  });
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:|^mailto:/.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });

  win.loadURL(`${appBaseUrl}/design`);
  logLine(`design window açıldı bounds=${JSON.stringify(bounds)}`);
  notifyDesignWindowOpen(deps);
  return { ok: true, reused: false };
}

/** Tasarım penceresini kapat. Tasarım dosyalarına/pty'lere DOKUNMAZ. */
function closeDesignWindow() {
  const win = designWindowAlive();
  if (!win) return { ok: false, error: 'tasarım penceresi açık değil' };
  win.close();
  return { ok: true };
}

module.exports = {
  DESIGN_WINDOW_KEY,
  DESIGN_WINDOW_MIN,
  designWindowAlive,
  getDesignWindow,
  setDesignWindow,
  notifyDesignWindowOpen,
  openDesignWindow,
  closeDesignWindow,
};
