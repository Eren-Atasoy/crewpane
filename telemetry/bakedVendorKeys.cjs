// TEL-01 — VENDOR TELEMETRİ ANAHTARLARININ PAKETE GÖMÜLMESİ (bake) + GERİ OKUNMASI.
//
// ─── NEDEN VAR (ölçüldü, hipotez değil) ──────────────────────────────────────
// Sentry 30 gün / 6 sürüm boyunca YALNIZ darwin olay aldı (win32/linux: 0);
// PostHog `app_opened` 60 günde yalnız darwin cihazlar. Oysa GitHub indirme
// sayaçları çalışan bir Windows kurulu tabanı kanıtlıyor (REL-0242-WATCH-inferno
// §2.3/§2.6). Kök: DSN/anahtar çözüm zinciri (provision store → ~/.crewpane/
// telemetry.env → process.env) müşteri makinesinde HER ZAMAN BOŞTUR — üç kaynağın
// üçü de yalnız CrewPane makinelerinde var. Repo genelinde build-zamanı enjeksiyon
// isabeti SIFIRDI; kanal.cjs:16'daki "build-zamanı env" seçeneği hiç kablolanmamıştı.
// ⇒ Müşteri kurulumları telemetriye HİÇ rapor etmiyordu; panodaki cihazlar bizim
// Mac'lerimizdi. Bu modül o boşluğu kapatır: anahtarlar paketleme sırasında
// electron-builder `extraMetadata` ile paketlenen package.json'a yazılır
// (crewpaneBuild/gitCommit ile AYNI, kanıtlanmış mekanizma) ve çalışma zamanında
// EN DÜŞÜK ÖNCELİKLİ kaynak olarak geri okunur.
//
// ─── GÜVENLİK ÇERÇEVESİ ──────────────────────────────────────────────────────
// 1. DSN ve PostHog proje anahtarı SIR DEĞİLDİR (Sentry/PostHog dokümante eder:
//    istemciye gömülmek üzere tasarlanmış public değerlerdir). Yine de değerler
//    ASLA loglanmaz; eksikte yalnız AD basılır.
// 2. KANAL KİLİDİ İKİ KATMANLI: (a) bake sırasında kanal yalnız KENDİ anahtar
//    kümesini görür (dev/test paketi prod DSN'i taşıyamaz; dev değeri prod ile
//    AYNI ise gömülmez); (b) çalışma zamanında `channel.resolveDsn`/
//    `resolvePostHogKey` kilidi AYNEN geçerli kalır.
// 3. SÜPÜRGE ETKİLENMEZ: gömülü değerler process.env'e YAZILMAZ (yalnız
//    `resolveTelemetryEnv`'in döndürdüğü kopyada yaşar) → ajan pane'lerine miras
//    geçmez; `VENDOR_TELEMETRY_ENV_KEYS` süpürgesi ikinci emniyettir.
// 4. OPT-OUT DEĞİŞMEZ: anahtarın varlığı gönderim demek değildir — `enabled()`
//    kapısı (Ayarlar → Gizlilik, telemetryEnabled) her olayda CANLI okunur.
//
// Saf + DI: electron bağı yok, env/fs/bakedKeys enjekte edilebilir → `node --test`.

'use strict';

const { VENDOR_TELEMETRY_ENV_KEYS } = require('./channel.cjs');

/** Kanal → paket içine gömülmesine İZİN VERİLEN env adları. Tek gerçek kaynak. */
const KEYS_BY_CHANNEL = Object.freeze({
  prod: Object.freeze(['CREWPANE_SENTRY_DSN_PROD', 'CREWPANE_POSTHOG_KEY_PROD', 'CREWPANE_POSTHOG_HOST']),
  dev: Object.freeze(['CREWPANE_SENTRY_DSN_DEV', 'CREWPANE_POSTHOG_KEY_DEV', 'CREWPANE_POSTHOG_HOST']),
  test: Object.freeze(['CREWPANE_SENTRY_DSN_DEV', 'CREWPANE_POSTHOG_KEY_DEV', 'CREWPANE_POSTHOG_HOST']),
});

/**
 * Verilen env görünümünden, kanalın görmesine izin verilen anahtarları seç.
 * dev/test için prod-eşitlik kilidi: değer prod ikiziyle AYNI ise GÖMÜLMEZ
 * (runtime kilidi `resolveDsn`'in bake-zamanı aynası).
 * @param {string} channel 'prod'|'dev'|'test'
 * @param {object} env
 * @param {{warn?:(missing:string[])=>void}} [opts]
 * @returns {Record<string,string>}
 */
function selectBakeKeys(channel, env, opts = {}) {
  const allowed = KEYS_BY_CHANNEL[channel];
  if (!allowed) return {};
  const e = env || {};
  const out = {};
  const missing = [];
  for (const name of allowed) {
    const value = typeof e[name] === 'string' ? e[name].trim() : '';
    if (!value) { missing.push(name); continue; }
    if (channel !== 'prod' && name.endsWith('_DEV')) {
      const prodTwin = name.replace(/_DEV$/, '_PROD');
      const prodValue = typeof e[prodTwin] === 'string' ? e[prodTwin].trim() : '';
      if (prodValue && prodValue === value) {
        missing.push(`${name} (değeri prod ikiziyle AYNI → kanal kilidi, gömülmedi)`);
        continue;
      }
    }
    out[name] = value;
  }
  if (missing.length && typeof opts.warn === 'function') opts.warn(missing);
  return out;
}

/**
 * BUILD TARAFI — builder config'lerinin çağırdığı tek fonksiyon.
 * Kaynak: process.env + ~/.crewpane/telemetry.env (telemetry.cjs'in MEVCUT
 * okuyucusu — ikinci bir dosya-formatı gerçeği açılmaz). Eksik anahtar build'i
 * KIRMAZ (yerel/CI build anahtarsız da paketlenebilmeli) ama GÜRÜLTÜLÜ uyarır;
 * yayın hattı çıktıyı `crewpaneTelemetry` alanının varlığıyla denetler.
 * @param {string} channel
 * @param {{env?:object, fs?:object, warn?:(s:string)=>void}} [deps]
 */
function bakeForBuild(channel, deps = {}) {
  // Lazy require — telemetry.cjs bu dosyayı require eder; döngü kurulmasın.
  const { loadDsnEnvFromCrewPane } = require('./telemetry.cjs');
  const env = loadDsnEnvFromCrewPane({ fs: deps.fs, env: deps.env || { ...process.env } });
  const warnLine = deps.warn || ((s) => console.warn(s));
  return selectBakeKeys(channel, env, {
    warn: (missing) => warnLine(
      `⚠️  telemetry bake (${channel}): gömülemeyen anahtar(lar): ${missing.join(', ')} — `
      + 'paket bu anahtarlar OLMADAN çıkıyor (kaynak: env ya da ~/.crewpane/telemetry.env; '
      + 'yalnız adlar loglanır, değer asla).',
    ),
  });
}

/**
 * RUNTIME TARAFI — paketlenmiş package.json'daki `crewpaneTelemetry` alanını oku.
 * `bakedBuildType()` ile AYNI mekanizma (require('../package.json') — cache'li).
 * Beyaz-liste dışı ad ve string-dışı değer DÜŞER; alan yoksa {} (kaynaktan koşan
 * geliştirici/CI build'inde davranış değişmez).
 * @param {{bakedKeys?:object}} [deps]  DI: test'te paket package.json'u taklit eder
 * @returns {Record<string,string>}
 */
function readBakedKeys(deps = {}) {
  let raw = deps.bakedKeys;
  if (raw === undefined) {
    try {
      const pkg = require('../package.json');
      raw = pkg.crewpaneTelemetry || pkg.crewpaneTelemetry;
    } catch {
      raw = null;
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const name of VENDOR_TELEMETRY_ENV_KEYS) {
    const v = raw[name];
    if (typeof v === 'string' && v.trim()) out[name] = v.trim();
  }
  return out;
}

module.exports = { KEYS_BY_CHANNEL, selectBakeKeys, bakeForBuild, readBakedKeys };
