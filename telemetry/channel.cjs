// ADP-715 — Telemetri KANAL + DSN yönlendirme.
//
// Kanal, ADP-664 `buildChannel.cjs` TEK GERÇEK KAYNAĞINDAN türer (ikinci bir
// kanal-tanımı YOK):
//   bakedBuildType() === 'dev'|'test'  → o kanal (iç DMG'lerimiz)
//   packaged === true  + baked yok      → 'prod' (siteden inen müşteri build'i)
//   packaged !== true                   → 'dev' (kaynaktan koşan geliştirici/CI)
//
// SERT KURAL: DEV ve TEST kanalları PROD projesine RAPOR ETMEZ. Bunu iki katmanla
// garanti ederiz:
//   1. DSN çözümü kanala göre AYRI env değişkeninden okunur (prod DSN'i yalnız
//      'prod' kanal görür).
//   2. Güvenlik kilidi: kanal 'prod' değilken çözülen DSN prod-DSN'e EŞİTSE null
//      döneriz (yanlış yapılandırma prod'a sızdıramaz).
//
// DSN koda GÖMÜLMEZ: build-zamanı env ya da ~/.crewpane/telemetry.env'den gelir.
// Saf + DI: buildChannel ve env enjekte edilebilir → `node --test`.

'use strict';

// CrewPane'te kanal sinyalleri iki modülde: electronPackaged → buildChannel.cjs,
// bakedBuildType → instancePaths.cjs. İkisini tek yüzeyde birleştir (kanal-tanımı
// yine TEK GERÇEK KAYNAK; burası sadece adaptör).
const _bc = require('../src/config/buildChannel.cjs');
const _ip = require('../src/config/instancePaths.cjs');
const DEFAULT_BUILD_CHANNEL = {
  electronPackaged: _bc.electronPackaged,
  bakedBuildType: _ip.bakedBuildType,
};

/** İç build işaretçisini ve paketleme durumunu kanala çevir. */
function resolveChannel(deps = {}) {
  const bc = deps.buildChannel || DEFAULT_BUILD_CHANNEL;
  const baked = deps.bakedBuild !== undefined ? deps.bakedBuild : bc.bakedBuildType();
  if (baked === 'dev' || baked === 'test') return baked;
  const packaged = deps.packaged !== undefined ? deps.packaged : bc.electronPackaged();
  return packaged === true ? 'prod' : 'dev';
}

/**
 * Kanal için DSN çöz. Prod DSN'i YALNIZ 'prod' kanal görebilir.
 * @param {string} channel  'prod'|'dev'|'test'
 * @param {object} [env]     enjekte edilebilir env (varsayılan process.env)
 * @returns {string|null}
 */
function resolveDsn(channel, env) {
  const e = env || process.env;
  const prodDsn = (e.CREWPANE_SENTRY_DSN_PROD || '').trim() || null;
  const devDsn = (e.CREWPANE_SENTRY_DSN_DEV || '').trim() || null;

  if (channel === 'prod') return prodDsn;

  // dev / test → dev DSN (ya da hiç). GÜVENLİK KİLİDİ: prod DSN'e asla düşme.
  if (devDsn && devDsn === prodDsn) return null;
  return devDsn;
}

/** Kanal prod projesine rapor edebilir mi? (yalnız 'prod') — testte okunur niyet. */
function reportsToProd(channel) {
  return channel === 'prod';
}

// ─── OBS-01 — ÜRÜN ANALİTİĞİ (PostHog) ───────────────────────────────────────
// Anahtar çözümü Sentry DSN'i ile AYNI DOSYADA ve AYNI KURALLARLA yaşar; ikinci
// bir yapılandırma yüzeyi açılmadı (görev kuralı: ikinci bir altyapı kurma).
// Aynı üç garanti geçerli:
//   1. Anahtar koda GÖMÜLMEZ — env ya da ~/.crewpane/telemetry.env.
//   2. Kanala göre AYRI env değişkeni (prod anahtarını yalnız 'prod' kanal görür).
//   3. GÜVENLİK KİLİDİ: prod olmayan kanalın çözdüğü anahtar prod anahtarına
//      EŞİTSE null döneriz — bir yapılandırma hatası, geliştirme makinelerinin
//      olaylarını müşteri panosuna karıştıramaz. (Bu kilit analitikte hata
//      takibinden DAHA kritiktir: kirli bir "aktivasyon hunisi" yanlış ürün
//      kararı ürettirir, oysa kirli bir hata panosu yalnız gürültü yapar.)

/**
 * Kanal için PostHog proje anahtarını çöz.
 * @param {string} channel  'prod'|'dev'|'test'
 * @param {object} [env]
 * @returns {string|null}
 */
function resolvePostHogKey(channel, env) {
  const e = env || process.env;
  const prodKey = (e.CREWPANE_POSTHOG_KEY_PROD || '').trim() || null;
  const devKey = (e.CREWPANE_POSTHOG_KEY_DEV || '').trim() || null;

  if (channel === 'prod') return prodKey;
  if (devKey && devKey === prodKey) return null; // dev asla prod projesine yazamaz
  return devKey;
}

/**
 * Ingest hostu (tek değişken, kanaldan bağımsız). Verilmezse `posthogWire`'ın
 * varsayılanı (AB bulutu) kullanılır — Eren self-host'a dönerse burası değişir.
 * @returns {string|null}
 */
function resolvePostHogHost(env) {
  const e = env || process.env;
  return (e.CREWPANE_POSTHOG_HOST || '').trim() || null;
}

// ─── BR-04 (ADR-INT-BRIDGE §6) — VENDOR TELEMETRİ ANAHTARLARININ ENV ADLARI ──
//
// Bu dosyanın YUKARIDA okuduğu adların TAM listesi. Tek yerde durmasının sebebi
// vendor/müşteri ayrımıdır: bu değerler CREWPANE'A aittir (bizim Sentry projemizin
// DSN'i, bizim PostHog yazma anahtarımız) ve MÜŞTERİNİN ajan pane'inde işleri YOKTUR.
//
// ÖLÇÜLDÜ (2026-08-12, canlı müşteri build'i): `CREWPANE_POSTHOG_KEY_PROD` bir ajan
// pane'inin env'inde, müşterinin kasadan çözülen `CREWPANE_SECRET_*` değerinin tam
// yanında duruyordu (kök: telemetry.loadDsnEnvFromCrewPane'ın process.env'i
// kirletmesi). Kök düzeltildi; bu liste agentRunner'ın pane-tarafı SÜPÜRGESİNİ
// besler — yani başka bir yol (kabuktan miras, ileride bir regresyon) aynı değeri
// yeniden koysa bile pane onu GÖRMEZ.
//
// 🔴 `CREWPANE_` ön-ekinin TAMAMI süpürülmez: `CREWPANE_AUTH_DIR` / `CREWPANE_ID_*`
// pane çocukları için YÜK TAŞIYOR olabilir. Ad-ad liste, ön-ek süpürgesinden dar
// ama DOĞRU olanıdır.
const VENDOR_TELEMETRY_ENV_KEYS = Object.freeze([
  'CREWPANE_SENTRY_DSN_PROD',
  'CREWPANE_SENTRY_DSN_DEV',
  'CREWPANE_POSTHOG_KEY_PROD',
  'CREWPANE_POSTHOG_KEY_DEV',
  'CREWPANE_POSTHOG_KEY', // eski/yanlış yazılmış ad (telemetry.cjs §INT-OBS-01 notu)
  'CREWPANE_POSTHOG_HOST',
]);

module.exports = {
  resolveChannel, resolveDsn, reportsToProd,
  resolvePostHogKey, resolvePostHogHost,
  VENDOR_TELEMETRY_ENV_KEYS,
};
