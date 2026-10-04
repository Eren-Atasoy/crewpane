// ADP-646 (P0 GÜVENLİK) — "Bu bir MÜŞTERİ build'i mi?" TEK GERÇEK KAYNAK.
//
// SORUN: lisans/kimlik kapılarının geliştirici geçersiz kılmaları bugüne kadar
// `instancePaths.instanceId()` üzerinden karara bağlanıyordu. Ama instanceId'nin
// BİRİNCİ önceliği `CREWPANE_INSTANCE` env değişkenidir (instancePaths.cjs
// resolveInstanceId §1) — yani müşteri, indirdiği prod DMG'yi
//
//     CREWPANE_INSTANCE=dev /Applications/CrewPane.app/Contents/MacOS/CrewPane
//
// diye başlatarak "geliştirici" gibi görünebiliyordu. Env'e bağlı bir kapı, env'i
// yazabilen herkes için AÇIK bir kapıdır.
//
// ÇÖZÜM: bu modül env'i HİÇ OKUMAZ. Yalnız iki env-DEĞİŞTİRİLEMEZ sinyale bakar:
//
//   1. `app.isPackaged` — Electron'un kendi paketleme durumu. Bir kullanıcı bunu
//      env ile değiştiremez; değiştirmek için app'i yeniden paketlemesi gerekir
//      (o da imzayı bozar).
//   2. electron-builder'ın `extraMetadata.crewpaneBuild` alanı (instancePaths
//      `bakedBuildType()`) — bizim dev/test DMG'lerimize BUILD ANINDA gömülür;
//      müşteriye giden prod DMG'de YOKTUR.
//
// KARAR TABLOSU:
//   packaged=false (kaynaktan koşan Electron, e2e harness, node --test)  → geliştirici
//   packaged=true  + baked 'dev'/'test' (bizim iç DMG'lerimiz)           → geliştirici
//   packaged=true  + baked YOK (siteden inen prod DMG)                   → MÜŞTERİ ⛔
//
// "MÜŞTERİ" satırında hiçbir env değişkeni hiçbir kapıyı açamaz. Bu, ADP-628'in
// "ambient env asla taşıyıcı olamaz" kuralının bir üst basamağıdır: orada kapıyı
// açan opt-in bayrağı hâlâ instance'a bakıyordu, burada instance'a da bakmıyoruz.
//
// Saf + DI: Electron'a doğrudan require-bağı YOK (tembel + guard'lı) → `node --test`
// ile koşar; tüm sinyaller opts ile enjekte edilebilir.

'use strict';

const instancePaths = require('./instancePaths.cjs');

/**
 * Electron'un paketleme durumu. Electron dışında (node --test, MCP child'ı) çalışan
 * bir süreçte `require('electron')` bir STRING döner (app yok) → null.
 * @returns {boolean|null} null = "bilinmiyor / Electron değil"
 */
function electronPackaged() {
  try {
    // eslint-disable-next-line global-require
    const electron = require('electron');
    const app = electron && electron.app;
    return app && typeof app.isPackaged === 'boolean' ? app.isPackaged : null;
  } catch {
    return null;
  }
}

/**
 * Bu çalışan kopya siteden indirilen MÜŞTERİ build'i mi?
 *
 * @param {object} [opts]
 * @param {boolean|null} [opts.packaged]      test dikişi — `app.isPackaged`
 * @param {true|null}    [opts.packagedBaked] test dikişi — `instancePaths.packagedBuild()`
 * @param {string|null}  [opts.bakedBuild]    test dikişi — `crewpaneBuild` ('dev'|'test'|null)
 * @returns {boolean} true → kaçış bayrakları ETKİSİZ, kapılar ZORUNLU
 */
function isCustomerBuild(opts) {
  const o = opts || {};
  let packaged = o.packaged === undefined ? electronPackaged() : o.packaged;
  // BOARD-AUTH-02 / B3 (P1 GÜVENLİK) — ÖLÇÜLDÜ: kurulu MÜŞTERİ prod app'inin
  // `app.asar.unpacked/` dizininden `escapesAllowed()` **true** dönüyordu, çünkü
  // `electronPackaged()` düz node çocuğunda null verir ve aşağıdaki satır onu
  // "geliştirici" sayardı. Böylece ADP-646'nın değişmezi task/browser/integrations
  // MCP'lerinde ve crewpaneCli'de GEÇERSİZDİ. Electron cevap veremiyorsa artık
  // paketleme sorusunu build damgası + modülün kendi yolu yanıtlar (env DEĞİL).
  if (packaged !== true && packaged !== false) {
    packaged = o.packagedBaked === undefined ? instancePaths.packagedBuild() : o.packagedBaked;
  }
  // Paketli DEĞİLSE (ya da hiçbir sinyal paketlemeyi söylemiyorsa) bu bir
  // geliştirici/CI ortamıdır. Müşteriye kaynak göndermiyoruz.
  if (packaged !== true) return false;
  const baked = o.bakedBuild === undefined ? instancePaths.bakedBuildType() : o.bakedBuild;
  // Bizim dev/test DMG'lerimizde bu alan gömülüdür; müşteri DMG'sinde yoktur.
  return baked === null;
}

/**
 * Bir kaçış bayrağı bu kopyada dikkate alınabilir mi?
 * Tek satırlık okunur hâli: `if (!escapesAllowed()) return <sıkı davranış>;`
 */
function escapesAllowed(opts) {
  return !isCustomerBuild(opts);
}

module.exports = { isCustomerBuild, escapesAllowed, electronPackaged };
