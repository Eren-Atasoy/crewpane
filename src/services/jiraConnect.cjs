// JIRA-CONNECT-01 (Adım 1) — Jira Cloud: site adresi + e-posta + kişisel API anahtarı.
//
// Neden ayrı bir doğrulama yolu var: katalogdaki diğer servislerde "Bağlantıyı dene"
// MCP sunucusunu ayağa kaldırıp araç listesini ister. Jira sunucusu bunu SAHTE
// anahtarla da başarır (ölçüldü 05.10: @aashari/mcp-server-atlassian-jira@3.3.0,
// sahte jeton → ok:true, 5 araç, 5,6 sn). Yani araç listesi "hesap ve site doğru"
// demez. Jira'da doğru soru Atlassian'ın kendisine sorulur: `GET /rest/api/3/myself`.
//
// Atlassian'ın gerçek cevapları (05.10, sahte kimlikle ölçüldü):
//   • var olan site + yanlış e-posta/anahtar → 401, `x-seraph-loginreason: AUTHENTICATED_FAILED`
//   • olmayan site                          → 404, `{"errorMessage":"Site temporarily unavailable"}`
//   • çok sayıda başarısız deneme           → 403 + `x-seraph-loginreason` içinde CAPTCHA
//
// 🔴 Anahtar bu modülden ÇIKMAZ: dönüşte, hata metninde ve logda yok. Cevap gövdesinden
// yalnız `displayName` alınır (kullanıcıya "şu hesapla bağlandı" demek için); gövdenin
// geri kalanı okunmaz, taşınmaz.
//
// Saf + DI (`fetch` enjekte) → `node --test` ile koşar, Electron bağı yok.

'use strict';

/** Atlassian Cloud site etiketi: `sirketim` (→ sirketim.atlassian.net). */
const SITE_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_TIMEOUT_MS = 10000;
const NAME_MAX = 80;

/**
 * Kullanıcının yazdığı site adresini MCP sunucusunun beklediği ETİKETE indirir.
 * Kabul: `sirketim`, `sirketim.atlassian.net`, `https://sirketim.atlassian.net/jira/…`.
 * Ret (null): başka alan adı (Data Center / özel alan adı — bu sunucu yalnız
 * `<etiket>.atlassian.net` konuşur), boş, geçersiz karakter.
 * @param {unknown} raw
 * @returns {string|null}
 */
function normalizeSite(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // şema
  s = s.split(/[/?#]/)[0]; // yol / sorgu
  if (s.includes('@')) return null; // kullanıcı:parola@host biçimi — site değil
  s = s.replace(/:\d+$/, ''); // port
  s = s.replace(/\.$/, '');
  if (s.endsWith('.atlassian.net')) s = s.slice(0, -'.atlassian.net'.length);
  if (s.includes('.')) return null;
  return SITE_LABEL_RE.test(s) ? s : null;
}

/** @param {unknown} raw */
function isEmail(raw) {
  return typeof raw === 'string' && raw.length <= 254 && EMAIL_RE.test(raw.trim());
}

/** Etiket → API kökü. Test/dev ikizi `baseUrlFor` ile değiştirilir. */
function siteBaseUrl(site) {
  return `https://${site}.atlassian.net`;
}

/** Ekranda gösterilecek ad: kontrol karakteri yok, tavanlı. */
function cleanName(v) {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, NAME_MAX);
  return s || null;
}

/**
 * Atlassian'a "bu e-posta + anahtar bu sitede kim?" diye sorar.
 *
 * → { ok:true, status:200, account, site, durationMs }
 * | { ok:false, status, cause, site, durationMs }
 *   cause: 'site' (site yok / yönlendirme) · 'auth' (e-posta ya da anahtar yanlış) ·
 *          'captcha' (çok fazla başarısız deneme) · 'forbidden' · 'rate-limit' ·
 *          'server' · 'timeout' · 'network' · 'invalid-input'
 *
 * @param {{site:string,email:string,token:string}} input - site NORMALİZE edilmiş etiket
 * @param {{fetch?:Function, baseUrlFor?:(site:string)=>string, timeoutMs?:number, now?:()=>number}} [deps]
 */
async function verifyJiraAccount(input, deps = {}) {
  const fetchFn = deps.fetch || globalThis.fetch;
  const baseUrlFor = typeof deps.baseUrlFor === 'function' ? deps.baseUrlFor : siteBaseUrl;
  const now = deps.now || Date.now;
  const timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : DEFAULT_TIMEOUT_MS;
  const site = normalizeSite(input && input.site);
  const email = input && typeof input.email === 'string' ? input.email.trim() : '';
  const token = input && typeof input.token === 'string' ? input.token.trim() : '';
  const started = now();
  const done = (r) => ({ site, ...r, durationMs: now() - started });
  if (!site || !isEmail(email) || !token) return done({ ok: false, status: null, cause: 'invalid-input' });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetchFn(`${baseUrlFor(site)}/rest/api/3/myself`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(`${email}:${token}`, 'utf8').toString('base64')}`,
      },
      // Yönlendirme İZLENMEZ: Basic başlığı başka bir adrese taşınmasın. Atlassian
      // bu uçta yönlendirme yapmıyor; gelirse "site doğru değil" demektir.
      redirect: 'manual',
      signal: ctrl.signal,
    });
  } catch (err) {
    const aborted = ctrl.signal.aborted || (err && err.name === 'AbortError');
    return done({ ok: false, status: null, cause: aborted ? 'timeout' : 'network' });
  } finally {
    clearTimeout(timer);
  }

  const status = res.status;
  if (status === 200) {
    let account = null;
    try {
      const body = await res.json();
      account = cleanName(body && body.displayName);
    } catch { /* ad okunamadı — bağlantı yine doğrulandı */ }
    return done({ ok: true, status, account });
  }
  const reason = String((res.headers && typeof res.headers.get === 'function' && res.headers.get('x-seraph-loginreason')) || '');
  let cause = 'server';
  if (status === 401) cause = 'auth';
  else if (status === 403) cause = /CAPTCHA/i.test(reason) ? 'captcha' : 'forbidden';
  else if (status === 404 || (status >= 300 && status < 400) || status === 0) cause = 'site';
  else if (status === 429) cause = 'rate-limit';
  return done({ ok: false, status, cause });
}

module.exports = {
  normalizeSite,
  isEmail,
  siteBaseUrl,
  verifyJiraAccount,
  DEFAULT_TIMEOUT_MS,
};
