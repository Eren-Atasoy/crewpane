// LX-SAFESTORAGE-01 (ADR-CREWPANE-LINUX §9 madde 2-3) — SIR ARKA UCUNUN TEK BOĞAZI.
//
// KAPATILAN SINIF (LX-LOGIN-01 §2.3'te ÖLÇÜLDÜ, dört kol AYNI paket/AYNI anahtarlık):
// Linux'ta Chromium'un sır arka ucunu seçen şey libsecret'ın KURULU olması değil,
// masaüstü ortamının TANINMASIDIR.
//   a) dbus yok                                    → basic_text, encrypt THROW
//   b) dbus var, keyring yok                       → basic_text, encrypt THROW
//   c) dbus + keyring AÇIK, XDG_CURRENT_DESKTOP YOK → basic_text, encrypt THROW  ← kontrol kolu
//   d) aynısı + XDG_CURRENT_DESKTOP=GNOME          → gnome_libsecret, roundtrip ✅
// c hâlinde kullanıcı giriş yapar, jeton diske YAZILAMAZ (ADR-027/G2 düz metni
// REDDEDER) ve her açılışta yeniden sorulur — ürün bunu ne SÖYLÜYOR ne de yazmayı
// denemekten VAZGEÇİYORDU. Bu modül hükmü bir kez ölçer, herkes buradan okur.
//
// ÜÇ KURAL:
//   1. HÜKÜM BURADA ÜRETİLMEZ, ÖLÇÜM `safeStorageIdentity.describeSecretBackend`ten
//      gelir (o fonksiyon birim testli ve YENİDEN YAZILMAZ — çağrılır).
//   2. "ölçemedim" ≠ "kapalı" (ADP-721). Ölçülemeyen durumda bugünkü davranış AYNEN
//      korunur: yazma DENENİR ve depo kendi hatasını verir. Yazmayı yalnız ÖLÇÜLMÜŞ
//      bir olumsuzlukta engelleriz — yoksa macOS/Windows'ta sessiz bir regresyon
//      üretirdik (oralarda `getSelectedStorageBackend` YOKTUR).
//   3. Düz-metin fallback YOK ve bu modül onu AÇMAZ. `--password-store=basic` gibi
//      bir bayrak da vermez: kararı kullanıcıya yıkmak korumayı kaldırmaktır
//      (HATA-11 §7.3). Burada yapılan tek şey REDDİN SEBEBİNİ görünür kılmaktır.
//
// Saf + DI: `safeStorage` ve `platform` enjekte edilir → `node --test` ile koşar,
// kırmızısı MUTASYONLA üretilebilir (sahte safeStorage `basic_text` döndürsün).

'use strict';

const safeStorageIdentity = require('./safeStorageIdentity.cjs');

/** Kullanıcıya gösterilecek cümlenin SÖZLÜK ANAHTARI (metin burada YAŞAMAZ). */
const REASON_PLAINTEXT = 'login.gate.secretPlaintext';
const REASON_UNAVAILABLE = 'login.gate.secretUnavailable';

/** Hiç ölçülmemiş durum — `canStore:null` ("bilmiyorum", "hayır" DEĞİL). */
const UNMEASURED = Object.freeze({
  measured: false,
  available: null,
  backend: null,
  plaintext: false,
  canStore: null,
  reasonKey: null,
  platform: null,
});

/**
 * Arka ucu ÖLÇ ve hükme çevir. Saf: hiçbir şey saklamaz.
 *
 * @param {{safeStorage?:object, platform?:string}} opts
 * @returns {{measured:boolean, available:boolean|null, backend:string|null,
 *            plaintext:boolean, canStore:boolean|null, reasonKey:string|null,
 *            platform:string|null}}
 */
function evaluateSecretBackend({ safeStorage, platform = process.platform } = {}) {
  const report = safeStorageIdentity.describeSecretBackend({ safeStorage, platform });
  const measured = report.available === true || report.available === false;
  let canStore = null;
  let reasonKey = null;
  if (report.plaintext) {
    // 🔴 ÖLÇÜLMÜŞ OLUMSUZLUK: arka uç `basic_text`. Yazma denenmez.
    canStore = false;
    reasonKey = REASON_PLAINTEXT;
  } else if (report.available === true) {
    canStore = true;
  } else if (report.available === false) {
    // Şifreleme yok ama arka ucun ADI bilinmiyor (macOS'ta kilitli keychain,
    // Windows'ta ready öncesi, Linux'ta eski Electron). Yazma yine engellenir ama
    // cümle FARKLIDIR: kullanıcıya "anahtar zinciri bulunamadı" demek yanlış olurdu.
    canStore = false;
    reasonKey = REASON_UNAVAILABLE;
  }
  return Object.freeze({
    measured,
    available: report.available,
    backend: report.backend,
    plaintext: report.plaintext === true,
    canStore,
    reasonKey,
    platform: platform || null,
  });
}

let current = UNMEASURED;

/**
 * Açılışta BİR KEZ ölç, hükmü bellekte tut, tek satır logla (SIR İÇERMEZ).
 * Log cümlesi `safeStorageIdentity.secretBackendLogLine` — ikinci bir metin YAZILMAZ.
 */
function initSecretBackendState({ safeStorage, platform = process.platform, log } = {}) {
  current = evaluateSecretBackend({ safeStorage, platform });
  if (typeof log === 'function') {
    log(safeStorageIdentity.secretBackendLogLine({
      available: current.available,
      backend: current.backend,
      plaintext: current.plaintext,
    }));
  }
  return current;
}

/** Son ölçülen hüküm (hiç ölçülmediyse `UNMEASURED`). */
function secretBackendState() {
  return current;
}

/**
 * Sır yazma yolu ÖLÇÜLMÜŞ olarak kapalı mı? Yalnız `canStore === false` iken `true`.
 * "Ölçülmedi" durumunda `false` döner (= engelleme yok, bugünkü davranış).
 */
function isSecretWriteBlocked() {
  return current.canStore === false;
}

/**
 * Bir token deposunu (crewpane-auth `createSafeStorageTokenStore`) sarmalar:
 * arka uç ÖLÇÜLMÜŞ olarak yazamaz durumdaysa `save()` şifrelemeyi HİÇ DENEMEZ.
 *
 * NİÇİN "denememek" ile "deneyip patlamak" AYNI ŞEY DEĞİL: depo `save()`i zaten
 * `throw` ediyor (ADR-027/G2) ama o hata çağıranın `catch`ine düşünce SEBEP kayboluyor
 * ve ekranda hiçbir şey olmuyordu. Sarmalayıcı aynı sözleşmeyi korur (yine `throw`)
 * ama (a) şifreleme çağrısını hiç yapmaz, (b) hatayı KODLAR (`ERR_SECRET_BACKEND`),
 * (c) sebebi TEK satır loglar. `load()`/diğer alanlar aynen geçer — okuma yolu
 * dokunulmadan kalır (eski blob'lar hâlâ okunabilir olabilir).
 */
function guardTokenStore(store, { label = 'store', log } = {}) {
  if (!store || typeof store.save !== 'function') return store;
  const say = typeof log === 'function' ? log : () => {};
  return {
    ...store,
    async save(doc) {
      if (isSecretWriteBlocked()) {
        const s = secretBackendState();
        say(`[auth] ${label}: sır arka ucu ÖLÇÜLDÜ (${s.backend || 'bilinmiyor'}) — `
          + 'şifreleme kullanılamıyor, yazma DENENMEDİ (düz metin fallback YASAK). '
          + 'Oturum bu açılışla sınırlı kalır.');
        const err = new Error(
          `sır arka ucu kullanılamıyor (${s.backend || 'bilinmiyor'}) — token diske YAZILMAZ (ADR-027/G2)`,
        );
        err.code = 'ERR_SECRET_BACKEND';
        err.reasonKey = s.reasonKey;
        throw err;
      }
      return store.save(doc);
    },
  };
}

/** Testler için: ölçümü sıfırla. */
function resetSecretBackendState() {
  current = UNMEASURED;
}

module.exports = {
  evaluateSecretBackend,
  initSecretBackendState,
  secretBackendState,
  isSecretWriteBlocked,
  guardTokenStore,
  resetSecretBackendState,
  REASON_PLAINTEXT,
  REASON_UNAVAILABLE,
  UNMEASURED,
};
