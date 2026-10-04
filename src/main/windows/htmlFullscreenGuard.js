'use strict';

/**
 * ADP-905 F4 — HTML5 tam ekran ÇIKIŞINDA pencereyi eski boyutuna döndür.
 *
 * <webview> içindeki video (YouTube) tam ekrana geçince Chromium pencereyi de fullscreen yapar;
 * videodan çıkınca pencere ESKİ boyutuna dönmelidir.
 *
 * Durum PENCEREDE tutulur (`win._adp905Fs`), çünkü aynı nöbet iki ayrı webContents'e
 * bağlanır: ana sayfa VE her <webview> misafiri.
 */
function attachHtmlFullscreenGuard(win, wc, logLine = () => {}) {
  if (!win || win.isDestroyed() || !wc || wc.isDestroyed()) return;
  if (!win._adp905Fs) win._adp905Fs = { active: false, bounds: null, wasFullScreen: false };
  const st = win._adp905Fs;

  wc.on('enter-html-full-screen', () => {
    try {
      if (win.isDestroyed()) return;
      if (st.active) return;
      st.active = true;
      st.wasFullScreen = win.isFullScreen();
      st.bounds = st.wasFullScreen ? null : win.getBounds();
      logLine(
        `ADP-905 fullscreen: HTML tam ekran GİRİŞ (wasFullScreen=${st.wasFullScreen} ` +
          `bounds=${st.bounds ? JSON.stringify(st.bounds) : '-'})`,
      );
    } catch (e) {
      logLine(`ADP-905 fullscreen giriş hatası: ${e.message}`);
    }
  });

  wc.on('leave-html-full-screen', () => {
    if (win.isDestroyed()) return;
    if (!st.active) return;
    st.active = false;
    const target = st.bounds;
    st.bounds = null;
    if (st.wasFullScreen || !target) {
      logLine('ADP-905 fullscreen: HTML tam ekran ÇIKIŞ — pencere zaten tam ekrandı, dokunulmadı');
      return;
    }
    const restoreBounds = () => {
      try {
        if (win.isDestroyed()) return;
        win.setBounds(target);
        logLine(`ADP-905 fullscreen: ÇIKIŞ → bounds geri kondu ${JSON.stringify(target)}`);
      } catch (e) {
        logLine(`ADP-905 fullscreen bounds geri konamadı: ${e.message}`);
      }
    };
    try {
      if (win.isFullScreen()) {
        win.once('leave-full-screen', () => setTimeout(restoreBounds, 60));
        win.setFullScreen(false);
      } else {
        restoreBounds();
      }
    } catch (e) {
      logLine(`ADP-905 fullscreen çıkış hatası: ${e.message}`);
    }
  });
}

module.exports = {
  attachHtmlFullscreenGuard,
};
