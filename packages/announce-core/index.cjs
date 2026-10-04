// ADP-716 — UYGULAMA-İÇİ DUYURU sözleşmesinin TEK kaynağı (JS tarafı).
//
// ADP-675 bu mantığı CrewPane'in içine (`crewpane/electron/announcements.cjs`)
// yazmıştı. ADP-716 onu ÜÇ ürüne açtı; mantık ürün başına KOPYALANMADI, buraya
// taşındı:
//
//   CrewPane (Electron) ─┐
//   AgentShot   (Electron) ─┼→ packages/announce-core        (BU DOSYA)
//   AgentVoice  (Python)   ─→ packages/announce-core-py      (ikiz)
//
// İki dil = iki uygulama, ama TEK SÖZLEŞME. Sözleşme bir belge değil, ÇALIŞAN bir
// dosyadır: `conformance/cases.json`. Her iki uygulama da o vakaları koşar; biri
// diğerinden sapınca test KIRILIR (bkz. index.test.cjs · announce-core-py/tests).
//
// ── ŞEMA v2 (v1 ile GERİYE UYUMLU) ──────────────────────────────────────────────
// v1'e (ADP-675) eklenenler YALNIZ YENİ, İSTEĞE BAĞLI alanlardır:
//   • `i18n: { en: { title, body, actionLabel } }` — çok dillilik. `title`/`body`
//     TABAN dilde (TR) DÜZ STRING kalır. Bu KASITLI: eski istemci `i18n`'i hiç
//     bilmez, taban stringi gösterir → KIRILMAZ. (Başlığı `{tr,en}` nesnesine
//     çevirmek eski istemcide `cleanText(nesne)` → null → duyurunun tamamen
//     DÜŞMESİ demekti; o yüzden yapılmadı.)
//   • Bilinmeyen HER alan sessizce yok sayılır (ileri uyumluluk); bilinmeyen bir
//     alan duyuruyu DÜŞÜRMEZ.
// Şema belgesi: SCHEMA.md
//
// ── GÜVENLİK SÖZLEŞMESİ (ADP-675'ten devralındı, aynen korunur) ─────────────────
// Feed SUNUCUDAN gelen içeriktir → düşman girdi muamelesi görür:
//   • Her alan tip+uzunluk sınırlı; şekli bozuk öğe SESSİZCE DÜŞER (feed'in tamamı
//     çöpse duyuru yok — çökme yok).
//   • Kontrol karakterleri temizlenir (terminal/ekran kaçış dizisi enjeksiyonu yok).
//   • Aksiyon URL'i YALNIZ https (javascript:/file:/data: reddedilir) — ve adresi
//     renderer değil MAIN açar, main tekrar doğrular.
//   • Gövde METİNDİR: hiçbir istemci ham HTML render etmez (Electron tarafında
//     react-markdown skipHtml + beyaz liste, AgentShot'ta textContent, AgentVoice'ta
//     Qt PlainText). HTML/script enjeksiyonu bu yüzden bir yüzeye ulaşamaz.
// Sessizlik sözleşmesi: ağ/JSON hatası ASLA throw etmez.

'use strict';

/** Feed şemasının sürümü (envelope `version` alanı). İstemci bunu YOK SAYAR — ileri
 *  uyumluluk kuralı: sürüm numarasına göre dallanan istemci, gelecekteki bir artıştan
 *  KIRILIR. Alan yalnız insan/araç okunabilirliği için taşınır. */
const SCHEMA_VERSION = 2;

/** Yayın feed'i (statik JSON, public repo — güncelleme feed'iyle aynı repo). */
const FEED_URL =
  'https://raw.githubusercontent.com/crewpane-dev/crewpane-releases/main/announcements.json';
/** Periyodik tazeleme. Güncelleme kontrolünden (6sa) sık: duyuru "şu an sorun var" diyebilir. */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

/** Feed'de tanınan uygulama kimlikleri (`target.apps`). */
const APPS = ['crewpane', 'agentshot', 'agentvoice'];

// Kaynak tavanları — bozuk/düşman bir feed belleği şişiremesin, UI'ı kilitleyemesin.
const MAX_ITEMS = 50;
const MAX_TITLE_CHARS = 140;
const MAX_BODY_CHARS = 4000;
const MAX_ACTION_LABEL_CHARS = 40;
const MAX_ID_CHARS = 80;

/** Sunum sınıfı: critical → şerit/kart + merkez · warning/info → yalnız merkez (+ rozet). */
const LEVELS = ['critical', 'warning', 'info'];
const LEVEL_RANK = { critical: 0, warning: 1, info: 2 };

/** Taban dil: `title`/`body` alanları bu dildedir; `i18n` yalnız ÜSTÜNE yazar. */
const BASE_LOCALE = 'tr';
/** `i18n` altında tanınan diller. Bilinmeyen dil sessizce atılır. */
const LOCALES = ['tr', 'en'];

// C0/C1 kontrol karakterleri (\t \n \r HARIC). Sinif KOD NOKTALARINDAN kurulur —
// boylece bu kaynak dosyanin kendisi ham kontrol karakteri TASIMAZ.
const CTRL_RANGES = [[0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x9f]];
const CONTROL_RE = new RegExp(
  '[' + CTRL_RANGES.map(([x, y]) => String.fromCharCode(x) + '-' + String.fromCharCode(y)).join('') + ']',
  'g',
);

/** Kontrol karakterlerini at, kirp, uzunlugu sinirla. Her metin alani buradan gecer. */
function cleanText(raw, max) {
  if (typeof raw !== 'string') return null;
  const stripped = raw.replace(CONTROL_RE, '').trim();
  if (!stripped) return null;
  return stripped.length > max ? stripped.slice(0, max) : stripped;
}

/** id: kararlı okundu-anahtarı → yalnız [a-z0-9._-], küçük harfe indirilir. */
function cleanId(raw) {
  const t = cleanText(raw, MAX_ID_CHARS);
  if (!t) return null;
  const id = t.toLowerCase().replace(/[^a-z0-9._-]/g, '');
  return id || null;
}

/**
 * ISO tarih → epoch ms; geçersiz/eksik → null (filtre "sınır yok" sayar).
 *
 * ⚠️ SAYI da kabul edilir ve bu KRİTİKTİR: normalize edilmiş duyuru çevrimdışı
 * kopyaya (announcements-cache.json) epoch SAYISI olarak yazılır, açılışta o dosya
 * normalize'dan TEKRAR geçer. Yalnız string kabul edilseydi tarihler ikinci turda
 * null'a düşerdi → SÜRESİ GEÇMİŞ duyuru çevrimdışı kullanıcıya GERİ GELİRDİ
 * (ADP-716'da testle yakalandı). normalize artık idempotenttir.
 */
function parseAt(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

/**
 * Aksiyon düğmesinin adresi. YALNIZ https — `javascript:`, `data:`, `file:` ve
 * şemasız değerler REDDEDİLİR (feed ele geçse bile kod çalıştıramaz).
 */
function isSafeActionUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 500) return false;
  try {
    return new URL(raw.trim()).protocol === 'https:';
  } catch {
    return false;
  }
}

/** 'v1.2.3' → [1,2,3]; ayrıştırılamayan → null. (updateCheck.parseSemver ile AYNI
 *  kural; crewpane'te ikisinin sapmadığı testle kilitli.) */
function parseSemver(v) {
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** semver karşılaştırma: a<b → -1, a>b → 1, eşit → 0; ayrıştırılamayan → null. */
function cmpVersion(a, b) {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) {
    if (x[i] > y[i]) return 1;
    if (x[i] < y[i]) return -1;
  }
  return 0;
}

/** Küçük harfli, tekilleştirilmiş string listesi; boş/geçersiz → null ("hepsi"). */
function cleanList(raw, max = 12) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const v of raw) {
    const t = cleanText(v, 40);
    if (t) out.push(t.toLowerCase());
    if (out.length >= max) break;
  }
  return out.length ? Array.from(new Set(out)) : null;
}

/** Hedef filtresi — null alan = "sınır yok". */
function normalizeTarget(raw) {
  const t = raw && typeof raw === 'object' ? raw : {};
  const minVersion = parseSemver(t.minVersion) ? String(t.minVersion).trim() : null;
  const maxVersion = parseSemver(t.maxVersion) ? String(t.maxVersion).trim() : null;
  return {
    apps: cleanList(t.apps),
    channels: cleanList(t.channels, 4),
    plans: cleanList(t.plans), // Faz 2 — plan-bazlı hedefleme (istemci bugün plan bilmiyorsa yok sayar)
    minVersion,
    maxVersion,
  };
}

/**
 * `i18n` bloğu → { <dil>: { title?, body?, actionLabel? } }.
 * Boş/bozuk alt-blok DÜŞER; blok tamamen boşsa null (duyuru taban dilde yaşar).
 * ⚠ Bu alan duyuruyu ASLA düşürmez — çeviri eksikliği duyuruyu susturmamalı.
 */
function normalizeI18n(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const loc of LOCALES) {
    const blk = raw[loc];
    if (!blk || typeof blk !== 'object' || Array.isArray(blk)) continue;
    const title = cleanText(blk.title, MAX_TITLE_CHARS);
    const body = cleanText(blk.body, MAX_BODY_CHARS);
    const actionLabel = cleanText(blk.actionLabel, MAX_ACTION_LABEL_CHARS);
    if (!title && !body && !actionLabel) continue;
    const entry = {};
    if (title) entry.title = title;
    if (body) entry.body = body;
    if (actionLabel) entry.actionLabel = actionLabel;
    out[loc] = entry;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Feed'in tek öğesi → normalize edilmiş duyuru; şekli bozuksa null (öğe düşer,
 * feed'in geri kalanı yaşar). Bilinmeyen alanlar sessizce yok sayılır.
 */
function normalizeAnnouncement(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = cleanId(raw.id);
  const title = cleanText(raw.title, MAX_TITLE_CHARS);
  if (!id || !title) return null; // id + başlık ZORUNLU (id olmadan okundu tutulamaz)
  const level = LEVELS.includes(raw.level) ? raw.level : 'info';
  const action =
    raw.action && typeof raw.action === 'object' && isSafeActionUrl(raw.action.url)
      ? {
          label: cleanText(raw.action.label, MAX_ACTION_LABEL_CHARS) || 'Aç',
          url: String(raw.action.url).trim(),
        }
      : null;
  return {
    id,
    level,
    title,
    body: cleanText(raw.body, MAX_BODY_CHARS) || '',
    i18n: normalizeI18n(raw.i18n),
    publishedAt: parseAt(raw.publishedAt),
    startsAt: parseAt(raw.startsAt),
    expiresAt: parseAt(raw.expiresAt),
    target: normalizeTarget(raw.target),
    action,
    // Varsayılan kapatılabilir. `dismissible:false` YALNIZ şeridin ✕'ini kaldırır —
    // "okudum" her zaman mümkündür (kullanıcıyı kilitleyen duyuru YOK).
    dismissible: raw.dismissible !== false,
  };
}

/**
 * Ham feed cevabı (dizi veya {announcements:[…]}) → normalize edilmiş, tekilleştirilmiş,
 * tavanlı liste. Her hata yolu boş dizi döner.
 */
function normalizeFeed(raw) {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray(raw.announcements)
      ? raw.announcements
      : null;
  if (!list) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const a = normalizeAnnouncement(item);
    if (!a || seen.has(a.id)) continue;
    seen.add(a.id);
    out.push(a);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

/**
 * Bu duyuru BU istemciye mi? ctx = { app, version, channel, now }.
 * minVersion/maxVersion DAHİL sınırdır: maxVersion='0.2.17' → 0.2.17 ve öncesi görür,
 * 0.2.18 GÖRMEZ ("eski sürümde kalana güncelle de" — ADP-674 kardeşi).
 */
function matchesTarget(a, ctx) {
  const c = ctx || {};
  const now = Number.isFinite(c.now) ? c.now : Date.now();
  if (a.startsAt != null && now < a.startsAt) return false;
  if (a.expiresAt != null && now >= a.expiresAt) return false;
  const t = a.target;
  const app = String(c.app || '').toLowerCase();
  if (t.apps && !t.apps.includes(app)) return false;
  if (t.channels) {
    const ch = String(c.channel || 'stable').toLowerCase();
    if (!t.channels.includes(ch)) return false;
  }
  if (t.minVersion) {
    const r = cmpVersion(c.version, t.minVersion);
    if (r === null || r < 0) return false; // sürüm okunamıyorsa hedefli duyuru GÖSTERİLMEZ
  }
  if (t.maxVersion) {
    const r = cmpVersion(c.version, t.maxVersion);
    if (r === null || r > 0) return false;
  }
  return true;
}

/**
 * Hedefe uyanları seç ve sırala: önce kritiklik, sonra yeni→eski yayın tarihi.
 * (Tarihsizler en sona — feed'de eksik alan sıralamayı bozmasın.)
 */
function selectAnnouncements(items, ctx) {
  return items
    .filter((a) => matchesTarget(a, ctx))
    .sort((x, y) => {
      const r = LEVEL_RANK[x.level] - LEVEL_RANK[y.level];
      if (r !== 0) return r;
      return (y.publishedAt ?? 0) - (x.publishedAt ?? 0);
    });
}

/** 'en-US' / 'EN' → 'en'; tanınmayan → BASE_LOCALE. */
function normalizeLocale(raw) {
  const t = typeof raw === 'string' ? raw.trim().toLowerCase().split(/[-_]/)[0] : '';
  return LOCALES.includes(t) ? t : BASE_LOCALE;
}

/**
 * Duyuruyu tek dile indirger: `i18n[locale]` alanı VARSA onu, yoksa taban (TR)
 * alanını kullanır. `i18n` alanı DÜŞER (UI'a tek düz metin gider).
 * Alan bazlı geri düşme: yalnız `title` çevrilmişse gövde taban dilde kalır —
 * yarım çeviri duyuruyu boşaltmaz.
 */
function localize(a, locale) {
  const loc = normalizeLocale(locale);
  const tr = (a.i18n && a.i18n[loc]) || null;
  const out = {
    ...a,
    title: (tr && tr.title) || a.title,
    body: (tr && tr.body) || a.body,
    locale: loc,
  };
  if (a.action) {
    out.action = { label: (tr && tr.actionLabel) || a.action.label, url: a.action.url };
  }
  delete out.i18n;
  return out;
}

/** Okunmamışlar (read = { [id]: epoch } veya Set/dizi). */
function unreadOf(items, read) {
  const has =
    read instanceof Set
      ? (id) => read.has(id)
      : Array.isArray(read)
        ? (id) => read.includes(id)
        : (id) => !!(read && Object.prototype.hasOwnProperty.call(read, id));
  return items.filter((a) => !has(a.id));
}

/**
 * Feed'i çek. → { ok:true, items } | { ok:false, reason }. ASLA throw etmez.
 * `url`/`fetchImpl` test dikişleri (e2e yerel mock sunucu, unit sahte fetch).
 */
async function fetchFeed({ url = FEED_URL, fetchImpl = fetch, timeoutMs = FETCH_TIMEOUT_MS, userAgent = 'CrewPane-announcements' } = {}) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, {
        signal: ctrl.signal,
        headers: { Accept: 'application/json', 'User-Agent': userAgent },
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res || !res.ok) return { ok: false, reason: `http-${res ? res.status : 'null'}` };
    const payload = await res.json();
    return { ok: true, items: normalizeFeed(payload) };
  } catch (err) {
    return { ok: false, reason: err && err.name === 'AbortError' ? 'timeout' : 'network' };
  }
}

module.exports = {
  SCHEMA_VERSION,
  FEED_URL,
  CHECK_INTERVAL_MS,
  FETCH_TIMEOUT_MS,
  APPS,
  LEVELS,
  LOCALES,
  BASE_LOCALE,
  MAX_ITEMS,
  MAX_TITLE_CHARS,
  MAX_BODY_CHARS,
  MAX_ACTION_LABEL_CHARS,
  MAX_ID_CHARS,
  cleanText,
  cleanId,
  isSafeActionUrl,
  parseSemver,
  cmpVersion,
  normalizeLocale,
  normalizeI18n,
  normalizeAnnouncement,
  normalizeFeed,
  matchesTarget,
  selectAnnouncements,
  localize,
  unreadOf,
  fetchFeed,
};
