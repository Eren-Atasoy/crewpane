// OBS-02 — SENTRY TELİ (envelope üretimi + gönderim). SDK YOK, BİLEREK.
//
// ─── NEDEN `@sentry/electron` DEĞİL ──────────────────────────────────────────
// Eren'in kararı BACKEND hakkındaydı: "bulut Sentry, self-host değil". Bu modül
// o kararı birebir uygular — gerçek Sentry Cloud ingest protokolüne (envelope)
// konuşur. Ama ARADAKİ İSTEMCİ olarak resmi SDK'yı KULLANMAZ; üç ölçülmüş neden:
//
//  1. 🔴 GİZLİLİK — SDK KARA LİSTE, BU MODÜL BEYAZ LİSTE.
//     `@sentry/electron` varsayılan olarak **native minidump** yükler. Minidump =
//     sürecin BELLEK GÖRÜNTÜSÜ; içinde o an işlenen prompt metni, dosya içeriği ve
//     env'deki API anahtarları AYNEN durur. `beforeSend` minidump'a UĞRAMAZ (ayrı
//     yükleme yolu). Yani "sonradan temizlerim" duruşu, görevin pazarlık-dışı
//     kuralını daha ilk gün deler. Burada olay SIFIRDAN, alan alan kurulur:
//     gönderilen şey ne ise ancak O gider. Sızıntı "unutulmuş bir filtre" ile
//     değil, ancak bu dosyaya BİLEREK alan eklenerek olabilir.
//     Aynı sebeple `server_name` HİÇ gönderilmez: SDK'lar oraya hostname yazar ve
//     macOS hostname'i tipik olarak kullanıcının ADIDIR ("Erens-MacBook-Pro").
//
//  2. TEK AĞ BOĞAZI → "kapalıyken sıfır istek" KANITLANABİLİR. Giden tek bir
//     fonksiyon var (`sendEnvelope`); kapalıyken çağrılmaz. SDK'da olay/oturum/
//     kullanıcı-geri-bildirimi/minidump için birden fazla giden yol vardır.
//
//  3. PAKETLEME. asar + native uploader ikilisi bu üründe daha önce sessizce
//     kırıldı (instancePaths asarUnpack vakası). Sıfır bağımlılık = o sınıf risk yok.
//
// Kayıp: otomatik breadcrumb/performans izleme ve sourcemap çözümleme. İlk ikisini
// gizlilik gereği ZATEN istemiyoruz. Sourcemap ayrı bir yayın adımıdır (rapor §GATED).
//
// Wire uyumluluğu: aynı envelope GlitchTip tarafından da kabul edilir (Eren ileride
// self-host'a dönerse tek değişiklik DSN'dir).
//
// Saf + DI: electron bağı yok, `httpPost` enjekte edilebilir → `node --test` altında koşar.

'use strict';

const SENTRY_VERSION = '7';
const CLIENT_NAME = 'crewpane-obs';
const CLIENT_VERSION = '1.0.0';

/** Sentry seviyeleri — UYARI ile HATA ayrı (görev gereksinimi 4). */
const LEVELS = new Set(['fatal', 'error', 'warning', 'info', 'debug']);

/**
 * DSN'i ingest bileşenlerine çöz.
 * DSN biçimi: https://<publicKey>@<host>[:port]/<projectId>
 * @returns {{publicKey:string, host:string, protocol:string, port:string, projectId:string,
 *            envelopeUrl:string, authHeader:string}|null}  bozuk DSN → null (ASLA throw)
 */
function parseDsn(dsn) {
  if (typeof dsn !== 'string' || !dsn.trim()) return null;
  let u;
  try { u = new URL(dsn.trim()); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const publicKey = u.username;
  if (!publicKey) return null;
  // path = /<projectId>  (eski biçimlerde /<path>/<projectId>)
  const segments = u.pathname.split('/').filter(Boolean);
  const projectId = segments.pop();
  if (!projectId || !/^\d+$/.test(projectId)) return null;
  const prefix = segments.length ? `/${segments.join('/')}` : '';
  const origin = `${u.protocol}//${u.host}`;
  return {
    publicKey,
    host: u.hostname,
    protocol: u.protocol.replace(':', ''),
    port: u.port,
    projectId,
    envelopeUrl: `${origin}${prefix}/api/${projectId}/envelope/`,
    authHeader:
      `Sentry sentry_version=${SENTRY_VERSION}, ` +
      `sentry_client=${CLIENT_NAME}/${CLIENT_VERSION}, ` +
      `sentry_key=${publicKey}`,
  };
}

/** RFC4122-vari 32 hex — Sentry event_id biçimi (tire yok). */
function newEventId(rand) {
  const r = typeof rand === 'function' ? rand : Math.random;
  let out = '';
  for (let i = 0; i < 32; i++) out += Math.floor(r() * 16).toString(16);
  return out;
}

/**
 * `Error.stack` → Sentry frame dizisi.
 *
 * ⚠️ Frame'lerde YALNIZ dört alan taşınır: dosya, fonksiyon, satır, sütun.
 * `vars` (yerel değişkenler) ve `context_line` (kaynak kod satırı) BURADA HİÇ
 * ÜRETİLMEZ — SDK'da bunları sonradan silmek gerekiyordu, burada var olmuyorlar.
 *
 * @param {string} stack
 * @param {(p:string)=>string} maskPath  yol maskeleyici (scrubPath bağlanır)
 */
function framesFromStack(stack, maskPath) {
  if (typeof stack !== 'string' || !stack) return [];
  const mask = typeof maskPath === 'function' ? maskPath : (p) => p;
  const frames = [];
  const lines = stack.split('\n').slice(1); // ilk satır "Type: message"
  for (const line of lines) {
    // "    at fn (/path/file.js:12:34)"  ·  "    at /path/file.js:12:34"
    const m =
      line.match(/^\s*at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)\s*$/) ||
      line.match(/^\s*at\s+()(.+?):(\d+):(\d+)\s*$/);
    if (!m) continue;
    const fn = (m[1] || '?').trim();
    const filename = mask(m[2]);
    frames.push({
      filename,
      function: fn.length > 120 ? fn.slice(0, 120) : fn,
      lineno: Number(m[3]),
      colno: Number(m[4]),
      // Uygulama kökünün altındaki (göreli yazılmış) yollar bizim kodumuz.
      in_app: !filename.startsWith('~') && !filename.includes('node_modules'),
    });
  }
  // Sentry frame'leri en ESKİDEN en YENİYE bekler; V8 stack tersidir.
  return frames.reverse().slice(-40);
}

/**
 * Sentry olay gövdesi kur — BEYAZ LİSTE. Buraya yazılmayan hiçbir alan gitmez.
 *
 * @param {object} input
 * @param {string} input.type        exception tipi ('TypeError', 'moduleFault'…)
 * @param {string} input.value       insan-okunur mesaj (ÇAĞIRAN temizler)
 * @param {Array}  [input.frames]    framesFromStack çıktısı
 * @param {string} input.level       fatal|error|warning|info|debug
 * @param {string} input.release     'crewpane@0.2.32'
 * @param {string} input.environment 'prod'|'dev'|'test'
 * @param {object} input.tags        sürüm/platform/mimari damgası (gereksinim 2)
 * @param {string} [input.logger]    'crewpane.main' | '.renderer' | '.worker'
 * @param {Array}  [input.fingerprint]
 * @param {number} [input.timestamp] unix saniye
 * @param {string} [input.eventId]
 * @param {string} [input.platform]  'node' | 'javascript'
 */
function buildEvent(input) {
  const level = LEVELS.has(input.level) ? input.level : 'error';
  const event = {
    event_id: input.eventId || newEventId(input.rand),
    timestamp: typeof input.timestamp === 'number' ? input.timestamp : Math.floor(Date.now() / 1000),
    platform: input.platform === 'javascript' ? 'javascript' : 'node',
    level,
    logger: input.logger || 'crewpane',
    release: input.release,
    environment: input.environment,
    tags: { ...(input.tags || {}) },
    exception: {
      values: [
        {
          type: String(input.type || 'Error').slice(0, 120),
          value: String(input.value == null ? '' : input.value).slice(0, 1000),
          ...(Array.isArray(input.frames) && input.frames.length
            ? { stacktrace: { frames: input.frames } }
            : {}),
        },
      ],
    },
  };
  if (Array.isArray(input.fingerprint) && input.fingerprint.length) {
    event.fingerprint = input.fingerprint.map((f) => String(f).slice(0, 200));
  }
  if (input.contexts && typeof input.contexts === 'object') event.contexts = input.contexts;
  // NOT: `server_name` (hostname), `user`, `request`, `breadcrumbs`, `extra`,
  // `modules` BİLEREK YOK. Bunlar SDK'nın sızıntı yüzeyleridir.
  return event;
}

/**
 * Olayı Sentry envelope metnine çevir (newline-delimited JSON).
 * @param {object} event  buildEvent çıktısı
 * @param {string} dsn
 * @param {string} [sentAtIso]
 */
function buildEnvelope(event, dsn, sentAtIso) {
  const header = JSON.stringify({
    event_id: event.event_id,
    sent_at: sentAtIso || new Date().toISOString(),
    dsn,
  });
  const body = JSON.stringify(event);
  const itemHeader = JSON.stringify({
    type: 'event',
    content_type: 'application/json',
    length: Buffer.byteLength(body, 'utf8'),
  });
  return `${header}\n${itemHeader}\n${body}\n`;
}

/**
 * Varsayılan taşıyıcı: node:https/http POST. ASLA throw etmez, ASLA beklemez
 * (hata takibi uygulamayı yavaşlatamaz/çökertemez).
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
 * Envelope'u ingest'e gönder.
 * @param {object} opts
 * @param {string} opts.dsn
 * @param {object} opts.event
 * @param {(req:object)=>Promise<object>} [opts.httpPost]  DI (test/kanıt)
 */
async function sendEnvelope(opts) {
  const parsed = parseDsn(opts.dsn);
  if (!parsed) return { ok: false, error: 'bad-dsn' };
  const body = buildEnvelope(opts.event, opts.dsn, opts.sentAtIso);
  const post = opts.httpPost || defaultHttpPost;
  return post({
    url: parsed.envelopeUrl,
    headers: {
      'Content-Type': 'application/x-sentry-envelope',
      'X-Sentry-Auth': parsed.authHeader,
      'Content-Length': Buffer.byteLength(body, 'utf8'),
    },
    body,
    timeoutMs: opts.timeoutMs,
  });
}

module.exports = {
  parseDsn,
  buildEvent,
  buildEnvelope,
  framesFromStack,
  sendEnvelope,
  newEventId,
  defaultHttpPost,
  LEVELS,
  SENTRY_VERSION,
};
