// A-10 — uygulama içi "Yenilikler" panelinin BESLEME mantığı.
//
// crewpane.dev'un tek changelog kaynağını (`/changelog.json`, GitHub Releases →
// crewpane-com/src/lib/changelog.ts) MAIN process çeker; panel kendi kopyasını
// TUTMAZ. Kalıp announcements.cjs (ADP-675) ile AYNI iskelet (main çeker → cache
// eder → renderer'a servis eder, ağ hatası sessiz), ama içerik daha basit: hedefli
// dağıtım/i18n bloğu yok, tek düz liste.
//
// Feed SUNUCUDAN gelen içeriktir → düşman girdi muamelesi görür (announce-core ile
// aynı disiplin): her alan tip+uzunluk sınırlı, şekli bozuk öğe sessizce düşer,
// `url` yalnız https kabul edilir.

'use strict';

/** Yayın feed'i — crewpane-com/src/app/changelog.json/route.ts. */
const FEED_URL = 'https://crewpane.dev/changelog.json';
/** Periyodik tazeleme. Güncelleme kontrolünden (6sa) seyrek: sosyal-kanıt rozeti,
 *  kritik bilgi değil. Site tarafı zaten saatlik ISR (revalidate=3600) kullanıyor. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

// Kaynak tavanları — bozuk/düşman bir feed belleği şişiremesin, paneli kilitleyemesin.
const MAX_ITEMS = 100;
const MAX_TEXT_CHARS = 2000;
const MAX_VERSION_CHARS = 40;
const MAX_PRODUCT_CHARS = 40;

const CATEGORIES = ['new', 'improvement', 'fix'];

// C0/C1 kontrol karakterleri (\t \n \r HARİÇ) — announce-core ile aynı sınıf.
const CTRL_RANGES = [[0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x9f]];
const CONTROL_RE = new RegExp(
  '[' + CTRL_RANGES.map(([x, y]) => String.fromCharCode(x) + '-' + String.fromCharCode(y)).join('') + ']',
  'g',
);

function cleanText(raw, max) {
  if (typeof raw !== 'string') return null;
  const stripped = raw.replace(CONTROL_RE, '').trim();
  if (!stripped) return null;
  return stripped.length > max ? stripped.slice(0, max) : stripped;
}

/** ISO tarih → epoch ms; geçersiz/eksik → null (tarihsiz kayıt en sona düşer). */
function parseAt(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

/** Yalnız https kabul edilir — `javascript:`/`data:`/`file:` ve şemasız değerler reddedilir. */
function isSafeUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 500) return false;
  try {
    return new URL(raw.trim()).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Feed'in tek öğesi → normalize edilmiş kayıt; `tr` metni yoksa (zorunlu alan)
 * öğe düşer (feed'in geri kalanı yaşar). Bilinmeyen alanlar sessizce yok sayılır.
 */
function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const tr = cleanText(raw.tr, MAX_TEXT_CHARS);
  if (!tr) return null;
  const en = cleanText(raw.en, MAX_TEXT_CHARS);
  const category = CATEGORIES.includes(raw.category) ? raw.category : null;
  const version = cleanText(raw.version, MAX_VERSION_CHARS);
  const product = cleanText(raw.product, MAX_PRODUCT_CHARS);
  const url = isSafeUrl(raw.url) ? String(raw.url).trim() : null;
  return {
    date: parseAt(raw.date),
    category,
    version,
    product,
    url,
    tr,
    en,
  };
}

/**
 * Ham feed cevabı ({entries:[…], recentCount, recentWindowDays, …} veya doğrudan
 * dizi) → normalize edilmiş, tavanlı liste + tempo alanları. Her hata yolu boş
 * liste döner (feed çökmez).
 */
function normalizeFeed(raw) {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray(raw.entries)
      ? raw.entries
      : null;
  const items = [];
  if (list) {
    for (const item of list) {
      const e = normalizeEntry(item);
      if (!e) continue;
      items.push(e);
      if (items.length >= MAX_ITEMS) break;
    }
    // En yeni önce (feed zaten bu sırada gelir, ama bozuk bir sıralamaya güvenme).
    items.sort((a, b) => (b.date ?? 0) - (a.date ?? 0));
  }
  const recentCount =
    raw && typeof raw === 'object' && Number.isFinite(raw.recentCount) ? raw.recentCount : null;
  const recentWindowDays =
    raw && typeof raw === 'object' && Number.isFinite(raw.recentWindowDays) ? raw.recentWindowDays : null;
  return { items, recentCount, recentWindowDays };
}

/**
 * Feed'i çek. → { ok:true, items, recentCount, recentWindowDays } | { ok:false, reason }.
 * ASLA throw etmez. `url`/`fetchImpl` test dikişleri (e2e yerel mock, unit sahte fetch).
 */
async function fetchFeed({ url = FEED_URL, fetchImpl = fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, {
        signal: ctrl.signal,
        headers: { Accept: 'application/json', 'User-Agent': 'CrewPane-changelog' },
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res || !res.ok) return { ok: false, reason: `http-${res ? res.status : 'null'}` };
    const payload = await res.json();
    const { items, recentCount, recentWindowDays } = normalizeFeed(payload);
    return { ok: true, items, recentCount, recentWindowDays };
  } catch (err) {
    return { ok: false, reason: err && err.name === 'AbortError' ? 'timeout' : 'network' };
  }
}

module.exports = {
  FEED_URL,
  CHECK_INTERVAL_MS,
  FETCH_TIMEOUT_MS,
  MAX_ITEMS,
  CATEGORIES,
  cleanText,
  isSafeUrl,
  normalizeEntry,
  normalizeFeed,
  fetchFeed,
};
