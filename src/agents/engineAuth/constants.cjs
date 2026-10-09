// CrewPane — Engine Auth Timeouts and Secret Masking.
'use strict';

/** Giriş oturumu için üst sınır — asılı kalan bir akış sonsuza dek yaşamasın. */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/** Durum probu için üst sınır (engineCheck ile aynı bütçe). */
const STATUS_TIMEOUT_MS = 8000;

/**
 * Log'a/olaya çıkacak metinden sır-benzeri her şeyi siler.
 */
function maskSecrets(text) {
  if (typeof text !== 'string' || !text) return '';
  return text
    // Tam URL → yalnız host kalsın (query'de state/code_challenge var).
    .replace(/(https?:\/\/[^\s/]+)\/\S*/g, '$1/…')
    // `code=…`, `token=…`, `key=…` biçimli her atama.
    .replace(/\b(code|token|access_token|refresh_token|id_token|api[-_]?key|secret|state)\s*[=:]\s*\S+/gi, '$1=«gizlendi»')
    // sk-… / oauth token benzeri uzun opak diziler.
    .replace(/\b(sk|pk|rt|at)-[A-Za-z0-9_-]{12,}/g, '«gizlendi»')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '«gizlendi»');
}

module.exports = {
  LOGIN_TIMEOUT_MS,
  STATUS_TIMEOUT_MS,
  maskSecrets,
};
