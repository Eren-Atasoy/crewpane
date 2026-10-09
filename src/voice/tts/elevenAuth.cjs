// CrewPane — ElevenLabs Authentication, API Base Resolution, and Error Hints.
'use strict';

const {
  ELEVEN_API_BASE,
  TTS_BASE_OPT_IN,
  TTS_BASE_OVERRIDE,
  ELEVEN_AUTH_HINTS,
} = require('./constants.cjs');

/** Yalnız 127.0.0.1 / localhost / [::1] — başka bir hedef ASLA kabul edilmez. */
function isLoopbackUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(u.hostname);
  } catch { return false; }
}

/**
 * Etkin ElevenLabs taban adresi. Varsayılan HER ZAMAN gerçek sağlayıcıdır.
 * @param {object} [env] - test dikişi (varsayılan process.env)
 * @param {object} [deps]
 */
function elevenApiBase(env = process.env, deps = {}) {
  const isCustomerBuild = deps.isCustomerBuild || (() => {
    try { return require('../../config/buildChannel.cjs').isCustomerBuild(); } catch { return false; }
  });
  const instanceId = deps.instanceId || (() => {
    try { return require('../../config/instancePaths.cjs').instanceId(); } catch { return 'prod'; }
  });
  if (isCustomerBuild()) return ELEVEN_API_BASE;
  const id = instanceId();
  if (id !== 'dev' && id !== 'test') return ELEVEN_API_BASE;
  if (String(env[TTS_BASE_OPT_IN] || '').trim() !== '1') return ELEVEN_API_BASE;
  const raw = String(env[TTS_BASE_OVERRIDE] || '').trim();
  if (!raw || !isLoopbackUrl(raw)) return ELEVEN_API_BASE;
  return raw.replace(/\/+$/, '');
}

/**
 * ADP-918 — sağlayıcı hata gövdesini oku. ASLA fırlatmaz.
 * @returns {{status:string|null, message:string|null}}
 */
function parseProviderError(detail) {
  const raw = typeof detail === 'string' ? detail.trim() : '';
  if (!raw || raw[0] !== '{') return { status: null, message: null };
  let json;
  try { json = JSON.parse(raw); } catch { return { status: null, message: null }; }
  const d = json && json.detail;
  if (typeof d === 'string') return { status: null, message: d.slice(0, 200) };
  if (d && typeof d === 'object') {
    return {
      status: typeof d.status === 'string' ? d.status : null,
      message: typeof d.message === 'string' ? d.message.slice(0, 200) : null,
    };
  }
  return { status: null, message: null };
}

/**
 * ADP-918 — YETKİ hatasının kullanıcıya söylenecek hâli. `null` = bu HTTP durumu
 * için yönlendirici bir şey söyleyemiyoruz (çağıran eski metnini kullanır).
 * @returns {{status:string|null, providerMessage:string|null, text:string}|null}
 */
function elevenAuthHint(httpStatus, detail) {
  const { status, message } = parseProviderError(detail);
  const authByCode = httpStatus === 401 || httpStatus === 403;
  const knownAuthStatus = !!(status && Object.prototype.hasOwnProperty.call(ELEVEN_AUTH_HINTS, status));
  if (!authByCode && !(httpStatus === 400 && knownAuthStatus)) return null;
  const known = status && ELEVEN_AUTH_HINTS[status];
  if (known) return { status, providerMessage: message, text: known.text };
  const said = message ? ` Sağlayıcının kendi açıklaması: “${message}”.` : '';
  return {
    status: status || null,
    providerMessage: message,
    text: `ElevenLabs isteği yetki hatasıyla reddetti (HTTP ${httpStatus}).${said} ` +
      'Anahtarı ElevenLabs → Profile → API Keys’ten yeniden kopyalayıp Ayarlar → Ses → Erişim’e kaydet; ' +
      'anahtarın izinleri “Text to Speech” ve “Voices: read” içermeli.',
  };
}

const INVISIBLE_CHARS_RE = /[\u200B-\u200D\u2060\uFEFF]/g;

/** Kopyala-yapıştır kabuğunu soy: dış boşluk, görünmez karakter, sarmalayan tırnak. */
function sanitizeApiKey(raw) {
  let k = String(raw == null ? '' : raw).replace(INVISIBLE_CHARS_RE, '').trim();
  for (let i = 0; i < 3 && k.length >= 2; i += 1) {
    const a = k[0]; const b = k[k.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'") || (a === '`' && b === '`')) k = k.slice(1, -1).trim();
    else break;
  }
  return k;
}

/** HTTP başlığına konulabilir mi? (yazdırılabilir ASCII, boşluksuz) */
function isHeaderSafeKey(k) {
  return typeof k === 'string' && k.length > 0 && !/\s/.test(k) && !/[^\x20-\x7E]/.test(k);
}

module.exports = {
  isLoopbackUrl,
  elevenApiBase,
  parseProviderError,
  elevenAuthHint,
  sanitizeApiKey,
  isHeaderSafeKey,
};
