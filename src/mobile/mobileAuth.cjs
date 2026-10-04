// ADP-293 — mobil gateway KİMLİK ÇEKİRDEĞİ (saf; node --test doğrudan koşar).
//
// Bu kanal PC'de iş başlatabilir → kimlik en yüksek risk sınıfı. Tasarım kararları:
//   • Token yalnız DOĞUMDA görünür; diskte sadece sha256 HASH'i durur (dosya sızsa
//     bile token türetilemez).
//   • Karşılaştırma sabit-zamanlı (timingSafeEqual).
//   • Eşleşme kodu TEK KULLANIMLIK + kısa ömürlü (QR'ı gören biri sonradan kullanamaz).
//   • Kapsam YAPISAL: 'read' cihaz COMMAND rotasına ASLA giremez (rota tablosu kapsam ister).
//   • İptal (revoke) anında geçerlidir; iptalli cihazın token'ı 'revoked' der (401),
//     "yanlış token" demez → mobil istemci yeniden eşleşme akışına düşebilsin.
//   • Kill-switch (enabled=false) her şeyi keser — pairing dahil.
//
// MCP bridge'in (delegationBridge.js) token'ıyla HİÇBİR ilişkisi yoktur: o loopback'te
// yaşar ve asla tünellenmez (ADR-020 §5).

'use strict';

const crypto = require('node:crypto');

const TOKEN_BYTES = 32;
const PAIRING_TTL_MS = 5 * 60_000; // QR 5 dakika geçerli
const PAIRING_CODE_DIGITS = 8;

/** Yeni cihaz token'ı (yalnız bir kez döner). */
function mintToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

/** Token → diskte saklanan hash. */
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

/** Sabit-zamanlı hash karşılaştırma (uzunluk farkı da sızdırmaz). */
function tokenMatches(token, expectedHash) {
  const a = Buffer.from(hashToken(token), 'utf8');
  const b = Buffer.from(String(expectedHash || ''), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Kısa, insan-okunur, tek kullanımlık eşleşme kodu. */
function mintPairingCode(now = Date.now()) {
  const n = crypto.randomInt(0, 10 ** PAIRING_CODE_DIGITS);
  return {
    code: String(n).padStart(PAIRING_CODE_DIGITS, '0'),
    expiresAt: now + PAIRING_TTL_MS,
  };
}

/** Bearer başlığından token çıkar (yoksa ''). */
function bearerFrom(headerValue) {
  const raw = String(headerValue || '');
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return m ? m[1].trim() : '';
}

/**
 * İsteği kimliklendir + yetkilendir. TEK karar noktası — rota kodu buna uyar.
 * @returns {{ok:true, device:object} | {ok:false, status:number, reason:string, error:string}}
 */
function authorize({ state, token, requiredScope, now = Date.now() }) {
  if (!state || state.enabled !== true) {
    return { ok: false, status: 403, reason: 'disabled', error: 'mobil erişim masaüstünden kapalı (kill-switch)' };
  }
  if (requiredScope === 'public') return { ok: true, device: null };
  if (!token) {
    return { ok: false, status: 401, reason: 'unauthorized', error: 'token yok' };
  }
  const devices = Array.isArray(state.devices) ? state.devices : [];
  const device = devices.find((d) => d && d.tokenHash && tokenMatches(token, d.tokenHash));
  if (!device) {
    return { ok: false, status: 401, reason: 'unauthorized', error: 'geçersiz token' };
  }
  if (device.revokedAt) {
    // Ayrı sebep: istemci "yeniden eşleş" akışına düşsün, sonsuz retry yapmasın.
    return { ok: false, status: 401, reason: 'revoked', error: 'cihaz iptal edilmiş — yeniden eşleşin' };
  }
  if (device.expiresAt && now > device.expiresAt) {
    return { ok: false, status: 401, reason: 'revoked', error: 'cihaz token süresi doldu — yeniden eşleşin' };
  }
  if (requiredScope === 'command' && device.scope !== 'command') {
    return { ok: false, status: 403, reason: 'forbidden-scope', error: 'bu cihaz READ kapsamında — komut yetkisi yok' };
  }
  return { ok: true, device };
}

/** Eşleşme kodunu tüket (tek kullanımlık + TTL). Geçerliyse yeni cihaz kaydı + token üretir. */
function consumePairing({ pending, code, deviceName, scope = 'read', now = Date.now() }) {
  const rec = pending && pending.get(String(code || ''));
  if (!rec) return { ok: false, status: 401, reason: 'unauthorized', error: 'eşleşme kodu geçersiz' };
  pending.delete(String(code)); // TEK kullanımlık — doğru da olsa yanlış da olsa yanar
  if (now > rec.expiresAt) return { ok: false, status: 401, reason: 'unauthorized', error: 'eşleşme kodu süresi doldu' };
  const token = mintToken();
  const device = {
    id: `dev-${crypto.randomBytes(6).toString('hex')}`,
    name: String(deviceName || 'bilinmeyen cihaz').slice(0, 60),
    tokenHash: hashToken(token),
    // ADP-293 — VARSAYILAN READ-ONLY. 'command' yükseltmesi masaüstünden yapılır (ADP-296).
    scope: scope === 'command' ? 'command' : 'read',
    createdAt: now,
    lastSeenAt: now,
    revokedAt: null,
  };
  return { ok: true, device, token };
}

/** Audit satırı (JSONL) — her istek, kim/ne/sonuç. Token ASLA yazılmaz. */
function auditLine({ at = Date.now(), deviceId, deviceName, ip, method, path: p, status, reason, note }) {
  return JSON.stringify({
    at: new Date(at).toISOString(),
    deviceId: deviceId || null,
    device: deviceName || null,
    ip: ip || null,
    method: method || null,
    path: p || null,
    status: status ?? null,
    reason: reason || null,
    note: note || null,
  });
}

/** Basit kayan-pencere hız sınırı (kötüye kullanım + kaza koruması). */
function makeRateLimiter(max = 120, windowMs = 60_000, now = () => Date.now()) {
  const hits = new Map(); // key → number[]
  return function allow(key) {
    const t = now();
    const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
    if (arr.length >= max) {
      hits.set(key, arr);
      return false;
    }
    arr.push(t);
    hits.set(key, arr);
    return true;
  };
}

module.exports = {
  PAIRING_TTL_MS,
  mintToken,
  hashToken,
  tokenMatches,
  mintPairingCode,
  bearerFrom,
  authorize,
  consumePairing,
  auditLine,
  makeRateLimiter,
};
