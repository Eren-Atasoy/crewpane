// ADP-715 — Telemetri BAŞLATICI (AgentShot / Electron main).
//
// Sorumluluk: (1) opt-out kapısı, (2) kanal+DSN çözümü, (3) Sentry SDK'yı gizlilik
// süzgeciyle başlatma, (4) sürüm/kanal/OS etiketleme, (5) minimum kullanım ölçümü.
//
// GARANTİLER:
//   • Opt-out kapalıysa (config.telemetryEnabled === false) SDK HİÇ başlatılmaz —
//     tek bir olay bile gitmez.
//   • DSN yoksa (env/`~/.crewpane` boş) başlatılmaz (koda gömülü DSN YOK).
//   • Giden HER olay `scrubEvent`'ten geçer (beforeSend) — içerik sızmaz.
//   • dev/test kanalı prod DSN'ini çözemez (channel.resolveDsn güvenlik kilidi).
//
// Sentry SDK opsiyonel-lazy require'dır: kurulu değilse telemetri sessizce
// devre-dışı kalır (uygulama ASLA telemetri yüzünden çökmez). Test için `deps`
// ile sahte SDK/os/env enjekte edilir.

'use strict';

const { scrubEvent } = require('./scrub.cjs');
const bakedVendor = require('./bakedVendorKeys.cjs');
const { resolveChannel, resolveDsn } = require('./channel.cjs');

const APP = 'crewpane';

/** config.telemetryEnabled okuması — yalnız AÇIK false devre dışı bırakır (opt-out). */
function isEnabledByConfig(config) {
  return !(config && config.telemetryEnabled === false);
}

/**
 * ~/.crewpane/telemetry.env yoksa hiç okumaz; env zaten set'liyse dokunmaz.
 *
 * 🔴 BR-04 (2026-08-12) — `process.env` ARTIK MUTASYONA UĞRAMIYOR.
 *
 * ÖLÇÜLDÜ (canlı, müşteri build'i): bu fonksiyon `deps.env` verilmediğinde varsayılan
 * olarak `process.env`e YAZIYORDU. Main'in process.env'i her ajan pane'ine miras
 * geçtiği için, VENDOR'a (CrewPane'a) ait telemetri anahtarı
 * (`CREWPANE_POSTHOG_KEY_PROD`) ajan pane'inin env'inde, müşterinin kasadan çözülen
 * `CREWPANE_SECRET_*` değerinin TAM YANINDA duruyordu — yani `env` yazan herhangi
 * bir ajan ikisini birden görüyordu. Vendor kimliği ile müşteri kimliğinin
 * karışmaması BR-04'ün kırmızı çizgisi; sızıntının kökü buydu.
 *
 * `resolveTelemetryEnv` zaten "kopya döner, process.env'e yazılmaz" diye söz
 * veriyordu (INT-OBS-01) — o söz YALNIZ store katmanı için tutuyordu, eski dosya
 * yolu sözü deliyordu. Artık taban da kopya: davranış OKUYUCULAR için birebir aynı
 * (dönen nesne yine process.env + dosya birleşimi), değişen tek şey process.env'in
 * KİRLENMEMESİ. `deps.env` açıkça verilirse (main.js:5832) eski davranış aynen sürer.
 */
function loadDsnEnvFromCrewPane(deps) {
  const fs = deps.fs || require('node:fs');
  const os = deps.os || require('node:os');
  const path = deps.path || require('node:path');
  // Varsayılan: process.env'in KOPYASI. Çağıran bilerek bir nesne verirse ona yazılır.
  const env = deps.env || { ...process.env };
  try {
    const file = path.join(os.homedir(), '.crewpane', 'telemetry.env');
    const raw = fs.readFileSync(file, 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* dosya yok = sorun değil */ }
  return env;
}

/**
 * Telemetriyi başlat.
 * @param {object} opts
 * @param {string} opts.version          uygulama sürümü (package.json'dan)
 * @param {object} opts.config           config store snapshot (telemetryEnabled)
 * @param {object} [opts.deps]           DI: { sentry, os, env, fs, path, buildChannel }
 * @returns {{enabled:boolean, channel:string, reason?:string, sentry?:object}}
 */
function initTelemetry(opts = {}) {
  const deps = opts.deps || {};
  const version = opts.version || '0.0.0';
  const config = opts.config || {};

  // 1) OPT-OUT KAPISI — en başta. Kapalıysa hiçbir şey başlatılmaz.
  if (!isEnabledByConfig(config)) {
    return { enabled: false, channel: 'off', reason: 'opt-out' };
  }

  // INT-OBS-01 — tek çözüm zinciri (provision store → telemetry.env → process.env).
  // `deps.provisionStore` verilmezse davranış ADP-715'teki gibidir.
  const env = resolveTelemetryEnv(deps);
  const channel = resolveChannel({ buildChannel: deps.buildChannel, ...(deps.channelOverride || {}) });
  const dsn = resolveDsn(channel, env);

  // 2) DSN yoksa devre dışı (koda gömülü DSN YOK — çözülemezse sessizce kapalı).
  if (!dsn) {
    return { enabled: false, channel, reason: 'no-dsn' };
  }

  // 3) Sentry SDK — opsiyonel lazy require. Kurulu değilse sessizce kapalı.
  let Sentry = deps.sentry;
  if (!Sentry) {
    try { Sentry = require('@sentry/electron/main'); }
    catch { return { enabled: false, channel, reason: 'sdk-missing' }; }
  }

  const os = deps.os || require('node:os');
  Sentry.init({
    dsn,
    release: `${APP}@${version}`,
    environment: channel,            // prod | dev | test — Sentry ortam etiketi
    // Kullanım ölçümü minimal: performans/iz örneklemi kapalı, yalnız hata.
    tracesSampleRate: 0,
    sendDefaultPii: false,           // Sentry'nin kendi PII toplamasını kapat
    // GİZLİLİK SÜZGECİ — giden her olay burada temizlenir.
    beforeSend(event) { return scrubEvent(event); },
    beforeBreadcrumb(crumb) {
      // Breadcrumb mesajları da içerik taşıyabilir → düşür/temizle.
      if (crumb && typeof crumb.message === 'string') {
        const { scrubString } = require('./scrub.cjs');
        crumb.message = scrubString(crumb.message);
      }
      if (crumb && crumb.data) delete crumb.data;
      return crumb;
    },
    initialScope: {
      tags: { channel, app: APP, os: os.platform(), os_release: os.release(), app_version: version },
    },
  });

  return { enabled: true, channel, sentry: Sentry };
}

/** Elle hata bildir (opsiyonel — otomatik yakalama zaten kurulur). */
function captureError(handle, err) {
  if (handle && handle.enabled && handle.sentry) handle.sentry.captureException(err);
}

/**
 * INT-OBS-01 — TELEMETRİ ANAHTARLARININ TEK ÇÖZÜM ZİNCİRİ.
 *
 * Eskiden anahtarların tek kaynağı `~/.crewpane/telemetry.env` idi: elle yazılan,
 * uygulamanın göremediği, yanlış yazıldığında SESSİZCE çalışmayan bir dosya.
 * (Ölçüldü — bugünkü dosyada anahtar `CREWPANE_POSTHOG_KEY` yazıyordu, oysa
 * `channel.cjs` `CREWPANE_POSTHOG_KEY_PROD/_DEV` okur: PostHog anahtarı hiçbir
 * zaman çözülmüyordu ve kimse fark etmedi. "Tek yapılandırma yüzeyi" kuralının
 * neden pazarlıksız olduğunun kanıtı bu.)
 *
 * Artık sıra ŞUDUR ve TEK YERDE yazılıdır:
 *
 *     1) provision store   ← Entegrasyon Merkezi'nde "Bağla" ile ÜRÜN yazar (YENİ YOL)
 *     2) telemetry.env     ← elle yazılan ESKİ dosya (GERİYE DÖNÜK, hâlâ çalışır)
 *     3) process.env       ← CI/build-zamanı
 *
 * Üstteki kazanır. `overlay` boşsa davranış ESKİSİYLE BİREBİR AYNIDIR — yani bu
 * ek, mevcut kurulumların hiçbirini bozmaz (`telemetryEnvBackCompat.test.cjs`).
 *
 * 🔴 KANAL KİLİDİ DEĞİŞMEDİ: burada üretilen şey yalnızca env ADLARINA sahip düz
 * bir nesnedir. Hangi kanalın hangi anahtarı görebileceğine yine ve YALNIZ
 * `channel.resolveDsn` / `resolvePostHogKey` karar verir. Store'dan gelen prod
 * DSN'i de dosyadan gelen kadar kilitlidir (`provisionChannelLock.test.cjs`).
 *
 * @param {object} [deps]
 * @param {{envSync:()=>Record<string,string>}} [deps.provisionStore]
 * @returns {Record<string,string>} process.env'i MUTASYONA UĞRATMAYAN birleşik görünüm
 */
function resolveTelemetryEnv(deps = {}) {
  // Eski davranış korunuyor: dosya okunur, process.env'e eksikler yazılır.
  const base = loadDsnEnvFromCrewPane(deps);
  let overlay = {};
  try {
    const st = deps.provisionStore;
    if (st && typeof st.envSync === 'function') overlay = st.envSync() || {};
  } catch {
    // Store okunamazsa (Keychain kilitli, bozuk blob) telemetri SESSİZCE eski
    // yola düşer — gözlemlenebilirlik hiçbir zaman arıza kaynağı olamaz.
    overlay = {};
  }
  // Kopya döner: store'dan gelen değerler `process.env`e YAZILMAZ, dolayısıyla
  // spawn edilen ajan süreçlerinin ortamına da sızmaz.
  const merged = { ...base };
  for (const [k, v] of Object.entries(overlay)) {
    if (typeof v === 'string' && v.trim()) merged[k] = v.trim();
  }
  // TEL-01 — EN DÜŞÜK ÖNCELİK: paketleme sırasında `extraMetadata.crewpaneTelemetry`
  // ile gömülen vendor anahtarları. Müşteri makinesinde üstteki üç kaynak (store,
  // telemetry.env, process.env) HER ZAMAN boştur — 30 günde win32/linux'tan sıfır
  // olayın kökü buydu. Gömülü değer yalnız BOŞ kalan adı doldurur: CrewPane
  // makinelerindeki mevcut kurulumların davranışı bit-bit aynı kalır ve kanal
  // kilidi (resolveDsn/resolvePostHogKey) aynen geçerlidir. process.env'e
  // YAZILMAZ → ajan pane'lerine sızmaz (BR-04 süpürgesiyle uyumlu).
  const baked = bakedVendor.readBakedKeys(deps);
  for (const [k, v] of Object.entries(baked)) {
    if (!(typeof merged[k] === 'string' && merged[k].trim())) merged[k] = v;
  }
  return merged;
}

module.exports = {
  initTelemetry, isEnabledByConfig, captureError, loadDsnEnvFromCrewPane, resolveTelemetryEnv,
};
