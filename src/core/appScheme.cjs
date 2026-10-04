// ADP-780-B — `crewpane://` DEĞİL: KANALA GÖRE ŞEMA. Tek gerçek kaynak.
//
// ## Çözülen bug (ölçüldü — ADP-764 §1.2, 6 kontrollü deney)
//
// prod-builder / dev-builder / test-builder ÜÇÜ DE `schemes: ['crewpane']`
// ilan ediyordu. macOS LaunchServices bir şemayı ÖNCE tek bir bundle id'ye, sonra
// o id'nin "tercih edilen kopyası"na sabitler; o kopyadan birden fazla süreç
// varsa dönüşü **ilk başlayana** verir, hiç süreç yoksa **yeni bir tane açar**.
// Sonuç: dev app'te giriş yapınca `crewpane://auth/callback` Eren'in günlük
// PROD app'ine düşüyordu — PKCE kodu orada tüketiliyor (tek kullanımlık!), prod
// app hesap değiştirmek için kendini kapatıp yeniden başlatıyordu.
//
// Emsal: VS Code Insiders `vscode-insiders://` — Microsoft ayrımı tam olarak bu
// gerekçeyle yaptı ("giriş dönüşü doğru araca gitmeli").
//
// ## Kural
//
//   baked build tipi | şema             | ilan eden
//   -----------------|------------------|---------------------------
//   null (prod DMG)  | crewpane       | electron/package.json build.protocols
//   'dev'            | crewpane-dev   | electron/dev-builder.cjs
//   'test'           | crewpane-test  | electron/test-builder.cjs
//
// ⚠️ KARAR `CREWPANE_INSTANCE` ENV'İNE BAĞLI DEĞİLDİR — bilerek. Şema, paketin
// Info.plist'ine (CFBundleURLTypes) BUILD ANINDA yazılır; çalışma anında env ile
// değiştirilebilseydi app, işletim sisteminin ASLA ona vermeyeceği bir şemayı
// dinlerdi (sessiz "giriş çalışmıyor"). Yani tek doğru kaynak, aynı paketin
// içindeki `crewpaneBuild` damgasıdır — `instancePaths.bakedBuildType()`.
//
// KAYNAKTAN KOŞU (baked yok): `instanceId()` okunur (DEV-LOGIN-01) — bu kopya
// şemayı zaten TALEP ETMEZ (ADP-719: paketsiz claim LaunchServices'e çıplak Electron
// ikilisini yazıyor ve kurulu üründen şemayı çalıyor) — e2e giriş dikişi URL'i
// doğrudan `crewpane:handleUrl` ile verir, OS yönlendirmesi devrede değildir.
//
// MÜŞTERİ KOPYASI (baked yok AMA packaged=true): env dalı KAPALI (ENV-01 Faz 4).
// Müşteri DMG'sinde `crewpaneBuild` alanı da yoktur — yani "baked yok" tek başına
// "kaynaktan koşu" demek DEĞİLDİR. `buildChannel.isCustomerBuild()` env okumayan
// tek sinyal olduğu için ayrımı o yapar; yukarıdaki ⚠️ invaryantı müşteri tarafında
// böylece FİİLEN geri gelir.
//
// Saf + DI: `opts.baked` ile enjekte edilebilir → `node --test` ile koşar.
// Çalıştır: node --test electron/appScheme.test.cjs

'use strict';

const instancePaths = require('../config/instancePaths.cjs');
const buildChannel = require('../config/buildChannel.cjs');

/** Kanal → şema. Tek tablo; builder'lar da bunu okur (ikinci kez yazılmaz).
 *  ⚠️ Şema; installer (Info.plist / Windows registry) ve auth sunucusunun redirect
 *  allow-list'iyle KOORDİNELİ değişmelidir — yalnız burada değiştirmek girişi kırar. */
const SCHEME_BY_BUILD = Object.freeze({
  prod: 'crewpane',
  dev: 'crewpane-dev',
  test: 'crewpane-test',
});

/** Şemaya karşılık gelen kullanıcıya-görünür protokol adı (Info.plist CFBundleURLName). */
const PROTOCOL_NAME_BY_BUILD = Object.freeze({
  prod: 'CrewPane',
  dev: 'CrewPane Dev',
  test: 'CrewPane Test',
});

/**
 * Bu KOPYANIN URL şeması.
 * @param {{baked?: string|null, customerBuild?: boolean}} [opts] test dikişi —
 *   verilmezse pakete gömülü damga + `buildChannel.isCustomerBuild()`.
 * @returns {'crewpane'|'crewpane-dev'|'crewpane-test'}
 */
function appScheme(opts) {
  const o = opts || {};
  const baked = o.baked === undefined ? instancePaths.bakedBuildType() : o.baked;
  // ADP-780-B Kapat: bare-run (baked=null) durumunda instanceId'yi kullan.
  // Yani `npm run electron:dev` kaynaktan koşarsa baked=null ama instanceId()='dev'
  // döneceğinden crewpane-dev:// şeması kullanılır (PROD'a kaçmaz).
  //
  // ENV-01 Faz 4 (ENV-R1 §0 madde 5) — DEV-LOGIN-01'in AÇIK BIRAKTIĞI DELİK:
  // müşteri DMG'sinde de `crewpaneBuild` YOKTUR (baked=null), yani yukarıdaki dal
  // MÜŞTERİ kopyasında da çalışıyordu. `CREWPANE_INSTANCE=dev` ile başlatılan bir
  // müşteri app'i `crewpane-dev://` DİNLER, oysa Info.plist yalnız `crewpane`
  // ilan eder → giriş dönüşü SESSİZCE kaybolur. `isCustomerBuild()` env okumayan tek
  // sinyaldir (buildChannel.cjs) — bare-run davranışı korunur, müşteri kopyası pinlenir.
  const customerBuild = o.customerBuild === undefined
    ? buildChannel.isCustomerBuild({ bakedBuild: baked })
    : o.customerBuild === true;
  if (!baked && !customerBuild) {
    return SCHEME_BY_BUILD[instancePaths.instanceId()] || SCHEME_BY_BUILD.prod;
  }
  return SCHEME_BY_BUILD[baked] || SCHEME_BY_BUILD.prod;
}

/** `crewpane-dev://` — startsWith kontrolleri ikinci kez string birleştirmesin. */
function appSchemePrefix(opts) {
  return `${appScheme(opts)}://`;
}

/** Giriş dönüş adresi — seatGate `redirectUri`'si ile AYNI biçim. */
function authCallbackUrl(opts) {
  return `${appScheme(opts)}://auth/callback`;
}

module.exports = {
  appScheme,
  appSchemePrefix,
  authCallbackUrl,
  SCHEME_BY_BUILD,
  PROTOCOL_NAME_BY_BUILD,
};
