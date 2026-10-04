// ADP-114 (ADR-008 Faz 2) — screenshot TRAY preload bridge.
//
// Runs in the separate always-on-top tray window (its own renderer, distinct from
// the app window's preload.js and the overlay's overlayPreload.js). Whitelisted,
// minimal: list/act-on the shots under ~/.crewpane/shots/ and begin a NATIVE file
// drag toward an agent pane. No fs/node in the tray renderer — same sandbox model
// as overlayPreload.js (ADR-002/ADP-002/113).

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('trayApi', {
  /** List all shots (pinned first, then newest) → [{ path, name, ts, bytes, width, height, pinned, thumb }]. */
  list: () => ipcRenderer.invoke('tray:list'),
  /** Delete a shot (disk + pin) → { ok } | { ok:false, reason }. */
  remove: (p) => ipcRenderer.invoke('tray:delete', p),
  /** Copy a shot to the OS clipboard as an image → { ok } | { ok:false, reason }. */
  copy: (p) => ipcRenderer.invoke('tray:copy', p),
  /** Reveal a shot in Finder → { ok } | { ok:false, reason }. */
  reveal: (p) => ipcRenderer.invoke('tray:reveal', p),
  /** Toggle a shot's pinned (keep-at-top) flag → { ok, pinned }. */
  togglePin: (p) => ipcRenderer.invoke('tray:togglePin', p),
  /** Begin a NATIVE OS file drag of a shot (drop onto an agent pane). Fire-and-forget. */
  startDrag: (p) => ipcRenderer.send('tray:startDrag', p),
  /**
   * ADP-143 — open the annotate editor for this shot in the MAIN app window. The
   * tray is sandboxed (no React/canvas), so main reads the PNG → dataURL and the
   * app window's ScreenshotTool opens its ScreenshotAnnotator. Fire-and-forget.
   */
  edit: (p) => ipcRenderer.send('tray:edit', p),
  /** Hide the tray window (× button). */
  close: () => ipcRenderer.send('tray:close'),
  /**
   * ADP-156 — collapse the tray to its title bar (minimize) or restore it. Main
   * resizes the window keeping the bottom-right corner anchored. Fire-and-forget.
   */
  setCollapsed: (collapsed) => ipcRenderer.send('tray:setCollapsed', !!collapsed),
  /**
   * Subscribe to live capture pushes (a new screenshot was just taken).
   * cb gets the new entry { path, name, ts, ..., thumb }. Returns unsubscribe.
   */
  onShotAdded: (cb) => {
    const l = (_e, entry) => cb(entry);
    ipcRenderer.on('tray:shotAdded', l);
    return () => ipcRenderer.removeListener('tray:shotAdded', l);
  },
});
