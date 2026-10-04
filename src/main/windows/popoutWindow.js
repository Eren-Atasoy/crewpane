'use strict';

const { BrowserWindow, screen, shell } = require('electron');
const popoutBounds = require('../../../src/services/popoutBounds.cjs');

const popoutWindows = new Map(); // paneId → BrowserWindow

/** Canlı pop-out penceresi (yoksa/yıkıldıysa null). */
function popoutWindowFor(paneId) {
  const w = popoutWindows.get(paneId);
  if (!w || w.isDestroyed()) return null;
  return w;
}

/** ADP-712 — bu pencere bir pop-out mu (öyleyse hangi pane'in)? Değilse null. */
function popoutPaneIdForWindow(win) {
  if (!win || win.isDestroyed()) return null;
  for (const [paneId, w] of popoutWindows) {
    if (w && !w.isDestroyed() && w.id === win.id) return paneId;
  }
  return null;
}

/**
 * ADP-593 — pane olayını (pty:data / pty:exit) SAHİP pencereye ve varsa o pane'in
 * pop-out penceresine yolla.
 */
function sendPaneEvent(win, paneId, channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  const pop = popoutWindowFor(paneId);
  if (pop) pop.webContents.send(channel, payload);
}

/** Ana pencereye pop-out durum olayı (renderer hücreyi dışarıda/geri işaretler). */
function notifyPopoutState(channel, payload, deps = {}) {
  const { getAppWindow = () => null } = deps;
  const appWin = getAppWindow();
  if (appWin && !appWin.isDestroyed()) appWin.webContents.send(channel, payload);
}

/**
 * Pane'i ayrı bir pencereye çıkar. Zaten dışarıdaysa o pencereyi öne getirir.
 * → { ok, paneId } | { ok:false, error }
 */
function openPopoutWindow({ paneId, title, agentId }, deps) {
  if (typeof paneId !== 'string' || !paneId) return { ok: false, error: 'paneId yok' };
  const {
    ptys = new Map(),
    getAppBaseUrl = () => null,
    crewpaneHome = () => null,
    sharedWebPreferences,
    logLine = () => {},
  } = deps;

  const entry = ptys.get(paneId);
  if (!entry) return { ok: false, error: 'pane yok' };
  const appBaseUrl = getAppBaseUrl();
  if (!appBaseUrl) return { ok: false, error: 'uygulama adresi yok' };

  const existing = popoutWindowFor(paneId);
  if (existing) {
    existing.show();
    existing.focus();
    return { ok: true, paneId, reused: true };
  }

  const label = (typeof title === 'string' && title.trim()) || entry.label || paneId;
  const key = popoutBounds.boundsKey({ agentId: agentId ?? entry.agentId, title: label });
  let workArea = null;
  try {
    workArea = screen.getPrimaryDisplay().workArea;
  } catch {
    workArea = null;
  }
  const bounds = popoutBounds.openBounds(popoutBounds.loadBoundsStore(crewpaneHome()), key, workArea);

  const win = new BrowserWindow({
    ...bounds,
    minWidth: popoutBounds.MIN_SIZE.width,
    minHeight: popoutBounds.MIN_SIZE.height,
    title: `${label} — CrewPane`,
    backgroundColor: '#0d0f17',
    autoHideMenuBar: true,
    show: false,
    webPreferences: sharedWebPreferences(),
  });
  popoutWindows.set(paneId, win);

  // ⌘W = "geri koy" (pencereyi kapat)
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown') return;
    if ((input.meta || input.control) && String(input.key).toLowerCase() === 'w') {
      if (!win.isDestroyed()) win.close();
    }
  });

  // ADP-712 — pencere durumu (maximized) bildirimi
  const sendWindowState = () => {
    if (!win.isDestroyed()) win.webContents.send('popout:state', { paneId, maximized: win.isMaximized() });
  };
  win.on('maximize', sendWindowState);
  win.on('unmaximize', sendWindowState);

  // Kapanırken son konum/boyut hatırlanır
  win.on('close', () => {
    try {
      popoutBounds.rememberBounds(key, win.getBounds(), crewpaneHome());
    } catch {
      /* best-effort */
    }
  });

  // KRİTİK: burada pty'ye HİÇBİR ŞEY yapılmaz (kill YOK). Yalnız görünüm geri döner.
  win.on('closed', () => {
    popoutWindows.delete(paneId);
    logLine(`popout closed paneId=${paneId} (pty korunuyor, ptys=${ptys.size})`);
    notifyPopoutState('popout:closed', { paneId }, deps);
  });

  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:|^mailto:/.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });

  const q = `?paneId=${encodeURIComponent(paneId)}&title=${encodeURIComponent(label)}`;
  win.loadURL(`${appBaseUrl}/popout${q}`);
  logLine(`popout opened paneId=${paneId} label=${label} bounds=${JSON.stringify(bounds)}`);
  return { ok: true, paneId };
}

/** Pop-out penceresini kapat (= pane'i eski hücresine geri koy). pty'ye dokunmaz. */
function closePopoutWindow(paneId) {
  const win = popoutWindowFor(paneId);
  if (!win) return { ok: false, error: 'dışarıda değil' };
  win.close();
  return { ok: true, paneId };
}

/** Şu an dışarıda olan pane'ler (renderer reload sonrası durum hidrasyonu). */
function listPopoutPanes() {
  const out = [];
  for (const [paneId, win] of popoutWindows) {
    if (win && !win.isDestroyed()) out.push(paneId);
  }
  return out;
}

/** ADP-712 — görünüm tercihi değişti: ANA pencere + TÜM pop-out pencereleri duysun. */
function broadcastPaneView(paneId, readable, deps = {}) {
  const { getAppWindow = () => null } = deps;
  const payload = { paneId, readable };
  const appWin = getAppWindow();
  if (appWin && !appWin.isDestroyed()) appWin.webContents.send('paneView:changed', payload);
  for (const w of popoutWindows.values()) {
    if (w && !w.isDestroyed()) w.webContents.send('paneView:changed', payload);
  }
}

/** ADP-786 — taslak değişti: aynı pane'i gösteren DİĞER yüzeyler de görsün. */
function broadcastPaneDraft(paneId, text, deps = {}) {
  const { getAppWindow = () => null } = deps;
  const payload = { paneId, text };
  const appWin = getAppWindow();
  if (appWin && !appWin.isDestroyed()) appWin.webContents.send('paneDraft:changed', payload);
  for (const w of popoutWindows.values()) {
    if (w && !w.isDestroyed()) w.webContents.send('paneDraft:changed', payload);
  }
}

/** ADP-935 — pano geçmişi değişti (ana pencere + pop-out'lar). */
function broadcastClipChanged(deps = {}) {
  const { getAppWindow = () => null } = deps;
  const appWin = getAppWindow();
  if (appWin && !appWin.isDestroyed()) appWin.webContents.send('clip:changed');
  for (const w of popoutWindows.values()) {
    if (w && !w.isDestroyed()) w.webContents.send('clip:changed');
  }
}

module.exports = {
  popoutWindows,
  popoutWindowFor,
  popoutPaneIdForWindow,
  sendPaneEvent,
  notifyPopoutState,
  openPopoutWindow,
  closePopoutWindow,
  listPopoutPanes,
  broadcastPaneView,
  broadcastPaneDraft,
  broadcastClipChanged,
};
