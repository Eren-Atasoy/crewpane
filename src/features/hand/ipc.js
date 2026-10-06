'use strict';

const { normalizeZoomSurface } = require('../../hand/handZoomRouter.cjs');
const handPoseSampler = require('../../hand/handPoseSampler.cjs');

/**
 * Hand Control and Hand Overlay IPC Handlers (Faz 3.5 — Sıra 5)
 * Channels:
 *   - handOverlay:feed, handOverlay:init, handOverlay:isOpen, handOverlay:close, handOverlay:cost, handOverlay:debug
 *   - handControl:start, handControl:stop, handControl:status, handControl:samplePose, handControl:compareSamples, handControl:zoomSurface, handControl:selectCamera
 */
function registerHandIpc({
  ipcMain,
  screen,
  BrowserWindow,
  getHandOverlayWindows = () => new Map(),
  getHandOverlayPrefs = () => ({ overlay: {} }),
  handOverlayAnyAlive = () => false,
  closeHandOverlayWindows = () => {},
  feedHandOverlay = () => ({ ok: false }),
  getWindowManager = () => null,
  getHandControl = () => ({}),
  startHandControl = () => {},
  stopHandControl = () => {},
  handControlStatus = () => ({}),
  handControlLive = () => false,
  finishPoseSampler = () => {},
  selectHandCamera = () => {},
  logLine = () => {},
}) {
  // ── HAND-A1: Hand Overlay ──────────────────────────────────────────────────
  ipcMain.handle('handOverlay:feed', (_event, events) => {
    try {
      return feedHandOverlay(events);
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle('handOverlay:init', (event) => {
    const sender = BrowserWindow.fromWebContents(event.sender);
    const windows = getHandOverlayWindows();
    let displayId = null;
    for (const [id, win] of windows) {
      if (win === sender) {
        displayId = id;
        break;
      }
    }
    const display = screen.getAllDisplays().find((d) => String(d.id) === displayId) || null;
    return {
      ok: !!display,
      displayId,
      bounds: display ? display.bounds : null,
      scaleFactor: display ? display.scaleFactor : 1,
      overlay: getHandOverlayPrefs().overlay,
    };
  });

  ipcMain.handle('handOverlay:isOpen', () => {
    const windows = getHandOverlayWindows();
    return {
      open: handOverlayAnyAlive(),
      count: windows ? windows.size : 0,
    };
  });

  ipcMain.handle('handOverlay:close', () => closeHandOverlayWindows('istek'));

  ipcMain.handle('handOverlay:cost', (_event, payload) => {
    if (payload && typeof payload === 'object') {
      const wm = getWindowManager();
      if (wm) wm.setHandOverlayLastCost({ ...payload, at: Date.now() });
      logLine(`hand overlay bedel: display=${payload.displayId} draw_p50=${payload.drawMsP50}ms draw_p95=${payload.drawMsP95}ms fps=${payload.fps}`);
    }
    return { ok: true };
  });

  ipcMain.handle('handOverlay:debug', () => {
    const wm = getWindowManager();
    return wm ? wm.getHandOverlayDebugInfo() : { open: false };
  });

  // ── HAND-A2 / HAND-G2 / HAND-G4: Hand Control ─────────────────────────────
  ipcMain.handle('handControl:start', () => startHandControl());
  ipcMain.handle('handControl:stop', () => stopHandControl('istek'));
  ipcMain.handle('handControl:status', () => handControlStatus());

  ipcMain.handle('handControl:samplePose', (_event, opts) => {
    const c = getHandControl();
    if (!c.engine || !handControlLive()) return Promise.resolve({ ok: false, error: 'el kontrolü açık değil' });
    if (c.sampler) return Promise.resolve({ ok: false, error: 'zaten bir örnekleme sürüyor' });
    const ms = Math.max(1000, Math.min(20000, Number(opts && opts.ms) || 4000));
    const label = typeof (opts && opts.label) === 'string' ? opts.label.slice(0, 40) : 'poz';
    return new Promise((resolve) => {
      const box = {
        sampler: new handPoseSampler.PoseSampler({ ms }),
        resolve,
        label,
        emptyFrames: 0,
        timer: setTimeout(() => finishPoseSampler(), ms + 1500),
      };
      if (box.timer.unref) box.timer.unref();
      c.sampler = box;
      logLine(`hand-pose örnekleme başladı: '${label}' ${ms} ms`);
    });
  });

  ipcMain.handle('handControl:compareSamples', (_event, payload) =>
    handPoseSampler.compareSamples(payload && payload.a, payload && payload.b));

  ipcMain.handle('handControl:zoomSurface', (event, surface) => {
    const id = event.sender.id;
    const norm = normalizeZoomSurface(surface);
    const c = getHandControl();
    if (norm) {
      if (c.zoomSurfaces && c.zoomSurfaces.get(id) !== norm) {
        c.zoomSurfaces.set(id, norm);
        event.sender.once('destroyed', () => c.zoomSurfaces && c.zoomSurfaces.delete(id));
      }
    } else if (c.zoomSurfaces) {
      c.zoomSurfaces.delete(id);
    }
    return { ok: true, surface: norm };
  });

  ipcMain.handle('handControl:selectCamera', (_event, sel) => selectHandCamera(sel));
}

module.exports = { registerHandIpc };
