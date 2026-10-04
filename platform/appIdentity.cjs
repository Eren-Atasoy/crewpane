// ADP-837 (P7) — WINDOWS UYGULAMA KİMLİĞİ (AppUserModelID), 793 B12.
//
// SORUN. Windows'ta bir sürecin bildirimleri (toast) ve görev çubuğu kimliği
// AppUserModelID (AUMID) ile ilişkilendirilir. Uygulama bunu KENDİSİ ilan
// etmezse Electron belgelenmiş yedeğine düşer (`electron.app.<productName>`) —
// yani çalışan sürecin ilan ettiği kimlik, KURULUMUN kaydettiği kimlikten
// (`build.appId`, NSIS `APP_ID`) FARKLI olur. Ölçülen taraf:
//
//   • `electron/package.json` build.appId = 'com.crewpane.crewpane'
//     → electron-builder bunu NSIS'e `APP_ID` olarak verir
//       (app-builder-lib/out/targets/nsis/NsisTarget.js: `APP_ID: appInfo.id`)
//       ve kaldırma adımında `WinShell::UninstAppUserModelId "${APP_ID}"` ile
//       TAM BU AUMID'in bildirim kaydını siler
//       (app-builder-lib/templates/nsis/uninstaller.nsh:191).
//   • Kaynak ağacında `setAppUserModelId` çağrısı YOKTU (ADP-837 ölçümü).
//
// Yani kaldırıcı `com.crewpane.crewpane`i temizlerken uygulama başka bir
// kimlikle bildirim yayınlıyordu: yanlış uygulama adı, Bildirim Ayarları'nda
// öksüz kayıt, kaldırmadan sonra artık kalması. Çözüm: kimliği AÇIKÇA ilan et.
//
// NEDEN SABİT STRING, NEDEN `require('../package.json').build.appId` DEĞİL:
// 🔴 ÖLÇÜLDÜ — electron-builder paketlenen package.json'dan `build` alanını
// SİLER. Kurulu dev app'in app.asar'ındaki package.json anahtarları:
//   name, version, private, description, main, dependencies,
//   crewpaneBuild, gitCommit, crewpaneDevTarget      ← `build` YOK.
// Çalışma anında o alanı okumak paketli uygulamada `undefined` döndürür ve
// AUMID sessizce yanlış olur. Bu yüzden değer burada YAŞAR ve `appIdentity.test.cjs`
// içindeki DRIFT KAPISI onu üç build config'iyle (package.json / dev-builder /
// test-builder) karşılaştırır — biri değişirse kapı kırmızı verir.
//
// KANAL AYRIMI ŞART: prod/dev/test aynı AUMID'i paylaşırsa Windows onları TEK
// uygulama sayar (bildirimler karışır, biri kaldırılınca ötekinin kaydı gider).
// Kanal son ekleri build config'lerdeki appId'lerin AYNISIDIR.
'use strict';

/** Kurulumun kaydettiği taban kimlik (electron/package.json build.appId). */
const BASE_APP_ID = 'com.crewpane.crewpane';

/** instancePaths.instanceId() → AUMID son eki. Build config'lerle BİREBİR. */
const CHANNEL_SUFFIX = Object.freeze({
  prod: '',
  dev: '.dev',
  test: '.test',
});

/**
 * Bu koşunun AppUserModelID'i — ya da win32 DIŞINDA `null`.
 *
 * macOS/Linux'ta `null` dönmesi bilinçli: çağıran hiçbir Electron API'sine
 * dokunmaz (ADR-W5'in "platform dalı macOS'ta İLK SATIRDA döner" disiplini).
 *
 * @param {object} [opts]
 * @param {string} [opts.platform]   varsayılan `process.platform`
 * @param {string} [opts.instanceId] 'prod'|'dev'|'test' (bilinmeyen → prod gibi)
 * @param {string} [opts.appId]      taban kimlik (test enjeksiyonu)
 * @returns {string|null}
 */
function appUserModelIdFor(opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform !== 'win32') return null;
  const appId = typeof opts.appId === 'string' && opts.appId ? opts.appId : BASE_APP_ID;
  const suffix = Object.prototype.hasOwnProperty.call(CHANNEL_SUFFIX, opts.instanceId)
    ? CHANNEL_SUFFIX[opts.instanceId]
    : CHANNEL_SUFFIX.prod;
  return `${appId}${suffix}`;
}

/**
 * Kimliği Electron'a ilan et. MÜMKÜN OLAN EN ERKEN noktada çağrılmalı:
 * `app.setAppUserModelId()` yalnız SONRAKİ bildirimleri/pencereleri etkiler.
 *
 * win32 dışında HİÇBİR ŞEY yapmaz — `app` nesnesine bile dokunmaz.
 *
 * @param {object} opts
 * @param {object} opts.app          Electron `app` (enjekte edilebilir)
 * @param {string} [opts.platform]
 * @param {string} [opts.instanceId]
 * @param {string} [opts.appId]
 * @param {Function} [opts.log]
 * @returns {{applied:boolean, id:string|null, reason?:string}}
 */
function applyAppUserModelId(opts = {}) {
  const id = appUserModelIdFor(opts);
  if (!id) return { applied: false, id: null, reason: 'not-win32' };
  const app = opts.app;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  if (!app || typeof app.setAppUserModelId !== 'function') {
    return { applied: false, id, reason: 'no-app' };
  }
  try {
    app.setAppUserModelId(id);
    log(`AppUserModelID = ${id}`);
    return { applied: true, id };
  } catch (e) {
    // FAIL-OPEN: kimlik ilan edilemezse uygulama yine açılır (bildirimler
    // Electron'un yedeğiyle çıkar) — açılmamaktan iyidir.
    log(`AppUserModelID ilan edilemedi: ${e && e.message}`);
    return { applied: false, id, reason: `error: ${e && e.message}` };
  }
}

module.exports = {
  BASE_APP_ID,
  CHANNEL_SUFFIX,
  appUserModelIdFor,
  applyAppUserModelId,
};
