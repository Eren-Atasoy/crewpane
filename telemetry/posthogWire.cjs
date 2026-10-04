// OBS-01 — POSTHOG TELİ (batch gövdesi + gönderim). SDK YOK, BİLEREK.
//
// ─── NEDEN `posthog-js` / `posthog-node` DEĞİL ───────────────────────────────
// Eren'in kararı BACKEND hakkındaydı: "PostHog Cloud, self-host değil". Bu modül
// o kararı birebir uygular — gerçek PostHog Cloud ingest ucuna (`/batch/`)
// konuşur. Değişen tek şey aradaki istemcidir. OBS-02'nin Sentry kararıyla AYNI
// üç gerekçe, üstelik analitikte daha keskin:
//
//  1. 🔴 GİZLİLİK — SDK KARA LİSTE, BU MODÜL BEYAZ LİSTE.
//     `posthog-js`in varsayılan iki davranışı bu ürünün pazarlık-dışı kuralını
//     İLK GÜN deler:
//       • autocapture — her tıklamada elementin METNİNİ, `name`/`id`/`class`
//         değerlerini ve DOM yolunu gönderir. CrewPane'te bir buton metni
//         ajanın adı, bir sekme başlığı görev kodu, bir input `value`si prompt'un
//         kendisidir. Sitede ise form alanı e-posta taşır.
//       • `$current_url` — TAM URL, query string DAHİL (utm + lead e-postası).
//       • session recording — ekranın videosu. Tartışılacak bir şey yok.
//     Bunların hepsi "sonradan kapatılır" ayarlardır; biz hiç var olmayan bir
//     yüzey istiyoruz. Burada gövde `analyticsSchema` tarafından, alan alan,
//     KAPALI KÜMELERDEN kurulur.
//
//  2. TEK AĞ BOĞAZI → "kapalıyken sıfır istek" KANITLANABİLİR. Giden tek
//     fonksiyon `sendBatch`; kapı ondan önce (`analytics.cjs`). SDK'da olay,
//     `$identify`, feature-flag yoklaması, decide/remote-config ve recording için
//     BİRDEN FAZLA giden yol vardır — "sıfır istek" iddiası orada denetlenemez.
//     (Feature flag'leri kullanmıyoruz; `/decide` çağrısı hiç yapılmaz.)
//
//  3. PAKETLEME — sıfır bağımlılık. asar + native/worker'lı SDK ikilisi bu üründe
//     daha önce sessizce kırıldı (instancePaths asarUnpack vakası).
//
// Kayıp (dürüstlük): otomatik `$pageleave`/oturum süresi, feature flag'ler ve
// session replay. İlk ikisi bugün sorulmuyor, üçüncüsü zaten yasak.
//
// Wire uyumluluğu: aynı gövde self-host PostHog tarafından da kabul edilir (Eren
// ileride self-host'a dönerse tek değişiklik HOST'tur).
//
// Saf + DI: electron bağı yok, `httpPost` enjekte edilebilir → `node --test`.

'use strict';

/** PostHog Cloud AB (Frankfurt) — OBS-02'nin Sentry AB kararıyla aynı yargı alanı. */
const DEFAULT_HOST = 'https://eu.i.posthog.com';
const CLIENT_NAME = 'crewpane-obs';
const CLIENT_VERSION = '1.0.0';

/**
 * Ingest hostunu çöz. Sadece http(s) ve YALNIZ origin (yol/query atılır) —
 * yapılandırma hatası bir isteği başka bir yere yönlendiremesin.
 * @returns {string|null}
 */
function resolveHost(raw) {
  const value = (typeof raw === 'string' && raw.trim()) || DEFAULT_HOST;
  let u;
  try { u = new URL(value); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  return `${u.protocol}//${u.host}`;
}

/** PostHog proje yazma anahtarı biçimi (`phc_…`). Başka hiçbir şey kabul edilmez. */
function isProjectKey(key) {
  return typeof key === 'string' && /^phc_[A-Za-z0-9]{16,}$/.test(key.trim());
}

/**
 * Batch gövdesi kur — BEYAZ LİSTE. Buraya yazılmayan hiçbir alan gitmez.
 *
 * @param {object} input
 * @param {string} input.apiKey
 * @param {string} input.distinctId
 * @param {Array<{name:string, properties:object, timestamp:number}>} input.events
 * @returns {string} JSON gövde
 */
function buildBatch(input) {
  return JSON.stringify({
    api_key: input.apiKey,
    // Geçmiş veri aktarımı DEĞİL: olaylar oluştukları anda damgalanır.
    historical_migration: false,
    batch: input.events.map((e) => ({
      event: e.name,
      /**
       * NOT: PostHog'un `$`-önekli otomatik özelliklerinden HİÇBİRİ üretilmez —
       * `$current_url`, `$referrer`, `$ip`, `$screen_*`, `$device_id`, `$os`,
       * `$browser` yok. `$lib` yalnız hangi istemcinin yazdığını söyler (destek
       * için), `$ip: null` ise PostHog'a "IP'yi KAYDETME" der: sunucu tarafında
       * ingest IP'yi olaya yazmasın (kapalı kutuya güvenmiyoruz ama söylemek
       * bedava ve tek katman daha).
       */
      properties: {
        ...e.properties,
        distinct_id: input.distinctId,
        $lib: CLIENT_NAME,
        $lib_version: CLIENT_VERSION,
        $ip: null,
      },
      timestamp: new Date(e.timestamp).toISOString(),
    })),
  });
}

/**
 * Varsayılan taşıyıcı: node:https/http POST. ASLA throw etmez, ASLA beklemez.
 * OBS-02 `sentryWire.defaultHttpPost` ile birebir aynı sözleşme.
 * @returns {Promise<{ok:boolean, status?:number, error?:string}>}
 */
function defaultHttpPost({ url, headers, body, timeoutMs }) {
  return new Promise((resolve) => {
    let mod;
    try {
      mod = url.startsWith('https:') ? require('node:https') : require('node:http');
    } catch (e) {
      resolve({ ok: false, error: String(e && e.message) });
      return;
    }
    let req;
    try {
      req = mod.request(url, { method: 'POST', headers }, (res) => {
        res.resume(); // gövdeyi tüket, sızdırma
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode });
      });
    } catch (e) {
      resolve({ ok: false, error: String(e && e.message) });
      return;
    }
    req.setTimeout(timeoutMs || 8000, () => {
      try { req.destroy(new Error('timeout')); } catch { /* zaten öldü */ }
    });
    req.on('error', (e) => resolve({ ok: false, error: String(e && e.message) }));
    try { req.end(body); } catch (e) { resolve({ ok: false, error: String(e && e.message) }); }
  });
}

/**
 * Olay yığınını ingest'e gönder. TEK GİDEN FONKSİYON.
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} [opts.host]
 * @param {string} opts.distinctId
 * @param {Array} opts.events
 * @param {(req:object)=>Promise<object>} [opts.httpPost]  DI (test/kanıt)
 */
async function sendBatch(opts) {
  const host = resolveHost(opts.host);
  if (!host) return { ok: false, error: 'bad-host' };
  if (!isProjectKey(opts.apiKey)) return { ok: false, error: 'bad-key' };
  if (!Array.isArray(opts.events) || !opts.events.length) return { ok: false, error: 'empty' };
  const body = buildBatch({ apiKey: opts.apiKey.trim(), distinctId: opts.distinctId, events: opts.events });
  const post = opts.httpPost || defaultHttpPost;
  return post({
    url: `${host}/batch/`,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body, 'utf8'),
      'User-Agent': `${CLIENT_NAME}/${CLIENT_VERSION}`,
    },
    body,
    timeoutMs: opts.timeoutMs,
  });
}

module.exports = {
  resolveHost, isProjectKey, buildBatch, sendBatch, defaultHttpPost,
  DEFAULT_HOST, CLIENT_NAME, CLIENT_VERSION,
};
