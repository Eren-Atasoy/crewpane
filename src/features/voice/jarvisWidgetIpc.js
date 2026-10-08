'use strict';

/**
 * ADP-816 (Faz 4) — TAŞINABİLİR SES WIDGET'I IPC YÜZEYİ
 *
 * Pop-out'la aynı disiplin: bu uçlar YALNIZ pencere + görüntü yönetir;
 * ses/kayıt/karar zincirine hiçbiri dokunmaz.
 */
function registerJarvisWidgetIpc({
  ipcMain,
  openJarvisWidgetWindow,
  closeJarvisWidgetWindow,
  jarvisWidgetAlive,
  windowManager,
  jarvisWidget,
  broadcastJarvisWidget,
  jarvisWidgetPayload,
  moveJarvisWidget,
  showAppFromJarvisWidget,
  logLine = () => {},
}) {
  ipcMain.handle('jarvisWidget:open', () => {
    try {
      return openJarvisWidgetWindow();
    } catch (err) {
      logLine(`jarvisWidget:open error: ${err.message}`);
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle('jarvisWidget:close', () => {
    try {
      return closeJarvisWidgetWindow();
    } catch (err) {
      logLine(`jarvisWidget:close error: ${err.message}`);
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle('jarvisWidget:toggle', () => {
    try {
      return jarvisWidgetAlive() ? closeJarvisWidgetWindow() : openJarvisWidgetWindow();
    } catch (err) {
      logLine(`jarvisWidget:toggle error: ${err.message}`);
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle('jarvisWidget:isOpen', () => ({ open: !!jarvisWidgetAlive() }));

  // Ana pencerenin ses yüzeyi durumunu YAYINLAR (widget açık değilse main yalnız
  // son fotoğrafı saklar — pencere sonradan açıldığında ekran boş kalmasın).
  ipcMain.handle('jarvisWidget:publish', (_event, payload) => {
    if (windowManager && jarvisWidget) {
      windowManager.setJarvisWidgetSnapshot(jarvisWidget.normalizeSnapshot(payload));
    }
    broadcastJarvisWidget();
    return { ok: true, open: !!jarvisWidgetAlive() };
  });

  /** Widget mount olurken son fotoğrafı ister (yayın beklemeden dolu açılır). */
  ipcMain.handle('jarvisWidget:snapshot', () => jarvisWidgetPayload());

  /** Sürükleme (frameless pencerenin tek taşıma yolu). */
  ipcMain.handle('jarvisWidget:move', (_event, payload) => {
    try {
      return moveJarvisWidget(payload);
    } catch (err) {
      logLine(`jarvisWidget:move error: ${err.message}`);
      return { ok: false, error: String(err.message || err) };
    }
  });

  /** Widget'taki "uygulamayı aç" — ana pencere kapalıysa yeniden yaratır. */
  ipcMain.handle('jarvisWidget:showApp', () => {
    try {
      return showAppFromJarvisWidget();
    } catch (err) {
      logLine(`jarvisWidget:showApp error: ${err.message}`);
      return { ok: false, error: String(err.message || err) };
    }
  });

  /** e2e/ölçüm yüzeyi: pencerenin GERÇEK bayrakları (iddia değil, ölçüm). */
  ipcMain.handle('jarvisWidget:debug', () => {
    const win = jarvisWidgetAlive();
    if (!win) return { open: false };
    return {
      open: true,
      bounds: win.getBounds(),
      alwaysOnTop: win.isAlwaysOnTop(),
      focusable: win.isFocusable(),
      focused: win.isFocused(),
      visible: win.isVisible(),
      visibleOnAllWorkspaces: win.isVisibleOnAllWorkspaces(),
    };
  });
}

module.exports = { registerJarvisWidgetIpc };
