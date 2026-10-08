'use strict';

/**
 * App Locale Service (ADP-888 / ADP-885 Faz A / Phase 3.6.42)
 *
 * ARAYÜZ DİLİNİN TEK KARAR NOKTASI.
 *
 * Tercih settings.json'da ('system'|'tr'|'en'), ETKİN dil burada çözülür ve üç
 * tüketiciye BURADAN dağılır: (1) main'in kendi diyalogları, (2) yeni pencerelerin
 * additionalArguments bayrağı, (3) açık pencerelere canlı push. İkinci bir yerde
 * çözülseydi "ayarda İngilizce, diyalogda Türkçe" kaçınılmazdı (iki gerçek).
 */
class AppLocaleService {
  constructor({
    app,
    BrowserWindow,
    appI18n,
    agentSettings,
    logLine = () => {},
  } = {}) {
    this._app = app;
    this._BrowserWindow = BrowserWindow;
    this._appI18n = appI18n;
    this._agentSettings = agentSettings;
    this._logLine = logLine;
  }

  applyAppLocale() {
    let preference = this._appI18n ? this._appI18n.DEFAULT_LOCALE_PREFERENCE : 'system';
    try {
      if (this._agentSettings && typeof this._agentSettings.readSettings === 'function') {
        preference = this._agentSettings.readSettings().locale;
      }
    } catch {
      /* ayar okunamazsa 'system' — dil yüzünden açılış düşmez */
    }

    let systemLocale = '';
    try {
      if (this._app && typeof this._app.getLocale === 'function') {
        systemLocale = this._app.getLocale();
      }
    } catch {
      /* whenReady öncesi/headless — İngilizceye düşer */
    }

    // ADP-889 — SİSTEM ETİKETİ PİNİ (yalnız otomasyon). TERCİH'i EZMEZ: kullanıcı
    // 'tr'/'en' seçtiyse o kazanır, bu değer yalnız tercih 'system' iken okunan
    // işletim sistemi etiketinin yerine geçer ("OS bu dilde davransın").
    const pinnedSystemLocale = process.env.CREWPANE_SYSTEM_LOCALE;
    if (typeof pinnedSystemLocale === 'string' && pinnedSystemLocale.trim()) {
      systemLocale = pinnedSystemLocale.trim();
    }

    const locale = this._appI18n ? this._appI18n.setLocale(preference, systemLocale) : 'en';
    const activePreference =
      this._appI18n && typeof this._appI18n.getPreference === 'function'
        ? this._appI18n.getPreference()
        : preference;

    return { locale, preference: activePreference };
  }

  broadcastLocale() {
    const state = this.applyAppLocale();
    if (this._BrowserWindow && typeof this._BrowserWindow.getAllWindows === 'function') {
      for (const win of this._BrowserWindow.getAllWindows()) {
        try {
          if (!win.isDestroyed()) win.webContents.send('app:locale-changed', state);
        } catch {
          /* best-effort */
        }
      }
    }
    this._logLine(`locale: tercih=${state.preference} etkin=${state.locale}`);
    return state;
  }
}

function createAppLocaleService(deps) {
  return new AppLocaleService(deps);
}

module.exports = {
  createAppLocaleService,
  AppLocaleService,
};
