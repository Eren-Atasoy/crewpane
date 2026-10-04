// BR-04 / INT-BRIDGE-04 (ADR-INT-BRIDGE §6) — "BU YÜZEY VENDOR'A MI AİT?" TEK KARAR.
//
// ADR §6 kararı: telemetri otomatik kurulumu ("Otomatik kur") MÜŞTERİ build'inde
// TAMAMEN gizlenir — çünkü o akış BİZİM ürün telemetrimizin projelerini
// (crewpane-prod · crewpane-dev · crewpane-com) MÜŞTERİNİN Sentry/PostHog
// organizasyonunda açar. Müşterinin bağladığı hesapla bizim vendor kurulumumuz
// tam olarak orada karışırdı.
//
// Bu modül o kararın TEK yeridir. Üç tüketicisi var ve üçü de aynı fiili sorar:
//   • integrationIpc.catalogView  → `provision` alanı + hangi keyGuidance
//   • telemetry:provision/verify  → IPC kapısı (ASIL kapı; UI gizlemek yetmez)
//   • telemetry:provisionStatus   → durum yüzeyi
//
// ─── NEDEN AYRI BİR MODÜL, NEDEN buildChannel'a BİR BAYRAK EKLENMEDİ ─────────
//
// `buildChannel.cjs`'in taşıyıcı kuralı "bu modül env'i HİÇ OKUMAZ"dır (ADP-646):
// kimlik/lisans/veri-kaynağı kapıları oradan türer ve env okuyan bir kapı, env
// yazabilen herkes için açıktır. Oraya bir test bayrağı koymak — YÖNÜ güvenli olsa
// bile — o kuralı delerdi ve bir sonraki okuyucu "demek ki env okunabiliyormuş"
// diye ikincisini eklerdi.
//
// Yüzey kararı ise kimlik değil GÖRÜNÜRLÜK kararıdır ve tek yönlü bir dikişi
// güvenle taşır:
//
//   CREWPANE_FORCE_CUSTOMER_SURFACE=1  →  yüzey KAPANIR (yalnız daha sıkı)
//   başka hiçbir değer                   →  karar buildChannel'ın (env ETKİSİZ)
//
// Yani bu bayrakla hiçbir kapı AÇILAMAZ. Müşteri kopyasında `isCustomerBuild()`
// zaten true'dur ve bayrağın yokluğu/varlığı sonucu DEĞİŞTİREMEZ.
//
// Dikiş neden gerekli: e2e uygulaması paketsiz koşar (`packaged !== true`) ve
// dev/test DMG'lerimizde `crewpaneBuild` gömülüdür — ikisi de tanımı gereği
// müşteri DEĞİLDİR. Bayrak olmasaydı "müşteride bu yüzey yok" iddiası yalnız birim
// testte kalır, ÜRÜNDE hiç ölçülemezdi. Bayrak KAPIYI DEĞİL SİNYALİ değiştirir:
// e2e'nin koşturduğu kod yolu, müşteride koşanın BİREBİR aynısıdır.
// (ADP-852 `FORCE_FIRST_RUN` ile aynı sınıf: ürün davranışını değiştirmeyen dikiş.)

'use strict';

const buildChannel = require('../config/buildChannel.cjs');

/** Tek yönlü test dikişinin adı — testler bunu kaynaktan okusun (metin kopyalanmasın). */
const FORCE_CUSTOMER_ENV = 'CREWPANE_FORCE_CUSTOMER_SURFACE';

/**
 * Vendor-içi yüzeyler (telemetri otomatik kurulumu) bu kopyada gösterilebilir mi?
 * @param {object} [opts] test dikişi — `{ env, packaged, bakedBuild }` (buildChannel'a geçer)
 * @returns {boolean} false → müşteri yüzeyi: kurulum akışı ne çizilir ne çağrılabilir
 */
function isVendorSurface(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  if (env && env[FORCE_CUSTOMER_ENV] === '1') return false; // tek yön: yalnız KAPATIR
  return !buildChannel.isCustomerBuild(o);
}

/** Okunurluk için: `if (isCustomerSurface()) return VENDOR_ONLY;` */
function isCustomerSurface(opts) {
  return !isVendorSurface(opts);
}

module.exports = { isVendorSurface, isCustomerSurface, FORCE_CUSTOMER_ENV };
