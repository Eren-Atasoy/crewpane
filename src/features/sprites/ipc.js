'use strict';

/**
 * Sprites & Avatar Packages IPC Handlers (Faz 3.5 — Sıra 2)
 * Channels: sprites:listLocal, sprites:listPackages, sprites:installPackage,
 *           sprites:removePackage, sprites:exportPackage
 */
function registerSpritesIpc({
  ipcMain,
  localSprites,
  pkgMgr,
  logLine = () => {},
}) {
  ipcMain.handle('sprites:listLocal', () => {
    try {
      const r = localSprites.listLocalSprites();
      if (r.skipped.length) logLine(`sprites:listLocal atlandı → ${r.skipped.slice(0, 5).join(' | ')}`);
      return { ok: true, dir: r.dir, sprites: r.sprites, issues: r.issues };
    } catch (err) {
      logLine(`sprites:listLocal failed: ${err.message}`);
      return { ok: false, dir: localSprites.localSpritesDir(), sprites: [], reason: err.message };
    }
  });

  ipcMain.handle('sprites:listPackages', () => {
    try {
      const r = pkgMgr.listPackages();
      if (r.skipped && r.skipped.length) {
        logLine(`sprites:listPackages atlandı → ${r.skipped.slice(0, 5).join(' | ')}`);
      }
      return r;
    } catch (err) {
      logLine(`sprites:listPackages failed: ${err.message}`);
      return { ok: false, dir: '', packages: [], skipped: [], error: err.message };
    }
  });

  ipcMain.handle('sprites:installPackage', async (_event, zipPath) => {
    if (!zipPath || typeof zipPath !== 'string') {
      return { ok: false, error: 'zipPath gerekli' };
    }
    try {
      logLine(`sprites:installPackage başla → ${zipPath}`);
      const result = await pkgMgr.handleInstallPackage(zipPath);
      if (result.ok) {
        logLine(`sprites:installPackage OK → ${result.manifest.name}`);
      } else {
        logLine(`sprites:installPackage FAIL → ${result.error}`);
      }
      return result;
    } catch (e) {
      logLine(`sprites:installPackage crash → ${e.message}`);
      return { ok: false, error: String(e.message) };
    }
  });

  ipcMain.handle('sprites:removePackage', async (_event, key) => {
    if (!key || typeof key !== 'string') {
      return { ok: false, error: 'key gerekli' };
    }
    try {
      logLine(`sprites:removePackage başla → ${key}`);
      const result = pkgMgr.handleRemovePackage(key);
      if (result.ok) {
        logLine(`sprites:removePackage OK → ${key}`);
      } else {
        logLine(`sprites:removePackage FAIL → ${result.error}`);
      }
      return result;
    } catch (e) {
      logLine(`sprites:removePackage crash → ${e.message}`);
      return { ok: false, error: String(e.message) };
    }
  });

  ipcMain.handle('sprites:exportPackage', async (_event, keys) => {
    if (!Array.isArray(keys) || keys.length === 0) {
      return { ok: false, error: 'keys dizisi gerekli' };
    }
    try {
      logLine(`sprites:exportPackage başla → ${keys.join(', ')}`);
      const result = await pkgMgr.handleExportPackage(keys);
      if (result.ok) {
        logLine(`sprites:exportPackage OK → ${result.path}`);
      } else {
        logLine(`sprites:exportPackage FAIL → ${result.error}`);
      }
      return result;
    } catch (err) {
      logLine(`sprites:exportPackage crash → ${err.message}`);
      return { ok: false, error: err.message };
    }
  });
}

module.exports = { registerSpritesIpc };
