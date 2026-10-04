'use strict';
// SEC-W1-C1 — KURCALAMA (TAMPER) SİNYALLERİ: "bu kopya gönderdiğimiz kopya mı?"
//
// NEDEN VAR: bugün kurcalama HİÇBİR YERDE görünmüyor. SEC-W1-A1 geliştirici kaçış
// mantığını müşteri paketinden FİZİKSEL olarak çıkardı; geriye simetrinin öbür
// yarısı kalıyor — paketten bir şey ÇIKARMAK artık kapıya takılıyor, pakete bir şey
// EKLEMEK ise ölçülmüyor. Açılışta bütünlük denetimi (SEC-W1-A2) 0.2.47'de gelecek;
// şema ve ilk sinyal BUGÜN tanımlanıyor ki A2 geldiğinde ölçüm birikmiş olsun ve
// "kaç kopya kurcalanmış" sorusu ilk günden cevaplanabilsin.
//
// ── BUGÜN ÜRETİLEBİLEN TEK SİNYAL: build_flag_mismatch ──────────────────────
// Paketin KENDİ damgası ile ÇALIŞMA ANI kararı çelişiyor:
//   · `instancePaths.packagedBuild()` true  → "bu bir PAKET" (bakedBuild.json /
//     paket yolu; env ile yazılamaz)
//   · `instancePaths.bakedBuildType()` null → "bu paket MÜŞTERİ paketi" (dev/test
//     DMG'lerimizde bu alan 'dev'/'test'tir)
//   · `buildChannel.isCustomerBuild()` false → ama karar "müşteri değil" diyor
// Üçü aynı anda doğruysa tek açıklama `app.isPackaged`in false olmasıdır: paketin
// içeriği paketin DIŞINDA, kaynak gibi koşuyor (asar açılmış, dosyalar bir dizine
// serilmiş). Bu kendi başına bir tutarsızlıktır.
//
// ── YANLIŞ POZİTİF: NEREDE TETİKLENMEMELİ (kartın §7 riski) ─────────────────
//   · bare-run / node --test / CI  → `packagedBuild()` null  → sinyal YOK
//   · dev & test DMG'leri          → `bakedBuildType()` 'dev'/'test' → sinyal YOK
//   · sağlam müşteri DMG'si        → `isCustomerBuild()` true → sinyal YOK
// Üç kolun üçü de birim testte kilitli (`tamperSignals.test.cjs`).
//
// ── GİZLİLİK ────────────────────────────────────────────────────────────────
// Bu modül hiçbir YOL, İÇERİK, KULLANICI VERİSİ üretmez. Yalnız kapalı kümeden bir
// `reason`, gerekirse bir DOSYA ADI (yol değil) ve bir `signature` durumu döner.
// Şema tarafı ayrıca tür sistemiyle zorlar (`analyticsSchema.cjs`: `token` alanı
// eğik çizgi kabul etmez, yani bir yol oradan GEÇEMEZ).
//
// Saf + DI: Electron'a require-bağı YOK → `node --test` altında doğrudan koşar.

const instancePaths = require('../config/instancePaths.cjs');
const buildChannel = require('../config/buildChannel.cjs');

/** Kapalı küme — `analyticsSchema.EVENTS.tamper.reason` ile BİREBİR aynı olmak zorunda. */
const REASONS = Object.freeze({
  /** Paket damgası "müşteri paketi" diyor, çalışma anı "paket değil" diyor. */
  BUILD_FLAG_MISMATCH: 'build_flag_mismatch',
  /** SEC-W1-A2 — `app.asar.unpacked` altındaki bir dosyanın özeti tutmuyor. */
  UNPACKED_HASH_MISMATCH: 'unpacked_hash_mismatch',
  /** SEC-W1-A2 — kullanıcı ayar dosyasında olmaması gereken bir bayrak var. */
  SETTINGS_FLAG_ANOMALY: 'settings_flag_anomaly',
});

/**
 * Bugünkü tek sinyali ÖLÇ.
 *
 * @param {object} [opts] test dikişi — üçü de enjekte edilebilir
 * @param {true|null}    [opts.packagedBaked] `instancePaths.packagedBuild()`
 * @param {string|null}  [opts.bakedBuild]    `instancePaths.bakedBuildType()`
 * @param {boolean}      [opts.customerBuild] `buildChannel.isCustomerBuild()`
 * @returns {{reason:string, signature:string}|null} null = tutarsızlık YOK
 */
function detect(opts) {
  const o = opts || {};
  const packaged = o.packagedBaked === undefined ? instancePaths.packagedBuild() : o.packagedBaked;
  // 1) PAKET DEĞİLSE hiçbir şey söyleme. Kaynak koşusu bir kurcalama değildir ve
  //    geliştirici/e2e akışlarını gürültüye boğmak kapının kapatılmasına yol açar.
  if (packaged !== true) return null;
  const baked = o.bakedBuild === undefined ? instancePaths.bakedBuildType() : o.bakedBuild;
  // 2) İÇ PAKETLERİMİZ (dev/test DMG) bu sorunun konusu değil — onlar zaten
  //    "müşteri değil" olmak ÜZERE üretildi; çelişki yok.
  if (baked !== null) return null;
  const customer = o.customerBuild === undefined ? buildChannel.isCustomerBuild() : o.customerBuild;
  // 3) Müşteri paketi kendini müşteri paketi sayıyorsa sorun yok.
  if (customer === true) return null;
  return {
    reason: REASONS.BUILD_FLAG_MISMATCH,
    // İmza durumu BU sinyalde ölçülmüyor: `codesign` çağırmak açılışa bir süreç
    // doğurma maliyeti bindirir ve bu tutarsızlığın teşhisine bir şey katmaz.
    // "unknown" DÜRÜST cevaptır — 'valid' demek ölçmediğimiz bir şeyi iddia etmek
    // olurdu. SEC-W1-A2 imzayı gerçekten ölçtüğünde bu alan dolacak.
    signature: 'unknown',
  };
}

module.exports = { detect, REASONS };
