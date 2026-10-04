'use strict';

/**
 * E2E-MUTE-01 — TEST PENCERESİNİ ETİKETLE. Kapı koşusu GERÇEK app'i açar; ekranda
 * beliren pencere ürünün kendisinden ayırt edilemiyordu. Yalnız CREWPANE_INSTANCE=test
 * kopyasında başlığa bir işaret düşer; müşteri/dev kopyası DEĞİŞMEZ.
 */
const E2E_WINDOW_TAG = ' [E2E TEST]';

function tagTestWindow(win, base, isTest = false) {
  if (!isTest || !win || win.isDestroyed()) return;
  try {
    const stamp = () => {
      if (!win.isDestroyed() && !win.getTitle().includes(E2E_WINDOW_TAG)) {
        win.setTitle(`${win.getTitle() || base || 'CrewPane'}${E2E_WINDOW_TAG}`);
      }
    };
    stamp();
    // Sayfa başlığı yüklenince pencere başlığını EZER → damga her seferinde geri konur.
    win.webContents.on('page-title-updated', () => setImmediate(stamp));
  } catch {
    /* etiket kozmetiktir, pencereyi ASLA kıramaz */
  }
}

module.exports = {
  E2E_WINDOW_TAG,
  tagTestWindow,
};
