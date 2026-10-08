'use strict';

const { clipboard: defaultClipboard } = require('electron');

const CLIPBOARD_MAX = 1024 * 1024;

function readClipboardFilePaths(clipboard) {
  if (process.platform !== 'win32') return [];
  try {
    const formats = clipboard.availableFormats();
    if (!formats.includes('FileNameW')) return [];
    const buf = clipboard.readBuffer('FileNameW');
    if (!buf || !buf.length) return [];
    const s = buf.toString('ucs2').replace(/\0+$/g, '').trim();
    return s ? [s] : [];
  } catch (err) {
    return [];
  }
}

/**
 * Media, Image Attachments & Native Clipboard IPC Handlers (Faz 3.5 — Sıra 11)
 * Channels:
 *   - image:saveTemp
 *   - image:verify
 *   - attachment:ingest
 *   - attachment:read
 *   - attachment:hasBytes
 *   - attachment:removeBytes
 *   - clipboard:write
 *   - clipboard:pasteFocused
 */
function registerMediaIpc({
  ipcMain,
  saveTempImage,
  imageStore,
  ingestTaskAttachment,
  attachmentStore,
  clipboard = defaultClipboard,
  ptys,
  clipboardImageRoute,
  logLine = () => {},
}) {
  ipcMain.handle('image:saveTemp', (_event, payload) => saveTempImage(payload));

  ipcMain.handle('image:verify', (_event, paths) => imageStore.verify(Array.isArray(paths) ? paths : []));

  ipcMain.handle('attachment:ingest', (_event, payload) => ingestTaskAttachment(payload));

  ipcMain.handle('attachment:read', (_event, relPath) => attachmentStore().readDataUrl(relPath));

  ipcMain.handle('attachment:hasBytes', (_event, relPath) => ({ ok: true, present: attachmentStore().hasBytes(relPath) }));

  ipcMain.handle('attachment:removeBytes', (_event, relPath) => attachmentStore().removeBytes(relPath));

  ipcMain.handle('clipboard:write', (_event, text) => {
    const raw = typeof text === 'string' ? text : '';
    const value = raw.slice(0, CLIPBOARD_MAX);
    if (!value) return { ok: false, reason: 'empty' };
    try {
      clipboard.writeText(value);
      return { ok: true, truncated: value.length < raw.length };
    } catch (err) {
      logLine(`clipboard:write failed: ${err.message}`);
      return { ok: false, reason: 'write-failed' };
    }
  });

  ipcMain.handle('clipboard:pasteFocused', (event, opts) => {
    const paneId = opts && typeof opts === 'object' ? opts.paneId : null;
    try {
      const img = clipboard.readImage();
      const entry = (paneId && ptys) ? ptys.get(paneId) : null;
      const route = clipboardImageRoute.routeClipboardPaste({
        platform: process.platform,
        engine: entry ? entry.command : null,
        hasImage: !!(img && !img.isEmpty()),
        hasText: !!clipboard.readText().trim(),
        filePaths: readClipboardFilePaths(clipboard),
      });
      if (route.kind === 'engine-keys') return { ok: true, kind: 'engine-keys', keys: route.keys };
      if (route.kind === 'file-path') return { ok: true, kind: 'image', path: route.paths[0], fromDisk: true };
      if (route.kind === 'image') {
        const saved = saveTempImage({ data: img.toPNG(), type: 'image/png', name: 'pasted-image' });
        if (saved.ok) return { ok: true, kind: 'image', path: saved.path, bytes: saved.bytes };
        logLine(`clipboard:pasteFocused image save failed: ${saved.reason || 'unknown'}`);
        return { ok: false, reason: saved.reason || 'image-save-failed' };
      }
    } catch (err) {
      logLine(`clipboard:pasteFocused image probe failed: ${err.message}`);
    }
    try {
      event.sender.paste();
      return { ok: true, kind: 'text' };
    } catch (err) {
      logLine(`clipboard:pasteFocused failed: ${err.message}`);
      return { ok: false, reason: 'paste-failed' };
    }
  });
}

module.exports = { registerMediaIpc };
