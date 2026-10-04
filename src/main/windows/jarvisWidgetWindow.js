'use strict';

const { BrowserWindow, screen, shell } = require('electron');
const popoutBounds = require('../../../src/services/popoutBounds.cjs');
const jarvisWidget = require('../../../src/voice/jarvisWidget.cjs');
const { tagTestWindow } = require('./tagTestWindow');

let jarvisWidgetWindow = null;
let jarvisWidgetSnapshot = jarvisWidget.emptySnapshot();
const JARVIS_WIDGET_KEY = popoutBounds.boundsKey({ title: 'jarvis-widget' });

/** Canlı widget penceresi (yoksa/yıkıldıysa null). */
function jarvisWidgetAlive() {
  return jarvisWidgetWindow && !jarvisWidgetWindow.isDestroyed() ? jarvisWidgetWindow : null;
}

function getJarvisWidgetWindow() {
  return jarvisWidgetWindow;
}

function setJarvisWidgetWindow(win) {
  jarvisWidgetWindow = win;
}

function getJarvisWidgetSnapshot() {
  return jarvisWidgetSnapshot;
}

function setJarvisWidgetSnapshot(snapshot) {
  jarvisWidgetSnapshot = snapshot;
}

/**
 * Widget'a giden fotoğraf.
 */
function jarvisWidgetPayload(deps = {}) {
  const { getAppWindow = () => null } = deps;
  const appWin = getAppWindow();
  return { ...jarvisWidgetSnapshot, live: !!(appWin && !appWin.isDestroyed()) };
}

/** Fotoğraf değişti → widget penceresi (varsa) duysun. */
function broadcastJarvisWidget(deps = {}) {
  const w = jarvisWidgetAlive();
  if (w) w.webContents.send('jarvisWidget:changed', jarvisWidgetPayload(deps));
}

/** Ana penceredeki düğme gerçeği yansıtsın (widget açık mı). */
function notifyJarvisWidgetOpen(deps = {}) {
  const { getAppWindow = () => null } = deps;
  const appWin = getAppWindow();
  if (appWin && !appWin.isDestroyed()) {
    appWin.webContents.send('jarvisWidget:openState', { open: !!jarvisWidgetAlive() });
  }
}

/** Widget'ın oturduğu ekranın çalışma alanı. */
function jarvisWidgetWorkArea(bounds) {
  try {
    const display = bounds ? screen.getDisplayMatching(bounds) : screen.getPrimaryDisplay();
    return display ? display.workArea : null;
  } catch {
    return null;
  }
}

/** Widget penceresini aç (zaten açıksa ODAK ÇALMADAN öne getirir). */
function openJarvisWidgetWindow(deps) {
  const existing = jarvisWidgetAlive();
  if (existing) {
    existing.showInactive();
    return { ok: true, reused: true };
  }

  const {
    getAppBaseUrl = () => null,
    crewpaneHome = () => null,
    sharedWebPreferences,
    logLine = () => {},
    isTest = false,
  } = deps;

  const appBaseUrl = getAppBaseUrl();
  if (!appBaseUrl) return { ok: false, error: 'uygulama adresi yok' };

  const workArea = jarvisWidgetWorkArea(null);
  const store = popoutBounds.loadBoundsStore(crewpaneHome());
  const saved = popoutBounds.openBounds(store, JARVIS_WIDGET_KEY, workArea);
  const bounds = typeof saved.x === 'number'
    ? { x: saved.x, y: saved.y, ...jarvisWidget.SIZE }
    : jarvisWidget.defaultBounds(workArea);

  const win = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullScreenable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
    show: false,
    title: 'CrewPane — Ses',
    webPreferences: sharedWebPreferences(),
  });
  jarvisWidgetWindow = win;
  tagTestWindow(win, 'CrewPane — Ses', isTest);

  try {
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch (err) {
    logLine(`jarvis widget: always-on-top ayarlanamadı: ${err.message}`);
  }

  win.on('close', () => {
    try {
      popoutBounds.rememberBounds(JARVIS_WIDGET_KEY, win.getBounds(), crewpaneHome());
    } catch {
      /* best-effort */
    }
  });
  win.on('closed', () => {
    if (jarvisWidgetWindow === win) jarvisWidgetWindow = null;
    logLine('jarvis widget kapandı');
    notifyJarvisWidgetOpen(deps);
  });
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.showInactive();
  });
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:|^mailto:/.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('did-finish-load', () => {
    if (!win.isDestroyed()) win.webContents.send('jarvisWidget:changed', jarvisWidgetPayload(deps));
  });

  win.loadURL(`${appBaseUrl}/jarvis-widget`);
  logLine(`jarvis widget açıldı bounds=${JSON.stringify(bounds)}`);
  notifyJarvisWidgetOpen(deps);
  return { ok: true, bounds };
}

/** Widget penceresini kapat. */
function closeJarvisWidgetWindow() {
  const win = jarvisWidgetAlive();
  if (!win) return { ok: false, error: 'widget açık değil' };
  win.close();
  return { ok: true };
}

/** Sürükleme. */
function moveJarvisWidget(payload) {
  const win = jarvisWidgetAlive();
  if (!win) return { ok: false, error: 'widget açık değil' };
  const cur = win.getBounds();
  const next = jarvisWidget.nextPosition(
    cur,
    payload && payload.dx,
    payload && payload.dy,
    jarvisWidgetWorkArea(cur),
  );
  win.setBounds(next);
  return { ok: true, bounds: win.getBounds() };
}

module.exports = {
  JARVIS_WIDGET_KEY,
  jarvisWidgetAlive,
  getJarvisWidgetWindow,
  setJarvisWidgetWindow,
  getJarvisWidgetSnapshot,
  setJarvisWidgetSnapshot,
  jarvisWidgetPayload,
  broadcastJarvisWidget,
  notifyJarvisWidgetOpen,
  jarvisWidgetWorkArea,
  openJarvisWidgetWindow,
  closeJarvisWidgetWindow,
  moveJarvisWidget,
};
