'use strict';

const { EXTERNAL_KEY_STORE, SECRET_AUTH_KINDS } = require('./constants.cjs');
const { CATALOG } = require('./services/index.cjs');

/** @param {string} authKind */
function carriesSecret(authKind) {
  return SECRET_AUTH_KINDS.includes(authKind);
}

/** Anahtarı BAŞKA bir yüzeyin yönettiği servisler (vault'a yazılamaz). */
function isExternallyManaged(service) {
  const entry = get(service);
  return !!(entry && entry.keyStore === EXTERNAL_KEY_STORE);
}

/** Katalog girişi (bilinmeyen servis → null; çağıran karar verir, biz uydurmayız). */
function get(service) {
  if (typeof service !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(CATALOG, service) ? CATALOG[service] : null;
}

/** Tüm girişler — UI listesi için (dizi, id sırasında deterministik). */
function list() {
  return Object.keys(CATALOG).sort().map((k) => CATALOG[k]);
}

function has(service) {
  return get(service) !== null;
}

/**
 * Bir servisin anahtar DIŞI, kullanıcıya özel ayarları (gizli DEĞİL).
 * AÇIK İŞ (ADP-588 raporu): bugün bunu kimse tüketmiyor — ADP-587 (UI) bu alanları
 * sormalı, ADP-585 (ensureIntegrationsMcpConfig) server'ın env bloğuna eklemeli.
 * O olana kadar `required:true` alanı olan servis (Coolify) araç çağrısında
 * "not configured" der; sunucusu yine ayağa kalkar.
 */
function userFields(service) {
  const entry = get(service);
  return entry && Array.isArray(entry.userFields) ? entry.userFields : [];
}

/**
 * INT-0-D — kullanıcının BEYAN edebileceği izinlerin SEÇİLEBİLİR listesi.
 *
 * Kaynak TEK ve zaten var: `capabilities[].needsScopes` (BR-03 probe'unda gerçek
 * servis dokümanından yazıldı). Burada YENİ izin adı ÜRETİLMEZ — yalnız yazılı
 * olanlar tekilleştirilir. Serbest metin beyanı işe yaramıyordu: `needsScopes` ile
 * kıyaslanamayan bir beyan, ajanın "bu anahtar bu işi taşır mı" sorusunu yanıtlamaz.
 *
 * `scopesSelectable` BAYRAĞI NEDEN VAR: her `needsScopes` bir izin ADI değildir.
 * Coolify'ınki düzyazıdır ("read-only token yeterli" — o servisin granüler izni YOK,
 * modeli ikili), Stripe'ınki şablondur ("<Kaynak>: Read (RAK'ta seçilen kaynaklar)").
 * Bunları seçenek diye sunmak kullanıcıya OLMAYAN bir izin adı seçtirirdi. Bayrak
 * metin sezgisiyle DEĞİL, katalog yazarının beyanıyla belirlenir (bir gün Coolify
 * granüler izne geçerse tek satır eklenir).
 */
function scopeOptions(service) {
  const entry = get(service);
  if (!entry || entry.scopesSelectable !== true) return [];
  const out = [];
  for (const cap of Array.isArray(entry.capabilities) ? entry.capabilities : []) {
    for (const scope of Array.isArray(cap.needsScopes) ? cap.needsScopes : []) {
      if (typeof scope === 'string' && scope && !out.includes(scope)) out.push(scope);
    }
  }
  return out;
}

/** `required:true` userField'ı olan servisler — UI "eksik ayar" rozeti için. */
function requiresUserFields(service) {
  return userFields(service).some((f) => f.required === true);
}

/**
 * BR-04 (ADR §6) — anahtar rehberinin HANGİ yüzü gösterilecek.
 *
 * MÜŞTERİ varsayılandır: `keyGuidance` her zaman müşterinin göreceği, telemetri
 * kurulumundan hiç söz etmeyen dar-yetki metnidir. Vendor genişletmesi AYRI bir
 * alandır (`keyGuidanceVendor`) ve YALNIZ açıkça `{vendor:true}` denince döner.
 *
 * 🔴 Yön BİLEREK böyle: bayrak okunamazsa/unutulursa düşülecek yer MÜŞTERİ
 * metnidir. Ters kurulumda (vendor varsayılan + müşteride kırp) bir hata,
 * müşteriye bizim iç akışımızı gösterirdi — sessiz sızıntı. Burada aynı hata
 * yalnız bize eksik bir cümle gösterir.
 *
 * @param {object|string} entryOrService
 * @param {{vendor?: boolean}} [opts]
 * @returns {string|null}
 */
function guidanceFor(entryOrService, opts = {}) {
  const entry = typeof entryOrService === 'string' ? get(entryOrService) : entryOrService;
  if (!entry) return null;
  if (opts.vendor === true && typeof entry.keyGuidanceVendor === 'string' && entry.keyGuidanceVendor) {
    return entry.keyGuidanceVendor;
  }
  return typeof entry.keyGuidance === 'string' ? entry.keyGuidance : null;
}

/**
 * BR-04 — bu servis VENDOR-İÇİ bir kurulum akışı taşıyor mu (telemetri
 * provisioning)? Müşteri build'inde bu akışın yüzeyi HİÇ çizilmez, IPC kapısı
 * main'de kapanır. Tek kaynak: girişin kendi `provision.kind` alanı — servis ADI
 * ile karar veren bir liste (if service==='sentry') AÇILMADI.
 */
function isVendorOnlyProvision(service) {
  const entry = typeof service === 'string' ? get(service) : service;
  return !!(entry && entry.provision && entry.provision.kind === 'telemetry');
}

module.exports = {
  carriesSecret,
  isExternallyManaged,
  get,
  list,
  has,
  userFields,
  scopeOptions,
  requiresUserFields,
  guidanceFor,
  isVendorOnlyProvision,
};
