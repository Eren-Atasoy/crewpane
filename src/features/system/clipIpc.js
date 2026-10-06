'use strict';

/**
 * Clipboard IPC Handlers (Faz 3.5 — Sıra 1)
 * Channels: clip:list, clip:remove, clip:clear, clip:deliver
 */
function registerClipIpc({
  ipcMain,
  clipboard,
  nativeImage,
  clipHistory,
  ptys,
  clipboardImageRoute,
  saveTempImage,
  logLine = () => {},
}) {
  ipcMain.handle('clip:list', () => {
    try {
      return { ok: true, items: clipHistory.list() };
    } catch (err) {
      logLine(`clip:list failed: ${err.message}`);
      return { ok: false, items: [], reason: 'list-failed' };
    }
  });

  ipcMain.handle('clip:remove', (_event, id) => ({ ok: clipHistory.remove(String(id || '')) }));
  ipcMain.handle('clip:clear', () => ({ ok: true, removed: clipHistory.clear() }));

  /**
   * ADP-935 — bir geçmiş öğesini TESLİM ET.
   */
  ipcMain.handle('clip:deliver', (_event, opts) => {
    const id = opts && typeof opts === 'object' ? String(opts.itemId || '') : '';
    const paneId = opts && typeof opts === 'object' ? opts.paneId : null;
    const item = clipHistory.get(id);
    if (!item) return { ok: false, reason: 'not-found' };

    if (item.kind === 'text') {
      try {
        clipHistory.markSelfWrite('text', item.text);
        clipboard.writeText(item.text);
      } catch (err) {
        logLine(`clip:deliver clipboard write failed: ${err.message}`);
      }
      return { ok: true, kind: 'text', text: item.text };
    }

    try {
      clipHistory.markSelfWrite('image', item.png);
      clipboard.writeImage(nativeImage.createFromBuffer(item.png));
    } catch (err) {
      logLine(`clip:deliver clipboard image write failed: ${err.message}`);
    }
    const entry = paneId ? ptys.get(paneId) : null;
    const route = clipboardImageRoute.routeClipboardPaste({
      platform: process.platform,
      engine: entry ? entry.command : null,
      hasImage: true,
      hasText: false,
    });
    if (route.kind === 'engine-keys') return { ok: true, kind: 'engine-keys', keys: route.keys };
    const saved = saveTempImage({ data: item.png, type: 'image/png', name: 'clip-image' });
    if (saved.ok) return { ok: true, kind: 'image', path: saved.path, bytes: saved.bytes };
    logLine(`clip:deliver image save failed: ${saved.reason || 'unknown'}`);
    return { ok: false, reason: saved.reason || 'image-save-failed' };
  });
}

module.exports = { registerClipIpc };
