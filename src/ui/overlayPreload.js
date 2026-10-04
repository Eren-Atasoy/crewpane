// ADP-113 (ADR-008 Faz 1) — region-select OVERLAY preload bridge.
//
// Runs in the transparent freeze-then-select overlay window (separate from the app
// window's preload.js). Whitelisted, minimal: receive the frozen frame + geometry
// from main, send back the committed rect or a cancel. No fs/node in the overlay
// renderer — same sandbox model as preload.js (ADP-002/ADR-002).

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayApi', {
  /**
   * Subscribe to the one-shot init payload from main:
   * { frameUrl, width, height, physicalWidth, physicalHeight }.
   * `frameUrl` is an adshot:// URL to the frozen frame PNG (ADP-252 — replaces the
   * old `dataUrl` base64 payload). `width/height` are LOGICAL (CSS) overlay size;
   * `physical*` is the frozen frame's native px size (loupe reads pixels + main
   * crops in physical space).
   */
  onInit: (cb) => {
    const l = (_e, payload) => cb(payload);
    ipcRenderer.on('overlay:init', l);
    return () => ipcRenderer.removeListener('overlay:init', l);
  },
  /** Commit the selection: rect = { x, y, width, height } in LOGICAL/CSS coords. */
  complete: (rect) => ipcRenderer.send('overlay:complete', rect),
  /** Cancel the capture (Esc) — main closes the overlay + resolves canceled. */
  cancel: () => ipcRenderer.send('overlay:cancel'),
});
