// INT-OBS-01 — OTOMATİK KURULUMUN SONUCU (kanal başına anahtar + durum defteri).
//
// "Bağla"ya basıldığında ürün Sentry/PostHog API'sinden şunları ÜRETİR: hangi org,
// hangi proje, hangi DSN / hangi `phc_…` anahtarı, hangi bölge. Bu dosya o sonucu
// TEK yerde, ŞİFRELİ tutar ve telemetri katmanının okuduğu env görünümüne çevirir.
//
// ─── NEDEN credentialVault'a YAZMIYORUZ (bilinçli sınır) ─────────────────────
// İlk refleks "her şey vault'a" idi; ÖLÇÜLEREK vazgeçildi:
//   1. FATURA/PLAN YAN ETKİSİ. `integ:add` plan tavanını `records.length` ile
//      sayar (main.js). Kanal başına üretilen 4 türev anahtar vault'a yazılsaydı
//      Sentry+PostHog bağlayan bir kullanıcı 2 değil 6 "entegrasyon" harcardı —
//      yani gözlemlenebilirliği açmak kullanıcının kotasını yerdi. Sessiz,
//      teşhisi zor, doğrudan paraya dokunan bir hata.
//   2. UI GÖRÜNÜRLÜĞÜ. "Bağlı Hesaplar" ekranı KATALOG'a göre çizer; katalogda
//      olmayan `sentry-dsn` gibi kayıtlar listede görünmez ama sayılırdı —
//      kullanıcının göremediği ama kotasını yiyen kayıt = kabul edilemez.
//   3. DEĞERİN SINIFI FARKLI. Buradaki değerler (DSN, `phc_…`) tasarım gereği
//      İSTEMCİYE GÖMÜLEN yazma-anahtarlarıdır; kullanıcının KİMLİĞİ olan
//      org jetonu ise credentialVault'ta kalır (Kural 3 bozulmadı).
// Yine de bu dosya DÜZ METİN DEĞİLDİR: aynı `safeStorage` sarımı kullanılır
// (credentialVault ile AYNI kripto yolu — ikinci bir kripto ASLA yazılmaz).
//
// ─── TEK GERÇEK (Kural 1) ────────────────────────────────────────────────────
// Telemetri anahtarlarının çözüm sırası TEK ve YAZILIDIR (telemetry.cjs):
//     provision store (UI ile yazılır)  →  ~/.crewpane/telemetry.env (ESKİ yol)
// Yani yeni yol UI'dır, eski dosya GERİYE DÖNÜK olarak çalışmaya devam eder ve
// ikisi çakışırsa UI kazanır. İkinci bir "acaba hangisi geçerli" sorusu yok.
//
// ─── KANAL KİLİDİ (Kural 2) ──────────────────────────────────────────────────
// Bu dosya kanal kararı VERMEZ. Yalnız `CREWPANE_*_PROD` / `_DEV` adlı bir env
// GÖRÜNÜMÜ üretir; hangi kanalın hangisini görebileceğine ADP-715'ten beri
// `channel.cjs` karar verir ve o mantık DEĞİŞTİRİLMEDİ. Yani vault'tan gelen
// prod DSN'i de tam olarak dosyadan gelen prod DSN'i kadar kilitlidir
// (`provisionChannelLock.test.cjs` bunu ölçer).

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STORE_VERSION = 1;
const SERVICES = Object.freeze(['sentry', 'posthog']);
const CHANNELS = Object.freeze(['prod', 'dev']);

const CREWPANE_AUTH_DIR = fs.existsSync(path.join(__dirname, '..', 'packages', 'crewpane-auth'))
  ? path.join(__dirname, '..', 'packages', 'crewpane-auth')
  : path.join(__dirname, '..', '..', 'packages', 'crewpane-auth');

/** Maskele — durum ekranına/log'a giden TEK biçim (ham değer asla). */
function mask(value, keepPrefix = 8, keepSuffix = 4) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) return '';
  if (s.length < keepPrefix + keepSuffix + 4) return '••••';
  return `${s.slice(0, keepPrefix)}••••${s.slice(-keepSuffix)}`;
}

/** DSN'i gösterilebilir hâle getir: `https://<anahtar>@o1.ingest…/42` → anahtar maskeli. */
function maskDsn(dsn) {
  const s = typeof dsn === 'string' ? dsn.trim() : '';
  if (!s) return '';
  try {
    const u = new URL(s);
    return `${u.protocol}//${mask(u.username, 4, 4)}@${u.host}${u.pathname}`;
  } catch {
    return mask(s);
  }
}

function emptyDoc() {
  return { version: STORE_VERSION, services: {} };
}

/**
 * Kayıtlı sonucu telemetri katmanının anladığı ENV GÖRÜNÜMÜNE çevir.
 * Adlar ADP-715'ten beri aynı — yeni bir isim uydurmuyoruz ki `channel.cjs`
 * dokunulmadan çalışsın (Kural 2'nin yapısal karşılığı).
 * @returns {Record<string,string>} yalnız DOLU olanlar
 */
function toEnv(doc) {
  const out = {};
  const services = (doc && doc.services) || {};

  const sentry = services.sentry || {};
  const sc = sentry.channels || {};
  if (sc.prod && sc.prod.dsn) out.CREWPANE_SENTRY_DSN_PROD = sc.prod.dsn;
  if (sc.dev && sc.dev.dsn) out.CREWPANE_SENTRY_DSN_DEV = sc.dev.dsn;

  const posthog = services.posthog || {};
  const pc = posthog.channels || {};
  if (pc.prod && pc.prod.apiToken) out.CREWPANE_POSTHOG_KEY_PROD = pc.prod.apiToken;
  if (pc.dev && pc.dev.apiToken) out.CREWPANE_POSTHOG_KEY_DEV = pc.dev.apiToken;
  // Host kanaldan BAĞIMSIZ tek değişken (channel.resolvePostHogHost ile aynı sözleşme).
  if (posthog.host) out.CREWPANE_POSTHOG_HOST = posthog.host;

  return out;
}

/**
 * Durum yüzeyi (F4) — SIR İÇERMEZ. "Sentry: bağlı · crewpane-prod · son olay 2 dk önce"
 * cümlesinin ham verisi. Renderer'a giden TEK görünüm budur.
 */
function toStatus(doc, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const services = (doc && doc.services) || {};
  return SERVICES.map((id) => {
    const s = services[id];
    if (!s) return { service: id, connected: false, channels: [], org: null, lastVerify: null };
    const channels = CHANNELS
      .map((ch) => {
        const c = (s.channels || {})[ch];
        if (!c) return null;
        return {
          channel: ch,
          project: c.project || c.projectName || null,
          // Maskeli — ham DSN/anahtar renderer'a GİTMEZ.
          masked: id === 'sentry' ? maskDsn(c.dsn) : mask(c.apiToken),
        };
      })
      .filter(Boolean);
    const lv = s.lastVerify || null;
    return {
      service: id,
      connected: channels.length > 0,
      org: s.org ? s.org.slug || s.org.name || null : null,
      region: s.region || null,
      host: s.host || null,
      provisionedAt: s.provisionedAt || null,
      // INT-OBS-02: 'free-single' = ücretsiz-plan tek-proje modu (dev kanalı bilinçli
      // kapalı; plan yükseltilince "Kurulumu yenile" 3-proje düzenine geçirir).
      planMode: s.planMode || null,
      channels,
      lastVerify: lv
        ? {
          at: lv.at,
          ok: lv.ok === true,
          channel: lv.channel || null,
          method: lv.method || null,
          detail: lv.detail || null,
          ageMs: lv.at ? Math.max(0, now - Date.parse(lv.at)) : null,
        }
        : null,
    };
  });
}

/**
 * INT-OBS-02 — telemetry.env / process.env'de ÇALIŞIR anahtar var mı (hub kartı).
 * Store boş diye "Kurulmadı" demek, elle kurulmuş (`~/.crewpane/telemetry.env`)
 * ve ŞU AN AKAN bir telemetriyi yok saymak olur — durum yüzeyi gerçeği söyler.
 * Yalnız VARLIK döner (boolean) — değerin kendisi asla.
 */
function envPresence(env) {
  const e = env || {};
  const has = (k) => typeof e[k] === 'string' && e[k].trim() !== '';
  return {
    sentry: { prod: has('CREWPANE_SENTRY_DSN_PROD'), dev: has('CREWPANE_SENTRY_DSN_DEV') },
    posthog: { prod: has('CREWPANE_POSTHOG_KEY_PROD'), dev: has('CREWPANE_POSTHOG_KEY_DEV') },
  };
}

/**
 * @param {object} opts
 * @param {{isEncryptionAvailable:()=>boolean, encryptString:Function, decryptString:Function}} opts.safeStorage
 * @param {string} opts.homeDir  <crewpaneHome> (instance-aware — çağıran çözer)
 * @param {()=>string} [opts.now]
 * @param {(line:string)=>void} [opts.log]
 */
function createProvisionStore(opts = {}) {
  const { safeStorage } = opts;
  const homeDir = opts.homeDir || require('../src/config/instancePaths.cjs').crewpaneHome();
  const now = opts.now || (() => new Date().toISOString());
  const log = opts.log || (() => {});
  const filePath = path.join(homeDir, 'telemetry', 'provision.bin');

  const { createSafeStorageTokenStore } = require(path.join(CREWPANE_AUTH_DIR, 'index.cjs'));
  const store = createSafeStorageTokenStore({ safeStorage, filePath });

  function isAvailable() {
    try { return safeStorage.isEncryptionAvailable() === true; } catch { return false; }
  }

  /**
   * SENKRON okuma — telemetri açılışın İLK saniyesinde kurulur (obsReporterNow /
   * analyticsNow senkron sözleşmeli). credentialVault.readDocSync ile AYNI gerekçe
   * ve AYNI kripto (safeStorage); elle kripto YOK.
   */
  function readSync() {
    if (!isAvailable()) return emptyDoc();
    let raw;
    try { raw = fs.readFileSync(filePath); } catch { return emptyDoc(); }
    try {
      const doc = JSON.parse(safeStorage.decryptString(raw));
      if (!doc || typeof doc !== 'object' || typeof doc.services !== 'object') return emptyDoc();
      return { version: doc.version || STORE_VERSION, services: doc.services || {} };
    } catch {
      return emptyDoc(); // çözülemeyen blob = kayıt yok (fail-closed)
    }
  }

  async function read() {
    if (!isAvailable()) return emptyDoc();
    try {
      const doc = await store.load();
      if (!doc || typeof doc.services !== 'object') return emptyDoc();
      return { version: doc.version || STORE_VERSION, services: doc.services || {} };
    } catch {
      return emptyDoc();
    }
  }

  return {
    filePath,
    isAvailable,
    read,
    readSync,

    /** Telemetri env görünümü (senkron — açılış yolunda çağrılır). */
    envSync() {
      return toEnv(readSync());
    },

    /** Durum görünümü — SIR İÇERMEZ. */
    async status() {
      return toStatus(await read());
    },

    /**
     * Bir servisin kurulum sonucunu YAZ. İDEMPOTENT (Kural 5): aynı servis için
     * ikinci çağrı ÜSTÜNE yazar, ikinci kayıt DOĞURMAZ.
     * @param {'sentry'|'posthog'} service
     * @param {object} result  {org, team?, region?, host?, channels:{prod?,dev?}}
     */
    async save(service, result) {
      if (!SERVICES.includes(service)) throw new Error(`provisionStore: bilinmeyen servis ${service}`);
      if (!isAvailable()) {
        return { ok: false, reason: 'store-unavailable' };
      }
      const doc = await read();
      const prev = doc.services[service] || {};
      doc.services[service] = {
        ...prev,
        ...result,
        // Kanal blokları BİRLEŞTİRİLİR: yalnız dev kurulduysa prod kaydı silinmesin.
        channels: { ...(prev.channels || {}), ...(result.channels || {}) },
        provisionedAt: now(),
      };
      await store.save({ version: STORE_VERSION, services: doc.services });
      log(`telemetry-provision: ${service} kaydedildi kanal=${Object.keys(doc.services[service].channels || {}).join('+') || '-'}`);
      return { ok: true };
    },

    /** Doğrulama olayının SONUCUNU işle (F4 "son olay …" satırının kaynağı). */
    async noteVerify(service, verify) {
      if (!SERVICES.includes(service) || !isAvailable()) return { ok: false };
      const doc = await read();
      if (!doc.services[service]) return { ok: false };
      doc.services[service].lastVerify = {
        at: now(),
        ok: verify && verify.ok === true,
        channel: (verify && verify.channel) || null,
        method: (verify && verify.method) || null,
        detail: (verify && verify.detail) || null,
      };
      await store.save({ version: STORE_VERSION, services: doc.services });
      return { ok: true };
    },

    /** Bağlantıyı kes → kurulum sonucu da gitsin (yetim DSN kalmasın). */
    async clear(service) {
      if (!isAvailable()) return { ok: false };
      const doc = await read();
      if (!doc.services[service]) return { ok: true, removed: false };
      delete doc.services[service];
      await store.save({ version: STORE_VERSION, services: doc.services });
      log(`telemetry-provision: ${service} temizlendi`);
      return { ok: true, removed: true };
    },
  };
}

module.exports = {
  STORE_VERSION,
  SERVICES,
  CHANNELS,
  mask,
  maskDsn,
  emptyDoc,
  toEnv,
  toStatus,
  envPresence,
  createProvisionStore,
};
