'use strict';

const handDisplayRouter = require('../../hand/handDisplayRouter.cjs');

const HAND_CURSOR_POLL_MS = 250;
const HAND_DISPLAYS_TTL_MS = 1000;

function normalizeDisplaysCache(screen, c, now) {
  if (c.displaysCache && now - c.displaysCache.at < HAND_DISPLAYS_TTL_MS) {
    return c.displaysCache.list;
  }
  let list = [];
  try {
    list = handDisplayRouter.normalizeDisplays(screen.getAllDisplays());
  } catch {
    list = [];
  }
  c.displaysCache = { at: now, list };
  return list;
}

function pollCursorTick({ c, screen, handDisplays, handWindowBounds, applyHandTargetDisplay }) {
  const displays = handDisplays();
  if (displays.length < 2) return;
  const wd = handDisplayRouter.displayForBounds(displays, handWindowBounds());
  if (wd && wd.id !== c.windowDisplayId) {
    c.windowDisplayId = wd.id;
    applyHandTargetDisplay(wd, 'CrewPane penceresi bu ekrana taşındı');
    return;
  }
  let point = null;
  try {
    point = screen.getCursorScreenPoint();
  } catch {
    return;
  }
  const next = handDisplayRouter.followRealCursor({
    point,
    lastApplied: c.cursor ? c.cursor.lastPos : null,
    displays,
    currentId: c.targetDisplayId,
  });
  if (next) {
    applyHandTargetDisplay(handDisplayRouter.displayById(displays, next), 'gerçek fare o ekrana taşındı');
  }
}

/**
 * Hand Display & Multi-Monitor Tracking Service (Faz 3.6.6)
 */
function createHandDisplayService({
  screen,
  handControl,
  getAppWindow = () => null,
  handControlLive = () => false,
  broadcastHandControlStatus = () => {},
  logLine = () => {},
}) {
  let handTargetHooked = false;

  function handDisplays() {
    return normalizeDisplaysCache(screen, handControl, Date.now());
  }

  function handWindowBounds() {
    try {
      const win = getAppWindow();
      return win && !win.isDestroyed() ? win.getBounds() : null;
    } catch {
      return null;
    }
  }

  function applyHandTargetDisplay(display, reason) {
    const c = handControl;
    if (!display || !c.engine) return false;
    const idChanged = c.targetDisplayId !== display.id;
    const boundsChanged = c.engine.setTarget(display.bounds);
    c.targetDisplayId = display.id;
    if (!idChanged && !boundsChanged) return false;
    if (c.edgeTracker) c.edgeTracker.reset();
    logLine(`hand-control hedef ekran → #${handDisplayRouter.displayOrdinal(handDisplays(), display.id)} `
      + `id=${display.id} ${display.label || ''} ${display.width}×${display.height}@${display.scaleFactor} `
      + `(${display.x},${display.y}) — ${reason}`);
    broadcastHandControlStatus();
    return true;
  }

  function retargetHandDisplay(reason) {
    const c = handControl;
    c.displaysCache = null;
    if (!handControlLive()) return;
    const displays = handDisplays();
    const target = handDisplayRouter.resolveTarget(displays, {
      currentId: c.targetDisplayId,
      windowBounds: handWindowBounds(),
    });
    applyHandTargetDisplay(target, reason);
  }

  function hookHandTargetEvents() {
    if (handTargetHooked || !screen) return;
    handTargetHooked = true;
    for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) {
      screen.on(ev, () => retargetHandDisplay(`ekran takımı değişti (${ev})`));
    }
  }

  function updateHandEdgeSwitch() {
    const c = handControl;
    if (!c.engine || !c.edgeTracker) return [];
    const displays = handDisplays();
    const display = handDisplayRouter.displayById(displays, c.targetDisplayId);
    if (!display) return [];
    const lc = c.engine.lastCursor;
    const res = c.edgeTracker.update({
      point: lc ? { x: lc[0], y: lc[1] } : null,
      display,
      displays,
      now: Date.now(),
      handPresent: c.engine.handPresent,
    });
    if (res.switchTo) {
      applyHandTargetDisplay(handDisplayRouter.displayById(displays, res.switchTo), 'kenar vuruşu (durum 19)');
    }
    return res.events;
  }

  function startHandCursorPoll() {
    stopHandCursorPoll();
    handControl.cursorPoll = setInterval(() => {
      if (handControlLive()) {
        pollCursorTick({
          c: handControl,
          screen,
          handDisplays,
          handWindowBounds,
          applyHandTargetDisplay,
        });
      }
    }, HAND_CURSOR_POLL_MS);
    if (handControl.cursorPoll.unref) handControl.cursorPoll.unref();
  }

  function stopHandCursorPoll() {
    if (handControl.cursorPoll) clearInterval(handControl.cursorPoll);
    handControl.cursorPoll = null;
  }

  return {
    handDisplays,
    handWindowBounds,
    applyHandTargetDisplay,
    retargetHandDisplay,
    hookHandTargetEvents,
    updateHandEdgeSwitch,
    startHandCursorPoll,
    stopHandCursorPoll,
  };
}

module.exports = {
  createHandDisplayService,
  HAND_CURSOR_POLL_MS,
  HAND_DISPLAYS_TTL_MS,
};
