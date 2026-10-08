'use strict';

const electron = require('electron');
const { HandControlEngine } = require('../../hand/handControlCore.cjs');
const { HandCursor } = require('../../hand/handCursor.cjs');
const { ZoomRouter, normalizeZoomSurface } = require('../../hand/handZoomRouter.cjs');
const handDisplayRouter = require('../../hand/handDisplayRouter.cjs');
const { createHandDisplayService } = require('./handDisplayService');
const { createHandCameraService } = require('./handCameraService');

const HAND_SHORTCUT = 'CommandOrControl+Shift+H';
const HAND_STALL_MS = 2000;
const HAND_STALL_STOP_MS = 6000;

function createInitialHandState() {
  return {
    phase: 'off',
    win: null,
    engine: null,
    cursor: null,
    warm: null,
    camera: null,
    ax: null,
    lastFrameAt: 0,
    lastError: null,
    emergency: null,
    watchdog: null,
    stalledSince: 0,
    shortcutOk: null,
    startedAt: 0,
    cameraDevice: null,
    cameraCandidates: [],
    cameraBlank: null,
    targetDisplayId: null,
    windowDisplayId: null,
    edgeTracker: null,
    cursorPoll: null,
    displaysCache: null,
    zoomSurfaces: new Map(),
    zoomTarget: null,
    sampler: null,
  };
}

function prepareCursorBackend(handPrefs, logLine) {
  let HandCursorClass = HandCursor;
  try {
    const fresh = require('../../hand/handCursor.cjs');
    if (fresh && fresh.HandCursor) HandCursorClass = fresh.HandCursor;
  } catch {
    /* fallback to static require */
  }
  const cursor = new HandCursorClass(null, {
    onEvent: (e) => logLine(`hand-cursor ${JSON.stringify(e)}`),
    zoomModifier: handPrefs.zoom.modifier,
  });
  if (!cursor.available) {
    return { ok: false, error: `imleç arka ucu yok: ${cursor.info.error || cursor.info.platform}` };
  }
  if (!cursor.info.verified) {
    return { ok: false, error: `imleç arka ucu '${cursor.info.platform}' bu makinede doğrulanmadı` };
  }
  return { ok: true, cursor };
}

function setupEngineInstance({ c, displays, handPrefs, displayService, screen, handTuningConfig, handZoomFocusedSurface, handZoomSend }) {
  const startTarget = handDisplayRouter.displayForBounds(displays, displayService.handWindowBounds())
    || (screen ? handDisplayRouter.normalizeDisplays([screen.getPrimaryDisplay()])[0] : null);
  c.targetDisplayId = startTarget ? startTarget.id : null;
  c.windowDisplayId = c.targetDisplayId;
  c.edgeTracker = new handDisplayRouter.EdgeSwitchTracker();
  c.zoomRouter = new ZoomRouter({
    cursor: c.cursor,
    focusedSurface: handZoomFocusedSurface,
    sendZoom: handZoomSend,
  });
  const defaultBounds = screen ? screen.getPrimaryDisplay().bounds : { x: 0, y: 0, width: 1920, height: 1080 };
  c.engine = new HandControlEngine({
    cursor: c.zoomRouter,
    target: startTarget ? startTarget.bounds : defaultBounds,
    fsmConfig: { zoomEnabled: handPrefs.zoom.enabled && handPrefs.zoom.oneHand, ...handTuningConfig(handPrefs) },
    twoHandConfig: { enabled: handPrefs.zoom.enabled && handPrefs.zoom.twoHand },
  });
  return startTarget;
}

function buildHandControlStatusReport({ c, displayService, cameraService, handPoseMetrics, handPoseChannel }) {
  const list = displayService.handDisplays();
  const d = handDisplayRouter.displayById(list, c.targetDisplayId);
  return {
    phase: c.phase,
    warm: c.warm,
    camera: c.camera,
    ax: c.ax,
    cursor: c.cursor ? c.cursor.info : (c.engine ? c.engine.cursor.info : null),
    shortcut: { accelerator: HAND_SHORTCUT, registered: c.shortcutOk },
    cameraDevice: c.cameraDevice,
    cameraCandidates: c.cameraCandidates,
    cameraBlank: c.cameraBlank,
    cameraPreference: cameraService.handCameraPreference(),
    targetDisplay: d ? {
      id: d.id,
      index: handDisplayRouter.displayOrdinal(list, d.id),
      label: d.label,
      internal: d.internal,
      bounds: d.bounds,
      scaleFactor: d.scaleFactor,
    } : null,
    displayCount: list.length,
    fps: c.engine ? c.engine.fps : 0,
    garbageFrames: c.engine ? c.engine.garbageFrames : 0,
    lastAspect: c.engine ? c.engine.lastAspect : null,
    zoom: {
      surfaces: Array.from(c.zoomSurfaces.values()),
      routed: c.zoomRouter ? { ...c.zoomRouter.routed } : null,
      posted: c.cursor ? c.cursor.posted : null,
      twoHandPossible: c.warm && c.warm.numHands != null ? c.warm.numHands >= 2 : null,
    },
    pose: c.engine ? { metrics: handPoseMetrics(), channel: handPoseChannel() } : null,
    dragging: c.cursor ? c.cursor.dragging : null,
    lastFrameAt: c.lastFrameAt || null,
    startedAt: c.startedAt || null,
    emergency: c.emergency,
    error: c.lastError,
  };
}

function processOverlayEvents(out, edgeEvents, feedHandOverlay) {
  const overlayEvents = edgeEvents.length ? out.overlayEvents.concat(edgeEvents) : out.overlayEvents;
  if (overlayEvents.length) {
    try {
      feedHandOverlay(overlayEvents);
    } catch {
      /* overlay kapalı olabilir */
    }
  }
}

function createShortcutManager({ globalShortcut, handControl, onEmergency, logLine }) {
  function registerHandShortcut() {
    if (!globalShortcut) return;
    try {
      handControl.shortcutOk = globalShortcut.register(HAND_SHORTCUT, () => {
        onEmergency('kısayol ⌘⇧H');
      });
    } catch (err) {
      handControl.shortcutOk = false;
      handControl.lastError = `kısayol: ${err.message}`;
    }
    logLine(`hand-control kısayol '${HAND_SHORTCUT}' registered=${handControl.shortcutOk}`);
  }

  function unregisterHandShortcut() {
    if (!globalShortcut) return;
    try {
      globalShortcut.unregister(HAND_SHORTCUT);
    } catch {
      /* not registered */
    }
    handControl.shortcutOk = null;
  }

  return { registerHandShortcut, unregisterHandShortcut };
}

function createWatchdogManager({ handControl, broadcastHandControlStatus, onStop, logLine }) {
  function startHandWatchdog() {
    stopHandWatchdog();
    handControl.watchdog = setInterval(() => {
      const c = handControl;
      if (c.phase !== 'on' && c.phase !== 'stalled') return;
      const silent = Date.now() - (c.lastFrameAt || c.startedAt);
      if (silent > HAND_STALL_MS) {
        if (c.phase === 'on') {
          c.phase = 'stalled';
          c.stalledSince = Date.now();
          broadcastHandControlStatus();
          logLine(`hand-control: motor ${silent} ms sessiz → stalled`);
        } else if (Date.now() - c.stalledSince > HAND_STALL_STOP_MS) {
          onStop('motor sessiz kaldı');
        }
      } else if (c.phase === 'stalled') {
        c.phase = 'on';
        broadcastHandControlStatus();
      }
    }, 1000);
    if (handControl.watchdog.unref) handControl.watchdog.unref();
  }

  function stopHandWatchdog() {
    if (handControl.watchdog) clearInterval(handControl.watchdog);
    handControl.watchdog = null;
  }

  return { startHandWatchdog, stopHandWatchdog };
}

function createPoseManager({ handControl, logLine }) {
  function handPoseMetrics() {
    const c = handControl;
    if (!c.engine) return null;
    const f = c.engine.lastFrameDbg;
    if (!f || !f.hand) return { hand: false, fps: c.engine.fps, aspect: c.engine.lastAspect };
    return {
      hand: true,
      pinchIndex: f.pinchIndex,
      pinchMiddle: f.pinchMiddle,
      pinky: f.pinky,
      scale: f.scale,
      backMean: f.backMean,
      indexArch: f.indexArch,
      aspect: c.engine.lastAspect,
      twoFingers: f.twoFingers,
      fps: c.engine.fps,
    };
  }

  function handPoseChannel() {
    const c = handControl;
    if (!c.engine || !c.engine.fsm) return null;
    const fsm = c.engine.fsm;
    return {
      state: c.engine.lastState,
      zoomChannel: Boolean(fsm._zoomChannel),
      precision: Boolean(fsm.precision),
      twoHandActive: Boolean(c.engine.twoHand && c.engine.twoHand.active),
    };
  }

  function finishPoseSampler() {
    const box = handControl.sampler;
    if (!box) return;
    handControl.sampler = null;
    if (box.timer) clearTimeout(box.timer);
    const summary = box.sampler.summary();
    logLine(`hand-pose örnek '${box.label}': ${summary.frames} kare · elsiz ${box.emptyFrames} · metrik ${Object.keys(summary.metrics).length}`);
    box.resolve({ ok: true, label: box.label, emptyFrames: box.emptyFrames, ...summary });
  }

  function feedPoseSampler() {
    const box = handControl.sampler;
    if (!box) return;
    const m = handPoseMetrics();
    if (m && m.hand) box.sampler.push(m);
    else box.emptyFrames += 1;
    if (box.sampler.done) finishPoseSampler();
  }

  return { handPoseMetrics, handPoseChannel, feedPoseSampler, finishPoseSampler };
}

async function executeStartHandControl(opts) {
  const {
    c, cameraService, displayService, shortcutManager, watchdogManager,
    handControlStatus, broadcastHandControlStatus, openHandDetectWindow,
    handOverlayPrefs, handTuningConfig, systemPreferences, screen,
    handZoomFocusedSurface, handZoomSend, logLine,
  } = opts;

  if (c.phase === 'on' || c.phase === 'starting') return { ok: true, already: true, status: handControlStatus() };
  c.emergency = null;
  c.lastError = null;

  const handPrefs = handOverlayPrefs();
  const cursorRes = prepareCursorBackend(handPrefs, logLine);
  if (!cursorRes.ok) {
    c.lastError = cursorRes.error;
    broadcastHandControlStatus();
    return { ok: false, error: c.lastError, status: handControlStatus() };
  }

  const cam = await cameraService.ensureCameraAccess();
  c.camera = cam;
  if (!cam.ok) {
    broadcastHandControlStatus();
    return { ok: false, error: `kamera izni: ${cam.status}`, camera: cam, status: handControlStatus() };
  }

  if (process.platform === 'darwin' && systemPreferences && systemPreferences.isTrustedAccessibilityClient) {
    try { c.ax = systemPreferences.isTrustedAccessibilityClient(true); } catch { c.ax = null; }
  }

  const opened = openHandDetectWindow();
  if (!opened.ok) {
    c.lastError = opened.error;
    broadcastHandControlStatus();
    return { ok: false, error: opened.error, status: handControlStatus() };
  }

  c.cursor = cursorRes.cursor;
  c.displaysCache = null;
  const displays = displayService.handDisplays();
  const startTarget = setupEngineInstance({
    c, displays, handPrefs, displayService, screen, handTuningConfig, handZoomFocusedSurface, handZoomSend,
  });

  c.phase = 'starting';
  c.startedAt = Date.now();
  c.cameraDevice = null;
  c.cameraBlank = null;
  if (c.win && c.win.webContents) c.win.webContents.send('handDetect:command', { cmd: 'start-camera' });

  shortcutManager.registerHandShortcut();
  watchdogManager.startHandWatchdog();
  displayService.hookHandTargetEvents();
  displayService.startHandCursorPoll();
  broadcastHandControlStatus();
  logLine(`hand-control BAŞLATILDI (kamera isteniyor) — hedef ekran #`
    + `${handDisplayRouter.displayOrdinal(displays, c.targetDisplayId)}/${displays.length} `
    + `id=${c.targetDisplayId} ${startTarget ? startTarget.label : ''}`);
  return { ok: true, status: handControlStatus() };
}

function createLifecycleManager(opts) {
  const {
    handControl, watchdogManager, shortcutManager, displayService,
    poseManager, handDetectAlive, feedHandOverlay, broadcastHandControlStatus, logLine,
  } = opts;

  function stopHandControl(reason) {
    const c = handControl;
    const wasActive = c.phase === 'on' || c.phase === 'starting' || c.phase === 'stalled';
    if (c.engine) c.engine.halt();
    if (handDetectAlive() && c.win && c.win.webContents) {
      try { c.win.webContents.send('handDetect:command', { cmd: 'stop-camera' }); } catch { /* window closing */ }
    }
    watchdogManager.stopHandWatchdog();
    shortcutManager.unregisterHandShortcut();
    displayService.stopHandCursorPoll();
    c.engine = null;
    c.cursor = null;
    c.zoomRouter = null;
    c.zoomTarget = null;
    c.edgeTracker = null;
    c.targetDisplayId = null;
    c.windowDisplayId = null;
    c.phase = handDetectAlive() && c.warm ? 'warm' : (handDetectAlive() ? 'warming' : 'off');
    c.startedAt = 0;
    c.lastFrameAt = 0;
    c.cameraDevice = null;
    c.cameraBlank = null;
    if (wasActive) logLine(`hand-control durdu (${reason || 'istek'})`);
    broadcastHandControlStatus();
    return { ok: true, stopped: wasActive };
  }

  function emergencyStopHandControl(reason) {
    handControl.emergency = reason || 'acil durdurma';
    const r = stopHandControl(`ACİL: ${reason}`);
    broadcastHandControlStatus();
    return r;
  }

  function onHandDetectFrame(event, payload) {
    const c = handControl;
    const senderValid = handDetectAlive() && c.win && event.sender === c.win.webContents;
    const phaseValid = c.engine && (c.phase === 'on' || c.phase === 'starting' || c.phase === 'stalled');
    if (!senderValid || !phaseValid) return;
    const first = c.phase !== 'on';
    c.lastFrameAt = Date.now();
    try {
      const out = c.engine.onFrame(payload || {});
      if (c.sampler) poseManager.feedPoseSampler();
      processOverlayEvents(out, displayService.updateHandEdgeSwitch(), feedHandOverlay);
    } catch (err) {
      c.lastError = `kare işleme: ${err.message}`;
      logLine(`hand-control kare hatası: ${err.message}`);
    }
    if (first && c.phase === 'starting') {
      c.phase = 'on';
      broadcastHandControlStatus();
      logLine('hand-control AÇIK — ilk tespit karesi aktı');
    }
  }

  return {
    startHandControl: () => executeStartHandControl({ ...opts, c: handControl }),
    stopHandControl,
    emergencyStopHandControl,
    onHandDetectFrame,
  };
}

/**
 * Hand Control Core Service (Faz 3.6.6)
 */
function createHandService(deps = {}) {
  const {
    BrowserWindow = electron.BrowserWindow,
    screen = electron.screen,
    systemPreferences = electron.systemPreferences,
    globalShortcut = electron.globalShortcut,
    getAppWindow = () => null,
    openHandDetectWindow = () => ({ ok: false }),
    handDetectAlive = () => false,
    feedHandOverlay = () => ({ ok: false }),
    handOverlayPrefs = () => ({ zoom: { enabled: true, oneHand: false, twoHand: true, modifier: 'Command' } }),
    handTuningConfig = () => ({}),
    agentSettings = { readSettings: () => ({}), writeSettings: () => {} },
    logLine = () => {},
  } = deps;

  const handControl = createInitialHandState();
  const handControlLive = () => {
    const p = handControl.phase;
    return Boolean(handControl.engine) && (p === 'on' || p === 'starting' || p === 'stalled');
  };

  function handZoomFocusedSurface() {
    handControl.zoomTarget = null;
    const win = BrowserWindow ? BrowserWindow.getFocusedWindow() : null;
    if (!win || win.isDestroyed()) return null;
    if (handControl.win && !handControl.win.isDestroyed() && win.id === handControl.win.id) return null;
    const surface = normalizeZoomSurface(handControl.zoomSurfaces.get(win.webContents.id));
    if (!surface) return null;
    handControl.zoomTarget = win.webContents;
    return surface;
  }

  function handZoomSend(payload) {
    const wc = handControl.zoomTarget;
    if (!wc || wc.isDestroyed()) return false;
    try {
      wc.send('handControl:zoom', payload);
      return true;
    } catch {
      return false;
    }
  }

  const displayService = createHandDisplayService({
    screen, handControl, getAppWindow, handControlLive,
    broadcastHandControlStatus: () => broadcastHandControlStatus(), logLine,
  });

  const cameraService = createHandCameraService({
    systemPreferences, handControl, agentSettings, handDetectAlive,
    broadcastHandControlStatus: () => broadcastHandControlStatus(), logLine,
  });

  const poseManager = createPoseManager({ handControl, logLine });
  const handControlStatus = () => buildHandControlStatusReport({
    c: handControl, displayService, cameraService,
    handPoseMetrics: poseManager.handPoseMetrics, handPoseChannel: poseManager.handPoseChannel,
  });

  function broadcastHandControlStatus() {
    const st = handControlStatus();
    if (BrowserWindow && BrowserWindow.getAllWindows) {
      for (const win of BrowserWindow.getAllWindows()) {
        try {
          if (!win.isDestroyed()) win.webContents.send('handControl:status', st);
        } catch { /* best effort */ }
      }
    }
    return st;
  }

  let lifecycleManager = null;
  const shortcutManager = createShortcutManager({
    globalShortcut, handControl,
    onEmergency: (r) => lifecycleManager.emergencyStopHandControl(r), logLine,
  });
  const watchdogManager = createWatchdogManager({
    handControl, broadcastHandControlStatus,
    onStop: (r) => lifecycleManager.stopHandControl(r), logLine,
  });

  lifecycleManager = createLifecycleManager({
    handControl, cameraService, displayService, shortcutManager, watchdogManager,
    poseManager, handControlStatus, broadcastHandControlStatus, openHandDetectWindow,
    handDetectAlive, feedHandOverlay, handOverlayPrefs, handTuningConfig,
    systemPreferences, screen, handZoomFocusedSurface, handZoomSend, logLine,
  });

  return {
    handControl,
    handControlLive,
    handControlStatus,
    broadcastHandControlStatus,
    handZoomFocusedSurface,
    handZoomSend,
    ...lifecycleManager,
    ...shortcutManager,
    ...watchdogManager,
    ...poseManager,
    ...displayService,
    ...cameraService,
  };
}

module.exports = {
  createHandService,
  HAND_SHORTCUT,
  HAND_STALL_MS,
  HAND_STALL_STOP_MS,
};
