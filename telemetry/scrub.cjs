// ADP-715 (P0 LANSMAN — GÖRÜNÜRLÜK) — Telemetri GİZLİLİK SÜZGECİ.
//
// SERT KURAL: müşteri prompt'ları, kod, dosya içerikleri, API anahtarları,
// e-posta/dosya yolları, ekran görüntüsü İÇERİĞİ ASLA dışarı gitmez. Sentry'ye
// (ya da wire-uyumlu GlitchTip'e) gönderilen HER olay, gönderilmeden ÖNCE bu
// süzgeçten (`scrubEvent`) geçer — SDK'nın `beforeSend` kancasına takılır.
//
// İki savunma katmanı:
//   1. ALAN DÜŞÜRME — içerik taşıması KESİN olan alanlar tümden silinir
//      (yerel değişkenler, request gövdesi/başlıkları/çerezleri, ekran içeriği).
//   2. STRING MASKELEME — kalan tüm string'ler derinlemesine gezilir; anahtar/
//      token desenleri, ev-dizini yolları ve e-postalar maskelenir.
//
// Saf + bağımsız: hiçbir require yok → düz `node --test` altında koşar. CrewPane
// (crewpane) ve AgentVoice (Python) eşlenikleri BİREBİR aynı desenleri uygular.

'use strict';

const MASK = '[redacted]';
const PATH_MASK = '~';

// --- Anahtar / token desenleri (değer maskelenir) --------------------------
// Sıra önemli: daha spesifik olanlar önce. Her biri eşleşen SIRRI MASK ile değişir.
const SECRET_PATTERNS = [
  // Anthropic / OpenAI stil: sk-ant-..., sk-proj-..., sk-...
  /sk-(?:ant|proj|live|test)?-?[A-Za-z0-9_-]{16,}/g,
  // GitHub token: ghp_, gho_, ghu_, ghs_, ghr_, github_pat_
  /gh[porus]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  // AWS access key id
  /AKIA[0-9A-Z]{16}/g,
  // Slack: xoxb-, xoxp-, xoxa-, xoxr-
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  // Google API key
  /AIza[0-9A-Za-z_-]{35}/g,
  // Stripe live/test secret
  /[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  // JWT (üç base64url parça)
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // Bearer <token>  /  Authorization: <şema> <token>
  /(Bearer\s+)[A-Za-z0-9._-]{12,}/gi,
  // Sentry DSN'in gizli kısmı da sızmasın: https://<public>@host → public'i tut, ama
  // içine gömülü secret varsa (eski DSN formatı https://public:secret@) secret'ı kes.
  /(https?:\/\/[a-f0-9]+):[a-f0-9]+@/gi,
];

// key=value / "key": "value" / key: value biçiminde HASSAS ANAHTAR adları →
// değeri maskele (anahtar adı kalır ki debug edilebilsin).
const SENSITIVE_KEY_RE =
  /\b(api[_-]?key|apikey|secret|token|password|passwd|pwd|auth|authorization|access[_-]?token|refresh[_-]?token|client[_-]?secret|dsn|private[_-]?key|session[_-]?id|cookie)\b/i;

// "anahtar = değer" atama deseni (JSON, env, log satırı) — değeri maskele.
const ASSIGNMENT_RE =
  /\b(api[_-]?key|apikey|secret|token|password|passwd|pwd|authorization|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key)\b(["']?\s*[:=]\s*["']?)([^\s"',;}{]+)/gi;

// Ev dizini yolları: /Users/<ad>/...  ·  /home/<ad>/...  ·  C:\Users\<ad>\...
// Kullanıcı adı + kalan yol tümden maskelenir (~/[redacted]) — dosya yapısı ve
// dosya adları sızmaz. Yol İÇİNDE boşluk olabilir ("CrewPane Apps") → yapısal
// sınırlayıcıya (tırnak/virgül/paren/iki-nokta/yeni-satır) kadar yut. Sonda birkaç
// prose kelimesini fazladan maskelemek GİZLİLİK açısından güvenli (az-veri kaybı).
const UNIX_HOME_RE = /\/(?:Users|home)\/[^\n"':;,)\]]+/g;
const WIN_HOME_RE = /[A-Za-z]:\\Users\\[^\n"':;,)\]]+/g;
const FILE_URL_RE = /file:\/\/\/[^\n"';,)\]]+/g;

// E-posta
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/**
 * Tek bir string'i maskele. Sıra: atama → sırlar → yollar → e-posta.
 * @param {string} s
 * @returns {string}
 */
function scrubString(s) {
  if (typeof s !== 'string' || s.length === 0) return s;
  let out = s;

  // 1) bilinen sır desenleri ÖNCE — aksi halde "Authorization: Bearer <tok>"da
  //    atama kuralı "Bearer"ı değer sanıp token'ı bırakırdı.
  for (const re of SECRET_PATTERNS) {
    // ⚠️ OBS-02 — YAKALAMA GRUBU OLMAYAN DESENDE İKİNCİ ARGÜMAN "OFFSET"TİR.
    // `String.replace` geri çağrısına önce yakalama grupları, sonra offset ve
    // kaynak metin gelir. Grupsuz bir desende (çoğu) ikinci argüman SAYIDIR ve
    // eski kod onu grup sanıp maskenin başına yapıştırıyordu:
    //   "API_KEY=sk-ant-…"  →  "API_KEY=18[redacted]"   ← "18" = eşleşmenin indeksi
    // ADP-715 raporu bunu "kozmetik iki hane artığı" diye not etmişti; artığın
    // kaynağı sırrın kendisi değil, indeksti. Yine de yanlış: her maskelenmiş
    // değere anlamsız bir sayı ekliyor ve okuyanı "sırrın 2 hanesi sızmış" diye
    // düşündürüyordu. Grup ancak STRING ise grup sayılır.
    out = out.replace(re, (_m, ...rest) => {
      const g1 = typeof rest[0] === 'string' ? rest[0] : '';
      return g1 ? `${g1}${MASK}` : MASK;
    });
  }

  // 2) key=value atamaları (kalan atama değerlerini kes, anahtar adını bırak)
  out = out.replace(ASSIGNMENT_RE, (m, key, sep) => `${key}${sep}${MASK}`);

  // 3) ev-dizini yolları → ~/[redacted] (tümden)
  out = out.replace(UNIX_HOME_RE, `${PATH_MASK}/${MASK}`);
  out = out.replace(WIN_HOME_RE, `${PATH_MASK}\\${MASK}`);
  out = out.replace(FILE_URL_RE, `file://${PATH_MASK}/${MASK}`);

  // 4) e-posta
  out = out.replace(EMAIL_RE, MASK);

  return out;
}

/** Bir nesne anahtarı hassas mı? (değeri tümden maskele) */
function isSensitiveKey(key) {
  return typeof key === 'string' && SENSITIVE_KEY_RE.test(key);
}

// Sentry olayında İÇERİK taşıması kesin olan, tümden SİLİNEN yollar.
// (Yerel değişkenler bir stack frame'de sırları/kod parçalarını tutar; request
// gövdesi/başlıkları/çerezleri PII taşır; ekran görüntüsü içeriği yasak.)
function stripHighRiskFields(event) {
  if (!event || typeof event !== 'object') return event;

  // Exception frame'lerindeki yerel değişkenleri (`vars`) sil — kod/sır kaynağı.
  const excValues =
    event.exception && Array.isArray(event.exception.values) ? event.exception.values : [];
  for (const ex of excValues) {
    const frames = ex && ex.stacktrace && Array.isArray(ex.stacktrace.frames)
      ? ex.stacktrace.frames : [];
    for (const f of frames) {
      if (f && f.vars) delete f.vars;
      // pre/post_context = kaynak kod satırları → sil.
      if (f && f.pre_context) delete f.pre_context;
      if (f && f.post_context) delete f.post_context;
      if (f && f.context_line) delete f.context_line;
    }
  }

  // İstek verisi (gövde/başlık/çerez/query) → PII riski, tümden sil.
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    delete event.request.headers;
    delete event.request.query_string;
  }

  // Ekran görüntüsü / attachment içeriği yasak.
  if (event.contexts && event.contexts.screenshot) delete event.contexts.screenshot;

  return event;
}

/**
 * Derinlemesine gez: tüm string'leri maskele; hassas-anahtarlı değerleri tümden
 * maskele; döngüsel referansları güvenle atla. Diziler/nesneler yerinde işlenir.
 */
function deepScrub(value, seen) {
  if (value == null) return value;
  if (typeof value === 'string') return scrubString(value);
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return value;
  seen.add(value);

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = deepScrub(value[i], seen);
    return value;
  }
  for (const key of Object.keys(value)) {
    if (isSensitiveKey(key)) {
      value[key] = MASK;
    } else {
      value[key] = deepScrub(value[key], seen);
    }
  }
  return value;
}

/**
 * Sentry `beforeSend` girişi. Olayı YERİNDE temizler ve döner. `null` dönmek
 * olayı DÜŞÜRÜR (opt-out kapısı ayrıca yapar; burası içerik güvenliği).
 * @param {object|null} event
 * @returns {object|null}
 */
function scrubEvent(event) {
  if (!event || typeof event !== 'object') return event;
  stripHighRiskFields(event);
  deepScrub(event, new WeakSet());
  return event;
}

// ─── OBS-02 — YIĞIN İZİ YOLLARI: MASKELE **AMA** OKUNABİLİR BIRAK ─────────────
//
// `scrubString` bir ev-yolunu TÜMDEN `~/[redacted]` yapar. Mesaj metni için doğru,
// ama STACK FRAME'in `filename` alanına uygulanınca hata takibini işe yaramaz
// kılıyordu (ADP-715 kanıt çıktısı: `top frame: run @ ~/[redacted]` — hangi dosya
// patladı, bilinmiyor). Hata takibinin BÜTÜN amacı "hangi dosya:satır" olduğuna
// göre bu, gizliliği koruyup görünürlüğü öldüren bir takas.
//
// Çözüm — YOLU UYGULAMA KÖKÜNE ÇAPALA:
//   • Yol uygulama kökünün İÇİNDEyse → köke göreli yaz (`electron/main.js`).
//     Kullanıcı adı, ev dizini, çalışma alanı adı GİTMEZ; bizim kendi kodumuzun
//     göreli yolu gider — bu bir sır değil, ürünün kendisi.
//   • Ev dizininin içinde ama uygulamanın DIŞINDAysa → `~/[redacted]`. Orası
//     kullanıcının kendi dosyaları (müşteri adı taşıyan klasörler dahil) — bizim
//     hata ayıklamamıza katkısı yok, gizlilik riski yüksek. Tam maske.
//   • Hiçbiri değilse (`/usr/lib/...`, `node:internal/...`) → aynen kalır, ama
//     yine de `scrubString`'den geçer.
//
// Windows: yol ayracı ve büyük/küçük harf duyarsızlığı hesaba katılır.
const WIN_SEP_RE = /\\/g;

function normalizeForCompare(p) {
  return String(p || '').replace(WIN_SEP_RE, '/');
}

/**
 * Bir dosya yolunu gizlilik-güvenli ama HATA AYIKLANABİLİR hâle getir.
 * @param {string} filePath
 * @param {object} [opts]
 * @param {string} [opts.appRoot]  uygulama kökü (bu kökün altı göreli yazılır)
 * @param {string} [opts.homeDir]  kullanıcı ana dizini (altı tümden maskelenir)
 * @returns {string}
 */
// ─── SEN-F2 — RENDERER VARLIK YOLU: PORTU AT, ADI SABİTLE ────────────────────
//
// Uygulama Next standalone sunucusunu HER AÇILIŞTA SERBEST BİR PORTTA açar. Yığın
// izindeki yol bu yüzden `http://127.0.0.1:53127/_next/static/chunks/x.js` gibi
// OLUR ve port her koşuda değişir. İki sonucu vardı:
//   1. Sentry'de aynı dosya farklı adreslerle görünüyordu (okunaksız culprit).
//   2. Kaynak haritası eşleşmesi PORTA bağlı bir şansa kalıyordu.
// Çözüm, Electron/React-Native SDK'larının yerleşik sözleşmesi: yerel sunucu kökü
// `app:///` ile değiştirilir. Sentry `app:///_next/...` yolunu `~/_next/...`
// artefaktıyla eşler — ve biz artefaktları TAM O ADLA yüklüyoruz
// (`scripts/sentryReleaseUpload.cjs` · RENDERER_ASSET_PREFIX). Tek sözleşme, iki uç.
//
// YALNIZ loopback host'ları dönüştürülür: gerçek bir dış URL (ör. bir CDN) yığın
// izinde göründüğünde onu `app:///` diye etiketlemek YALAN olurdu.
const LOCAL_ASSET_URL_RE = /^https?:\/\/(?:127\.0\.0\.1|\[::1\]|localhost)(?::\d+)?(?=\/)/i;

/**
 * Yerel sunucudan servis edilen bir renderer varlığının URL'ini sabit köke çevir.
 * Eşleşmiyorsa girdi AYNEN döner (dosya yolları, dış URL'ler etkilenmez).
 * @param {string} p
 * @returns {string}
 */
function normalizeAssetUrl(p) {
  if (typeof p !== 'string' || !p) return p;
  return p.replace(LOCAL_ASSET_URL_RE, 'app://');
}

function scrubPath(filePath, opts = {}) {
  if (typeof filePath !== 'string' || !filePath) return filePath;

  // SEN-F2 — yerel sunucu kökü ÖNCE sabitlenir; kalan mantık dosya yollarına aittir.
  const asset = normalizeAssetUrl(filePath);
  if (asset.startsWith('app:///')) return asset;

  // `file:///...` ve `at (/path:1:2)` gibi sarmalayıcıları soy.
  let p = asset;
  const fileUrl = p.startsWith('file://');
  if (fileUrl) {
    try { p = decodeURIComponent(p.replace(/^file:\/\//, '')); } catch { p = p.replace(/^file:\/\//, ''); }
  }

  const cmp = normalizeForCompare(p);
  const appRoot = opts.appRoot ? normalizeForCompare(opts.appRoot).replace(/\/+$/, '') : '';
  const homeDir = opts.homeDir ? normalizeForCompare(opts.homeDir).replace(/\/+$/, '') : '';

  // Karşılaştırma büyük/küçük harf duyarsız (macOS/Windows dosya sistemleri öyle).
  const lc = cmp.toLowerCase();

  if (appRoot && lc.startsWith(appRoot.toLowerCase() + '/')) {
    return cmp.slice(appRoot.length + 1); // `electron/main.js`
  }
  if (appRoot && lc === appRoot.toLowerCase()) return '.';

  if (homeDir && lc.startsWith(homeDir.toLowerCase() + '/')) {
    return `${PATH_MASK}/${MASK}`; // uygulama dışı kullanıcı dosyası → tam maske
  }

  // Ev dizini bilinmiyorsa bile jenerik ev-yolu deseni yakalanır.
  return scrubString(cmp);
}

module.exports = {
  scrubString,
  scrubPath,
  normalizeAssetUrl,
  scrubEvent,
  isSensitiveKey,
  stripHighRiskFields,
  MASK,
  // test görünürlüğü
  _patterns: { SECRET_PATTERNS, ASSIGNMENT_RE, UNIX_HOME_RE, EMAIL_RE },
};
