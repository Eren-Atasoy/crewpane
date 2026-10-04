'use strict';

const { BrowserWindow, screen } = require('electron');
const handOverlayContract = require('../../../src/hand/handOverlayContract.cjs');
const agentSettings = require('../../../src/agents/agentSettings.cjs');
const { tagTestWindow } = require('./tagTestWindow');

const handOverlayWindows = new Map(); // displayId → BrowserWindow
let handOverlayLastFeedAt = null; // son geçerli telemetri olayının saati (ms)
let handOverlayWatchdog = null; // akış bekçisi (yalnız pencereler açıkken)
let handOverlayScreenHooked = false; // display olay dinleyicileri bir kez takılır
let handOverlayLastCost = null; // renderer'ın bildirdiği çizim bedeli (rapor/e2e)

function handTuningConfig(prefs) {
  const t = (prefs && prefs.tuning) || {};
  const cfg = {};
  for (const key of ['zoomBackMax', 'zoomBackMin', 'enter', 'release']) {
    if (typeof t[key] === 'number' && Number.isFinite(t[key])) cfg[key] = t[key];
  }
  return cfg;
}

function handOverlayPrefs() {
  return handOverlayContract.sanitizeHandControl(agentSettings.readSettings().handControl);
}

function handOverlayAnyAlive() {
  for (const win of handOverlayWindows.values()) {
    if (win && !win.isDestroyed()) return true;
  }
  return false;
}

function getHandOverlayLastCost() {
  return handOverlayLastCost;
}

function setHandOverlayLastCost(cost) {
  handOverlayLastCost = cost;
}

function getHandOverlayLastFeedAt() {
  return handOverlayLastFeedAt;
}

function getHandOverlayDebugInfo() {
  const wins = [];
  for (const [id, win] of handOverlayWindows) {
    if (!win || win.isDestroyed()) continue;
    wins.push({
      displayId: id,
      bounds: win.getBounds(),
      alwaysOnTop: win.isAlwaysOnTop(),
      focusable: typeof win.isFocusable === 'function' ? win.isFocusable() : null,
      visible: win.isVisible(),
    });
  }
  return {
    open: handOverlayAnyAlive(),
    lastFeedAt: handOverlayLastFeedAt,
    lastCost: handOverlayLastCost,
    windows: wins,
  };
}

function stopHandOverlayWatchdog() {
  if (handOverlayWatchdog) {
    clearInterval(handOverlayWatchdog);
    handOverlayWatchdog = null;
  }
}

function startHandOverlayWatchdog() {
  if (handOverlayWatchdog) return;
  handOverlayWatchdog = setInterval(() => {
    const verdict = handOverlayContract.feedVerdict(handOverlayLastFeedAt, Date.now());
    if (verdict.action === 'close') closeHandOverlayWindows(`akış kesildi (${verdict.reason})`);
  }, handOverlayContract.WATCHDOG_TICK_MS);
}

function closeHandOverlayWindows(reason, logLine = () => {}) {
  const had = handOverlayAnyAlive();
  for (const win of handOverlayWindows.values()) {
    try {
      if (win && !win.isDestroyed()) win.close();
    } catch {
      /* kapanışta pencere yarışı zararsız */
    }
  }
  handOverlayWindows.clear();
  stopHandOverlayWatchdog();
  if (had) logLine(`hand overlay kapandı (${reason || 'istek'})`);
  return { ok: true, closed: had };
}

function rebuildHandOverlayWindows(deps = {}) {
  if (!handOverlayAnyAlive()) return;
  const plan = handOverlayContract.planWindows(screen.getAllDisplays());
  const planKey = JSON.stringify(plan.map((p) => [p.displayId, p.bounds]));
  const currentKey = JSON.stringify(
    [...handOverlayWindows.entries()]
      .filter(([, w]) => w && !w.isDestroyed())
      .map(([id, w]) => [
        id,
        (() => {
          const b = w.getBounds();
          return { x: b.x, y: b.y, width: b.width, height: b.height };
        })(),
      ]),
  );
  if (planKey === currentKey) return;
  closeHandOverlayWindows('ekran değişti', deps.logLine);
  if (handOverlayContract.feedVerdict(handOverlayLastFeedAt, Date.now()).action === 'keep') {
    openHandOverlayWindows(deps);
  }
}

function hookHandOverlayScreenEvents(deps = {}) {
  if (handOverlayScreenHooked) return;
  handOverlayScreenHooked = true;
  screen.on('display-added', () => rebuildHandOverlayWindows(deps));
  screen.on('display-removed', () => rebuildHandOverlayWindows(deps));
  screen.on('display-metrics-changed', () => rebuildHandOverlayWindows(deps));
}

function openHandOverlayWindows(deps = {}) {
  const {
    getAppBaseUrl = () => null,
    sharedWebPreferences,
    logLine = () => {},
    isTest = false,
  } = deps;

  const appBaseUrl = getAppBaseUrl();
  if (!appBaseUrl) return { ok: false, error: 'uygulama adresi yok' };
  if (!handOverlayPrefs().overlay.enabled) return { ok: false, error: 'overlay ayarı kapalı' };
  if (handOverlayAnyAlive()) return { ok: true, reused: true, count: handOverlayWindows.size };

  const plan = handOverlayContract.planWindows(screen.getAllDisplays());
  for (const p of plan) {
    const win = new BrowserWindow({
      ...p.bounds,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullScreenable: false,
      enableLargerThanScreen: true,
      skipTaskbar: true,
      focusable: false,
      alwaysOnTop: true,
      ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
      show: false,
      title: 'CrewPane — El kontrolü',
      webPreferences: sharedWebPreferences(),
    });
    tagTestWindow(win, 'CrewPane — El kontrolü', isTest);
    try {
      win.setAlwaysOnTop(true, 'screen-saver');
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      win.setIgnoreMouseEvents(true, { forward: true });
      win.setBounds(p.bounds);
    } catch (err) {
      logLine(`hand overlay: pencere bayrakları ayarlanamadı: ${err.message}`);
    }
    win.on('closed', () => {
      for (const [id, w] of handOverlayWindows) {
        if (w === win) handOverlayWindows.delete(id);
      }
      if (!handOverlayAnyAlive()) stopHandOverlayWatchdog();
    });
    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return;
      win.showInactive();
      try {
        win.setBounds(p.bounds);
      } catch {
        /* pencere kapanma yarışı zararsız */
      }
    });
    win.loadURL(`${appBaseUrl}/hand-overlay?display=${encodeURIComponent(p.displayId)}`);
    handOverlayWindows.set(p.displayId, win);
  }
  hookHandOverlayScreenEvents(deps);
  startHandOverlayWatchdog();
  logLine(`hand overlay açıldı: ${plan.length} ekran (${plan.map((p) => p.displayId).join(',')})`);
  return { ok: true, count: plan.length };
}

function feedHandOverlay(rawEvents, deps = {}) {
  const list = Array.isArray(rawEvents) ? rawEvents : [rawEvents];
  const events = [];
  for (const raw of list) {
    const ev = handOverlayContract.normalizeEvent(raw);
    if (ev) events.push(ev);
  }
  if (!events.length) return { ok: false, error: 'geçerli olay yok' };
  handOverlayLastFeedAt = Date.now();
  if (!handOverlayAnyAlive()) {
    if (!handOverlayPrefs().overlay.enabled) return { ok: false, error: 'overlay ayarı kapalı' };
    openHandOverlayWindows(deps);
  }
  for (const win of handOverlayWindows.values()) {
    if (win && !win.isDestroyed()) win.webContents.send('handOverlay:events', events);
  }
  return { ok: true, accepted: events.length };
}

function applyHandOverlaySettings() {
  const prefs = handOverlayPrefs();
  if (!prefs.overlay.enabled) {
    closeHandOverlayWindows('ayar kapatıldı');
    return;
  }
  for (const win of handOverlayWindows.values()) {
    if (win && !win.isDestroyed()) win.webContents.send('handOverlay:config', prefs.overlay);
  }
}

module.exports = {
  handOverlayWindows,
  handTuningConfig,
  handOverlayPrefs,
  handOverlayAnyAlive,
  getHandOverlayLastCost,
  setHandOverlayLastCost,
  getHandOverlayLastFeedAt,
  getHandOverlayDebugInfo,
  openHandOverlayWindows,
  closeHandOverlayWindows,
  rebuildHandOverlayWindows,
  hookHandOverlayScreenEvents,
  startHandOverlayWatchdog,
  stopHandOverlayWatchdog,
  feedHandOverlay,
  applyHandOverlaySettings,
};
