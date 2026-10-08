'use strict';

const defaultBrowserCdp = require('../../services/browserCdp.js');
const defaultBrowserGateMod = require('../../security/browserGate.cjs');

const GHOST_IDLE_MS = 8000;
const NEEDS_COMPOSITE = new Set(['click', 'type', 'screenshot']);

/**
 * TEK GÜVENİLİR SİNYAL (ADP-392 ölçümü): kare üretmeyen guest'te Page.captureScreenshot
 * HİÇ dönmez. O yüzden hazırlık probu = küçük bir kareyi zaman sınırıyla çekebilmek.
 */
async function producesFrame(guest, ms = 900) {
  let timer;
  const capped = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  const shot = guest.debugger
    .sendCommand('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 1,
      clip: { x: 0, y: 0, width: 8, height: 8, scale: 1 },
    })
    .then(() => true)
    .catch(() => false);
  try {
    return await Promise.race([shot, capped]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ADP-399 (görünürlük) — patron ajanın tarayıcıda NE yaptığını görsün: eylem + hedef +
 * SİTE (origin) + ajan.
 */
function dispatchBrowserActivity(appWindow, guest, value) {
  try {
    if (!appWindow || appWindow.isDestroyed()) return;
    let origin = null;
    try {
      const u = typeof guest.getURL === 'function' ? guest.getURL() : '';
      origin = u ? new URL(u).host || u : null;
    } catch {
      origin = null;
    }
    appWindow.webContents.send('browser:activity', {
      action: value && value.action,
      selector: (value && value.selector) || null,
      agentId: (value && value.agentId) || null,
      origin,
      owned: Boolean(value && value.agentId),
      at: Date.now(),
    });
  } catch {
    /* activity feedback is best-effort */
  }
}

/**
 * ADP-135 / ADP-884 — CDP eylemi OLMAYAN gezinme eylemleri: back, forward, reload.
 */
function handleNavHistoryAction(guest, action, logLine) {
  if (action === 'back') {
    const nav = guest.navigationHistory;
    if (nav && typeof nav.canGoBack === 'function' && nav.canGoBack()) nav.goBack();
    else if (typeof guest.canGoBack === 'function' && guest.canGoBack()) guest.goBack();
    else return { handled: true, result: { ok: false, error: 'no back history' } };
    logLine('browser back');
    return { handled: true, result: { ok: true, result: { ok: true, action: 'back' } } };
  }
  if (action === 'forward') {
    const nav = guest.navigationHistory;
    if (nav && typeof nav.canGoForward === 'function' && nav.canGoForward()) nav.goForward();
    else if (typeof guest.canGoForward === 'function' && guest.canGoForward()) guest.goForward();
    else return { handled: true, result: { ok: false, error: 'no forward history' } };
    logLine('browser forward');
    return { handled: true, result: { ok: true, result: { ok: true, action: 'forward' } } };
  }
  if (action === 'reload') {
    if (typeof guest.reload !== 'function') return { handled: true, result: { ok: false, error: 'reload unsupported' } };
    guest.reload();
    logLine('browser reload');
    return { handled: true, result: { ok: true, result: { ok: true, action: 'reload' } } };
  }
  return { handled: false };
}

/**
 * ADP-095 — navigate via the webContents (headed, visible), not CDP Page.navigate.
 */
function createCdpNavigateHelper(guest) {
  return (url) =>
    new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        guest.removeListener('did-stop-loading', finish);
        guest.removeListener('did-finish-load', finish);
        guest.removeListener('did-fail-load', finish);
        resolve();
      };
      guest.on('did-stop-loading', finish);
      guest.on('did-finish-load', finish);
      guest.on('did-fail-load', finish);
      try {
        void guest.loadURL(url);
      } catch {
        finish();
      }
      setTimeout(finish, 8000).unref?.();
    });
}

const DEFAULT_BROWSER_DEPS = {
  getAppWindow: () => null,
  logLine: () => {},
  saveBrowserShot: () => {},
  getAppWindowGuest: () => null,
  setAppWindowGuest: () => {},
  lastUnownedGuest: null,
  incPendingAgentTabs: null,
  decPendingAgentTabs: null,
  browserCdp: defaultBrowserCdp,
  browserGateMod: defaultBrowserGateMod,
};

class BrowserService {
  constructor(deps = {}) {
    const opts = Object.assign({}, DEFAULT_BROWSER_DEPS, deps);
    this._getAppWindow = opts.getAppWindow;
    this._logLine = opts.logLine;
    this._saveBrowserShot = opts.saveBrowserShot;
    this._browserGuests = opts.browserGuests || new Map();
    this._guestOwners = opts.guestOwners || new Map();
    this._agentGuests = opts.agentGuests || new Map();
    this._getAppWindowGuest = opts.getAppWindowGuest;
    this._setAppWindowGuest = opts.setAppWindowGuest;
    this._isOwnedGuest = opts.isOwnedGuest || ((id) => this.isOwnedGuest(id));
    this._lastUnownedGuest = opts.lastUnownedGuest;
    this._incPendingAgentTabs = opts.incPendingAgentTabs;
    this._decPendingAgentTabs = opts.decPendingAgentTabs;
    this._pendingAgentTabs = typeof opts.pendingAgentTabs === 'number' ? opts.pendingAgentTabs : 0;
    this._browserCdp = opts.browserCdp;
    this._browserGateMod = opts.browserGateMod;

    this.ghostGuests = new Set();
    this.ghostTimer = null;
  }

  get browserGuests() {
    return this._browserGuests;
  }

  get guestOwners() {
    return this._guestOwners;
  }

  get agentGuests() {
    return this._agentGuests;
  }

  get pendingAgentTabs() {
    return this._pendingAgentTabs;
  }

  isOwnedGuest(id) {
    return this._guestOwners.has(id);
  }

  lastUnownedGuest() {
    if (typeof this._lastUnownedGuest === 'function') {
      return this._lastUnownedGuest();
    }
    const unowned = [...this._browserGuests.values()].filter((g) => !g.isDestroyed() && !this.isOwnedGuest(g.id));
    return unowned.length ? unowned[unowned.length - 1] : null;
  }

  incPendingAgentTabs() {
    this._pendingAgentTabs++;
    if (typeof this._incPendingAgentTabs === 'function') {
      this._incPendingAgentTabs();
    }
  }

  decPendingAgentTabs() {
    if (this._pendingAgentTabs > 0) {
      this._pendingAgentTabs--;
    }
    if (typeof this._decPendingAgentTabs === 'function') {
      this._decPendingAgentTabs();
    }
  }

  sendGhost(guestId, on) {
    try {
      const win = this._getAppWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('browser:composite', { guestId, on });
      }
    } catch {
      /* best-effort */
    }
  }

  scheduleGhostRelease() {
    if (this.ghostTimer) clearTimeout(this.ghostTimer);
    this.ghostTimer = setTimeout(() => {
      this.ghostTimer = null;
      if (this.ghostGuests.size === 0) return;
      for (const id of this.ghostGuests) this.sendGhost(id, false);
      this._logLine(`[adp394] hayalet mod kapandı (${this.ghostGuests.size} guest boşta) — GPU/pil tasarrufu`);
      this.ghostGuests.clear();
    }, GHOST_IDLE_MS);
    this.ghostTimer.unref?.();
  }

  async ensureGuestComposited(guest, action) {
    this.ghostGuests.add(guest.id);
    this.sendGhost(guest.id, true);
    if (!NEEDS_COMPOSITE.has(action)) return null;
    const deadline = Date.now() + 4000;
    for (;;) {
      if (guest.isDestroyed()) throw new Error('sekme kapandı — otomasyon sürülemez');
      const vp = await this._browserCdp.readViewport(guest.debugger).catch(() => ({ w: 0, h: 0 }));
      if (vp.w * vp.h > 0 && (await producesFrame(guest))) {
        this._logLine(`[adp394] guest ${guest.id} kompoze edildi (${vp.w}×${vp.h}) — hayalet mod`);
        return vp;
      }
      if (Date.now() > deadline) {
        throw new Error(
          'sekme kompoze edilemedi (guest kare üretmiyor) — tıklama inmez, işlem YAPILMADI (tarayıcı paneli kapalı/gizli olabilir)',
        );
      }
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  async resolveAgentGuest(agentId) {
    const owned = this._agentGuests.get(agentId);
    this._logLine(`[adp333] resolve agent=${agentId} owned=${owned ? owned.id : 'YOK'} guests=[${[...this._browserGuests.keys()].join(',')}] owners=${JSON.stringify([...this._guestOwners.entries()])}`);
    if (owned && !owned.isDestroyed()) return owned;
    this._agentGuests.delete(agentId);
    const win = this._getAppWindow();
    if (!win || win.isDestroyed()) {
      throw new Error('uygulama penceresi kapalı — ajan sekmesi açılamıyor');
    }
    this.incPendingAgentTabs();
    try {
      win.webContents.send('browser:agent-tab', { agentId, url: 'about:blank' });
      const deadline = Date.now() + 10000;
      for (;;) {
        const g = this._agentGuests.get(agentId);
        if (g && !g.isDestroyed()) return g;
        if (Date.now() > deadline) {
          throw new Error(`ajan sekmesi açılamadı (${agentId}) — kullanıcının sekmesi KULLANILMAZ, işlem yapılmadı`);
        }
        await new Promise((r) => setTimeout(r, 150));
      }
    } finally {
      this.decPendingAgentTabs();
    }
  }

  async resolveGuestFor(value) {
    const agentId = value && typeof value.agentId === 'string' ? value.agentId.trim() : '';
    if (agentId) return this.resolveAgentGuest(agentId);

    let guest = this._getAppWindowGuest();
    if (guest && !guest.isDestroyed() && this.isOwnedGuest(guest.id)) {
      this._logLine(`[adp396] insan hedefi SAHİPLİ guest'e işaret ediyordu (${this._guestOwners.get(guest.id)}) → sahipsiz sekmeye dönülüyor`);
      guest = this.lastUnownedGuest();
      this._setAppWindowGuest(guest);
    }
    if (!guest || guest.isDestroyed()) {
      throw new Error('internal browser not open (no guest webContents attached). Open the Browser tab in the app.');
    }
    return guest;
  }

  async probeBrowserTarget(value) {
    const guest = await this.resolveGuestFor(value);
    const url = typeof guest.getURL === 'function' ? guest.getURL() : '';
    const selector = value && typeof value.selector === 'string' ? value.selector : '';
    if (!selector) return { url, elementInfo: null };
    const info = await this._browserCdp.readElementInfo(guest.debugger, selector);
    return { url, elementInfo: info.elementInfo, found: info.found };
  }

  browserGate() {
    return this._browserGateMod.getBrowserGate({ log: this._logLine });
  }

  async runBrowserAction(value) {
    let guest;
    try {
      guest = await this.resolveGuestFor(value);
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }

    dispatchBrowserActivity(this._getAppWindow(), guest, value);

    const action = value && value.action;
    const historyResult = handleNavHistoryAction(guest, action, this._logLine);
    if (historyResult.handled) {
      return historyResult.result;
    }

    try {
      await this.ensureGuestComposited(guest, action);
      const result = await this._browserCdp.runCdpAction(guest.debugger, value, {
        saveScreenshot: this._saveBrowserShot,
        log: this._logLine,
        navigate: createCdpNavigateHelper(guest),
      });
      return { ok: true, result };
    } catch (err) {
      this._logLine(`browser action error (${action}): ${err.message}`);
      return { ok: false, error: String(err.message || err) };
    } finally {
      this.scheduleGhostRelease();
    }
  }
}

function createBrowserService(deps = {}) {
  return new BrowserService(deps);
}

module.exports = {
  createBrowserService,
  BrowserService,
  producesFrame,
  dispatchBrowserActivity,
  handleNavHistoryAction,
  createCdpNavigateHelper,
};
