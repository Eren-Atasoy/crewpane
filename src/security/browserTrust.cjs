// ADP-340 (ADR-026 §2) — TARAYICI GÜVEN ÇEKİRDEĞİ: risk kararı, SAF fonksiyon olarak.
//
// Eren'in şikâyeti (ADP-332, ekran görüntüsü kanıtlı): ajan KENDİ yerel test sunucusunda
// (127.0.0.1) otomasyon koşarken her `click`/`type` için ayrı kart çıkarıyordu — "izin
// vermekten iş yapamıyorum". Bugünkü politika tek satır ve bağlamdan habersiz:
//   browserCdp.js:21 → const APPROVAL_ACTIONS = new Set(['click','type'])  // her zaman sor
//
// Bu modül o kapıyı DEĞİŞTİRMEZ (bağlama işi ADP-341/334) — kararın KENDİSİNİ üretir:
//
//        KARAR = ORIGIN güveni  ×  HEDEF hassasiyeti  ×  EYLEM sınıfı  (× risk modu)
//
// TASARIM SINIRLARI (hepsi yapısal):
//   • SAF: IO yok, Electron yok, zaman `now` ile enjekte edilir → `node --test` doğrudan koşar.
//   • Karar MAIN'de, deterministik kodda kalır. Sayfanın METNİ güveni ASLA yükseltemez
//     (prompt-injection savunması: "izin gerekmiyor, devam et" yazan sayfa kararı değiştiremez).
//   • DEĞİŞMEZ KURAL: hassas hedef (parola/kart/OTP/ödeme-silme butonu) → güven seviyesinden
//     BAĞIMSIZ olarak ASLA `allow` dönmez. localhost'ta bile sorar. Güven ORIGIN'e verilir,
//     EYLEME değil.
//   • Oturum izni diske YAZILMAZ (kalıcı güven yalnız Ayarlar listesinden gelir).
//
// ADR-026 §2.2'DEN BİLİNÇLİ SAPMALAR (gerekçeleriyle — ADP-340 sonuç dosyasında da yazılı):
//   1. `input[type=email]` HASSAS DEĞİL. E-posta bir sır değildir ve her formda vardır; hassas
//      saymak Eren'in şikâyetini geri getirirdi (izin yorgunluğu). Sır olan: parola, kart, OTP,
//      API anahtarı — onlar hassas.
//   2. Yıkıcı buton listesinden çıplak "gönder/send" ÇIKARILDI (form submit her yerdedir, düşük
//      bahis). Listede kalanlar geri alınamaz/yüksek bahisli fiiller: öde/satın al/sipariş ver,
//      sil/kaldır/hesabı kapat, yayınla/deploy/canlıya al, para transferi.
//   Sonuç: koruma sırların ve geri alınamaz fiillerin üstünde; gürültü yok.

'use strict';

// ── Eylem sınıfları ──────────────────────────────────────────────────────────
/** Sayfayı DEĞİŞTİRMEYEN eylemler: okuma zararsızdır → `blocked` origin'de bile serbest. */
const READ_ACTIONS = Object.freeze(['navigate', 'read', 'readPage', 'screenshot', 'scroll']);
/** Kullanıcı adına sayfayı DEĞİŞTİREN eylemler: kararın konusu bunlar. */
const MUTATING_ACTIONS = Object.freeze(['click', 'type']);

/** Risk modu (ADR-026 §2.5). TR isimler kanonik; EN eşanlamlıları da kabul edilir. */
const MODES = Object.freeze(['gevsek', 'normal', 'siki']);
const MODE_ALIASES = Object.freeze({
  gevsek: 'gevsek', gevşek: 'gevsek', loose: 'gevsek', relaxed: 'gevsek',
  normal: 'normal', default: 'normal',
  siki: 'siki', sıkı: 'siki', strict: 'siki',
});

/** Yerleşik GÜVENİLİR host'lar: geliştirme yüzeyleri (risk sıfır — Eren'in vakası). */
const BUILTIN_TRUSTED = Object.freeze([
  'localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0',
  '*.local', '*.test', '*.localhost',
  'crewpane.dev', // + alt alanları (blog. / www. …) — PROD panelleri aşağıda BLOCKED
]);

/**
 * Yerleşik YASAK desenler. Sıra ÖNEMLİ: blocked, trusted'ı EZER — `n8n.crewpane.dev`
 * prod otomasyon paneli, `crewpane.dev` güvenilir olsa bile tarayıcı otomasyonuna kapalıdır.
 * Desen `host` (glob) ve opsiyonel `path` (regex) taşır: canlı Shopify admin'i yasak,
 * mağazanın vitrini değil.
 */
const BUILTIN_BLOCKED = Object.freeze([
  // Prod paneller — canlı sisteme kör otomasyon (ADP-332 §4.3 kararı)
  { host: 'n8n.crewpane.dev', why: 'prod n8n paneli' },
  { host: 'admin.shopify.com', why: 'canlı Shopify admin' },
  { host: '*.myshopify.com', path: /^\/admin(\/|$)/i, why: 'canlı Shopify admin' },
  { host: 'supabase.com', path: /^\/dashboard(\/|$)/i, why: 'Supabase prod paneli' },
  { host: 'vercel.com', why: 'deploy paneli' },
  // Ödeme / bankacılık
  { host: 'stripe.com', why: 'ödeme sağlayıcı' },
  { host: 'dashboard.stripe.com', why: 'ödeme sağlayıcı' },
  { host: '*.paypal.com', why: 'ödeme sağlayıcı' },
  { host: '*.iyzico.com', why: 'ödeme sağlayıcı' },
  { host: '*.papara.com', why: 'ödeme sağlayıcı' },
  { host: '*.garantibbva.com.tr', why: 'bankacılık' },
  { host: '*.isbank.com.tr', why: 'bankacılık' },
  { host: '*.akbank.com', why: 'bankacılık' },
  { host: '*.ziraatbank.com.tr', why: 'bankacılık' },
  { host: '*.yapikredi.com.tr', why: 'bankacılık' },
  // E-posta oturumları (hesap kurtarma → her şeyin anahtarı)
  { host: 'mail.google.com', why: 'e-posta oturumu' },
  { host: 'outlook.office.com', why: 'e-posta oturumu' },
  { host: 'outlook.live.com', why: 'e-posta oturumu' },
]);

// ── Hassas hedef desenleri (ADR-026 §2.2, yukarıdaki sapmalarla) ─────────────
const SENSITIVE_AUTOCOMPLETE = /^(cc-|one-time-code|new-password|current-password)/i;
/** Alan adı/id/aria-label/placeholder deseni — SIR taşıyan alanlar. */
const SENSITIVE_FIELD_NAME = /(pass(word)?|şifre|sifre|parola|card|kart|cvv|cvc|iban|otp|one[-_ ]?time|doğrulama|dogrulama|secret|token|api[-_ ]?key|private[-_ ]?key|seed[-_ ]?phrase|tckn|kimlik[-_ ]?no)/i;
/** GERİ ALINAMAZ / yüksek bahisli buton metinleri (çıplak "gönder" bilerek YOK — bkz. başlık). */
const DESTRUCTIVE_TEXT =
  /(öde|ode\b|ödeme|odeme|pay\b|payment|checkout|satın al|satin al|sipariş ver|siparis ver|place order|sil\b|delete|kaldır|kaldir|remove|hesabı kapat|hesabi kapat|yayınla|yayinla|publish|deploy|canlıya al|canliya al|transfer|havale|eft\b|para gönder|para gonder)/i;

/** Yazılacak METNİN kendisi sır mı? (Luhn'lu kart no · IBAN · TCKN · API anahtarı) */
function secretTextReason(text) {
  const s = String(text || '');
  if (!s.trim()) return null;
  const digits = s.replace(/[\s-]/g, '');
  if (/^\d{13,19}$/.test(digits) && luhnValid(digits)) return 'kart numarası (Luhn doğruladı)';
  if (/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/i.test(digits)) return 'IBAN';
  if (/^\d{11}$/.test(digits) && digits[0] !== '0') return 'TCKN benzeri 11 haneli numara';
  if (/\b(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{20,}\.)/.test(s)) {
    return 'API anahtarı/token';
  }
  return null;
}

function luhnValid(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// ── Origin ───────────────────────────────────────────────────────────────────

/** URL → { host, port, path, origin } · çözümlenemezse null (çağıran güvenli tarafa düşer). */
function parseTarget(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (!/^https?:$/i.test(u.protocol) && !/^file:$/i.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase();
  return { host, port: u.port || '', path: u.pathname || '/', origin: u.origin, protocol: u.protocol };
}

/** Host, desenle eşleşiyor mu? `*.x.com` alt alanları (ve x.com'un kendisini) kapsar; `x.com` de öyle. */
function hostMatches(host, pattern) {
  let p = String(pattern || '').trim().toLowerCase().replace(/^https?:\/\//, '');
  // IPv6 köşeli parantezli host (`[::1]`) — içindeki `:`'ler port ayracı DEĞİLDİR.
  p = p.startsWith('[') ? p.replace(/\].*$/, ']') : p.replace(/[:/].*$/, '');
  if (!p || !host) return false;
  if (p.startsWith('[') || p.includes(':')) return host === p || `[${host}]` === p; // IPv6: alt alan yok
  if (host.startsWith('[')) return false;
  if (p.startsWith('*.')) {
    const base = p.slice(2);
    return host === base || host.endsWith('.' + base);
  }
  return host === p || host.endsWith('.' + p);
}

function matchesRule(target, rule) {
  const r = typeof rule === 'string' ? { host: rule } : rule || {};
  if (!hostMatches(target.host, r.host)) return false;
  if (r.path instanceof RegExp) return r.path.test(target.path);
  return true;
}

function normalizeSettings(settings) {
  const s = (settings && settings.browserTrust) || settings || {};
  const mode = MODE_ALIASES[String(s.mode || '').toLowerCase()] || 'normal';
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : []);
  return { mode, trustedOrigins: list(s.trustedOrigins), blockedOrigins: list(s.blockedOrigins) };
}

/**
 * ADR-026 §2.1 — origin güven seviyesi.
 * Sıra: YASAK (kullanıcı > yerleşik) → görev-içi RET → oturum izni → GÜVENİLİR → bilinmiyor.
 * Yasak, güvenilir'i EZER (n8n.crewpane.dev prod paneli, crewpane.dev güvenilir olsa da).
 * Çözümlenemeyen URL → `unknown` (asla trusted'a düşmez — güvenli varsayılan).
 */
function classifyOrigin(url, settings, grants, now = 0, key = null) {
  const target = parseTarget(url);
  if (!target) return { level: 'unknown', reason: 'origin çözümlenemedi (güvenli varsayılan)', origin: null };
  const cfg = normalizeSettings(settings);

  for (const rule of cfg.blockedOrigins) {
    if (matchesRule(target, rule)) return { level: 'blocked', reason: `kara listede (${rule})`, origin: target.origin };
  }
  for (const rule of BUILTIN_BLOCKED) {
    if (matchesRule(target, rule)) return { level: 'blocked', reason: `yerleşik yasak: ${rule.why}`, origin: target.origin };
  }
  // Görev boyunca REDDEDİLDİ → bir daha sorma (ADR-026 §2.4: ret de bir karardır).
  if (grants && key && grants.isDenied(key, target.origin)) {
    return { level: 'blocked', reason: 'bu görev için reddedildi', origin: target.origin };
  }
  if (grants && key && grants.isGranted(key, target.origin, now)) {
    return { level: 'session', reason: 'bu görev için izin verildi', origin: target.origin };
  }
  for (const rule of cfg.trustedOrigins) {
    if (matchesRule(target, rule)) return { level: 'trusted', reason: `kullanıcı güvenilir listesinde (${rule})`, origin: target.origin };
  }
  for (const rule of BUILTIN_TRUSTED) {
    if (matchesRule(target, rule)) return { level: 'trusted', reason: `yerleşik güvenilir (${rule})`, origin: target.origin };
  }
  return { level: 'unknown', reason: 'tanınmayan origin', origin: target.origin };
}

// ── Hedef ────────────────────────────────────────────────────────────────────

/**
 * ADR-026 §2.2 — hedef hassas mı? Girdi, kapının CDP ile EYLEMDEN ÖNCE ölçtüğü eleman
 * bilgisi (ADP-341) + yazılacak metin. Eleman okunamadıysa `unknown:true` ver → çağıran
 * güvenli varsayılana (sor) düşer; burada uydurma yapılmaz.
 */
function classifyTarget({ elementInfo, text, action } = {}) {
  const el = elementInfo || null;
  const t = String(text || '');

  const secret = secretTextReason(t);
  if (secret) return { sensitive: true, reason: `yazılacak metin sır içeriyor: ${secret}` };

  if (!el) {
    // Değiştiren eylemde eleman bilgisi YOKSA hüküm verilemez → bilinmiyor (kapı: sor).
    const mutating = MUTATING_ACTIONS.includes(action);
    return { sensitive: false, unknown: mutating, reason: mutating ? 'hedef eleman okunamadı' : null };
  }

  const type = String(el.type || '').toLowerCase();
  const autocomplete = String(el.autocomplete || '').toLowerCase();
  const tag = String(el.tag || '').toLowerCase();
  const label = [el.name, el.id, el.ariaLabel, el.placeholder].filter(Boolean).join(' ');
  const innerText = String(el.innerText || '');

  if (type === 'password') return { sensitive: true, reason: 'parola alanı' };
  if (type === 'file') return { sensitive: true, reason: 'dosya yükleme alanı' };
  if (SENSITIVE_AUTOCOMPLETE.test(autocomplete)) return { sensitive: true, reason: `hassas autocomplete (${autocomplete})` };
  if (SENSITIVE_FIELD_NAME.test(label)) return { sensitive: true, reason: `hassas alan adı (${label.trim().slice(0, 40)})` };

  // Tıklanacak elemanın metni geri alınamaz bir fiil mi? (buton/link/submit)
  const clickable = tag === 'button' || tag === 'a' || type === 'submit' || type === 'button';
  if ((clickable || action === 'click') && DESTRUCTIVE_TEXT.test(innerText)) {
    return { sensitive: true, reason: `geri alınamaz eylem butonu ("${innerText.trim().slice(0, 40)}")` };
  }
  return { sensitive: false, reason: null };
}

// ── Oturum izinleri (saf, bellekte — DİSKE YAZILMAZ) ─────────────────────────

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 dk
const DEFAULT_MAX_ACTIONS = 200;

/**
 * ADR-026 §2.4 — görev-başı izin defteri. Anahtar: `(delegationId ?? agentId) × origin`.
 * Uygulama kapanınca yok olur; kalıcı güven YALNIZ Ayarlar listesinden verilir.
 */
function createGrantStore() {
  const grants = new Map(); // `${key} ${origin}` → { expiresAt, remaining }
  const denials = new Set();
  const k = (key, origin) => `${key || ''} ${origin || ''}`;

  return {
    grant(key, origin, { ttlMs = DEFAULT_TTL_MS, maxActions = DEFAULT_MAX_ACTIONS, now = 0 } = {}) {
      if (!key || !origin) return false;
      denials.delete(k(key, origin)); // izin, önceki reddi geçersiz kılar
      grants.set(k(key, origin), { expiresAt: now + Math.max(0, ttlMs), remaining: Math.max(0, maxActions) });
      return true;
    },
    deny(key, origin) {
      if (!key || !origin) return false;
      grants.delete(k(key, origin));
      denials.add(k(key, origin));
      return true;
    },
    isDenied(key, origin) {
      return denials.has(k(key, origin));
    },
    isGranted(key, origin, now = 0) {
      const g = grants.get(k(key, origin));
      if (!g) return false;
      if (now > g.expiresAt || g.remaining <= 0) {
        grants.delete(k(key, origin)); // süresi/bütçesi bitti → izin YOK (yeniden sorulur)
        return false;
      }
      return true;
    },
    /** Bir eylem koştu → izin bütçesinden düş. İzin yoksa false. */
    consume(key, origin, now = 0) {
      if (!this.isGranted(key, origin, now)) return false;
      const g = grants.get(k(key, origin));
      g.remaining -= 1;
      return true;
    },
    remaining(key, origin) {
      const g = grants.get(k(key, origin));
      return g ? g.remaining : 0;
    },
    /** DURDUR düğmesi (ADR-026 §3.3): tüm oturum izinleri iptal. Retler de temizlenir. */
    revokeAll() {
      const n = grants.size;
      grants.clear();
      denials.clear();
      return n;
    },
    size() {
      return grants.size;
    },
  };
}

// ── Karar (ADR-026 §2.3 matrisi) ─────────────────────────────────────────────

const D = (decision, reason, extra = {}) => ({ decision, reason, ...extra });

/**
 * @param {object} p
 * @param {string} p.action        navigate|read|readPage|screenshot|scroll|click|type
 * @param {string} p.url           SAYFANIN GERÇEK adresi — main'den (guest.getURL()), ASLA ajanın
 *                                 payload'ından: ajan kendi origin'ini uyduramamalı.
 * @param {object} [p.elementInfo] CDP ile eylemden ÖNCE okunan hedef eleman
 * @param {string} [p.text]        `type` eyleminde yazılacak metin
 * @param {object} [p.settings]    { browserTrust: { mode, trustedOrigins, blockedOrigins } }
 * @param {object} [p.grants]      createGrantStore()
 * @param {string} [p.key]         delegationId ?? agentId (oturum izni anahtarı)
 * @param {number} [p.now]         enjekte edilen saat (saf test)
 * @param {boolean} [p.automation] ADP-343 — kullanıcının SÜRE SINIRLI "bu oturumda sorma" anahtarı
 *                                 (Ayarlar → Güven). Kalıcı modu geçici olarak `gevşek`e çeker:
 *                                 tanınmayan origin'de kart çıkmaz. DEĞİŞMEZ KURALLARI DELMEZ —
 *                                 yasak origin yine reddedilir, hassas hedef ve okunamayan hedef
 *                                 yine sorar (o dallar mod'a bakmadan ÖNCE karar verir).
 * @param {'agent'|'mobile'} [p.source]  mobil tetikli otomasyon → HER ZAMAN sıkı, oturum izni YOK (ADR-020)
 * @returns {{decision:'allow'|'ask'|'ask-session'|'deny', reason:string, level:string, sensitive:boolean, origin:string|null, mode:string, scope?:'once'|'session'}}
 */
function decide(p = {}) {
  const action = String(p.action || '');
  const source = p.source === 'mobile' ? 'mobile' : 'agent';
  const cfg = normalizeSettings(p.settings);
  // ADP-343 — otomasyon modu: kullanıcının süre sınırlı, AÇIK bir eylemi (Ayarlar → Güven).
  // Kalıcı modun üstüne biner (sıkı dahil — kullanıcı "şimdilik sorma" demiştir), ama mobil
  // kaynakta ASLA (ADR-020: mobil kapı gevşemez).
  const automation = p.automation === true && source !== 'mobile';
  const mode = source === 'mobile' ? 'siki' : automation ? 'gevsek' : cfg.mode;
  const now = Number(p.now) || 0;

  const org = classifyOrigin(p.url, p.settings, p.grants, now, p.key);
  const base = { level: org.level, origin: org.origin, mode, sensitive: false };

  if (!READ_ACTIONS.includes(action) && !MUTATING_ACTIONS.includes(action)) {
    return D('deny', `bilinmeyen eylem: ${action || '(boş)'}`, base); // yüzeyde olmayan eylem koşmaz
  }

  // OKUMA her yerde serbest — yasak origin'de bile (bakmak zarar vermez, ADR-026 §2.3).
  if (READ_ACTIONS.includes(action)) {
    return D('allow', `okuma eylemi (${action}) — sayfayı değiştirmez`, base);
  }

  const tgt = classifyTarget({ elementInfo: p.elementInfo, text: p.text, action });
  const withT = { ...base, sensitive: !!tgt.sensitive };

  // YASAK origin: değiştiren eylem KOŞMAZ (kart bile gösterilmez).
  if (org.level === 'blocked') return D('deny', org.reason, withT);

  // DEĞİŞMEZ KURAL: hassas hedef → güvenden BAĞIMSIZ olarak her zaman sorar.
  if (tgt.sensitive) return D('ask', tgt.reason, { ...withT, scope: 'once' });

  // Hedef okunamadı (prob başarısız) → güvenli varsayılan: SOR (uydurma "serbest" yok).
  if (tgt.unknown) return D('ask', 'hedef eleman okunamadı — güvenli varsayılan', { ...withT, scope: 'once' });

  // SIKI mod = bugünkü davranış (geri dönüş yolu): her click/type sorar.
  if (mode === 'siki') {
    return D('ask', source === 'mobile' ? 'mobil tetikli otomasyon (her zaman sıkı)' : 'sıkı mod: her değiştiren eylem sorar', {
      ...withT,
      scope: 'once',
    });
  }

  if (org.level === 'trusted' || org.level === 'session') {
    return D('allow', `${org.level === 'trusted' ? 'güvenilir origin' : 'bu görev için izinli origin'} + normal hedef`, withT);
  }

  // unknown: gevşek modda serbest; normal modda GÖREV-BAŞI TEK KART.
  if (mode === 'gevsek') {
    return D(
      'allow',
      automation
        ? 'otomasyon modu (süre sınırlı): tanınmayan origin + normal hedef'
        : 'gevşek mod: tanınmayan origin + normal hedef',
      { ...withT, automation },
    );
  }
  return D('ask-session', 'tanınmayan origin — bu görev için tek onay', { ...withT, scope: 'session' });
}

// ── Audit yardımcısı (ADR-026 §4: onaysız koşanlar DA loglanır, sır MASKELENİR) ──

/** Hassas metin ASLA ham loglanmaz: `•••(12)`. Normal metin kırpılır. */
function maskPreview(text, sensitive, max = 80) {
  const s = String(text == null ? '' : text);
  if (!s) return '';
  if (sensitive) return `•••(${s.length})`;
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

module.exports = {
  READ_ACTIONS,
  MUTATING_ACTIONS,
  MODES,
  BUILTIN_TRUSTED,
  BUILTIN_BLOCKED,
  DEFAULT_TTL_MS,
  DEFAULT_MAX_ACTIONS,
  parseTarget,
  hostMatches,
  normalizeSettings,
  classifyOrigin,
  classifyTarget,
  createGrantStore,
  decide,
  maskPreview,
};
