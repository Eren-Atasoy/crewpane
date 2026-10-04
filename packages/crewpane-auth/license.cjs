// ADP-383 (wheeljack) — offline lisans-jetonu doğrulama çekirdeği (ADR-027 §4 / G3)
//
// Sözleşme (ADR-027):
//   * Jeton: ES256 JWT — header { alg:'ES256', kid }, payload { sub, products[], iat, exp:+72h }.
//   * Doğrulama TAMAMEN OFFLINE: gömülü public key (kid → PEM haritası), ağ YOK.
//   * exp geçtiyse: exp + 14 GÜN grace içinde 'grace' statüsüyle GEÇERLİ sayılır
//     (Pro açık kalır); grace de bittiyse geçersiz → free moda düşülür.
//   * Saat-oynatma koruması: efektif zaman = max(local_now, last_server_time).
//     last_server_time MONOTONİK saklanır (her taze jetonda iat/server_time ile güncellenir);
//     sistem saati geriye alınırsa grace UZAMAZ.
//
// Bağımlılık YOK — yalnız node:crypto. Saat ve durum enjekte edilebilir (test için).

'use strict';

const crypto = require('node:crypto');

const GRACE_SECONDS = 14 * 24 * 60 * 60; // ADR-027: 14 gün grace

/**
 * PAY-1 — `past_due` SÜRE SINIRI (saniye). Sunucu ikizi
 * `crewpane-id/supabase/functions/_shared/plan-caps.ts::PAST_DUE_GRACE_DAYS`
 * ile AYNI sayıdır (drift guard: crewpane-id `test/sec01-plan-caps.test.ts`).
 *
 * ADR-027'nin `GRACE_SECONDS`'ı ile KARIŞTIRMA: o, jetonun OFFLINE toleransıdır
 * (ağ yokken uygulama kaç gün açık kalır). Bu ise ÖDEME gecikmesinin toleransı —
 * ödeme düşmüş bir aboneliğin ne kadar süre daha erişim verdiği. Farklı
 * gerekçelerden gelirler ve PAY-LOCK-01'den beri farklı sayılardır (offline 14,
 * ödeme 3) — bu yüzden iki ayrı sabit.
 *
 * PAY-LOCK-01 (Eren kararı 2026-09-17): 14 → 3. Ödeme düştüğü gün bant çıkar,
 * ikinci günden geri sayım başlar, ÜÇÜNCÜ GÜNÜN SONUNDA tam kilit düşer.
 * Sayı burada TEK BAŞINA anlam taşımaz: beş ikizin (bkz. yukarıdaki sunucu
 * ikizi + `app.past_due_grace_days()` + `crewpane-auth-py`) AYNI anda değişmesi
 * gerekir, yoksa posta bir tarihi, uygulama başka tarihi söyler. Kapı:
 * `crewpane-id` → `npm run check:entitlement:parity`.
 */
const PAST_DUE_GRACE_SECONDS = 3 * 24 * 60 * 60;
const IAT_FUTURE_SKEW_SECONDS = 5 * 60;  // gelecekten gelen jetona tolerans

/** base64url → Buffer */
function b64uToBuf(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * Saat-oynatma korumalı efektif zaman: max(local_now, last_server_time).
 * @param {number} nowSeconds - yerel saat (epoch saniye)
 * @param {number|null|undefined} lastServerTime - en son görülen sunucu zamanı
 */
function effectiveNow(nowSeconds, lastServerTime) {
  const server = Number.isFinite(lastServerTime) ? lastServerTime : 0;
  return Math.max(nowSeconds, server);
}

/**
 * last_server_time'ı MONOTONİK güncelle (geriye asla gitmez).
 * Taze jeton alınınca `server_time` (yoksa jetonun `iat`'ı) ile çağrılır.
 * @param {{lastServerTime?: number|null}} state
 * @param {number} serverTimeSeconds
 * @returns {{lastServerTime: number}} yeni durum (caller persist eder)
 */
function noteServerTime(state, serverTimeSeconds) {
  const prev = Number.isFinite(state && state.lastServerTime) ? state.lastServerTime : 0;
  if (!Number.isFinite(serverTimeSeconds)) return { lastServerTime: prev };
  return { lastServerTime: Math.max(prev, Math.floor(serverTimeSeconds)) };
}

/**
 * ES256 lisans jetonunu OFFLINE doğrula.
 *
 * @param {string} token - JWT (header.payload.signature)
 * @param {object} opts
 * @param {Record<string,string>} opts.publicKeys - kid → SPKI PEM haritası (gömülü; keys.cjs)
 * @param {number} [opts.nowSeconds] - yerel saat (test enjeksiyonu; default: Date.now()/1000)
 * @param {number|null} [opts.lastServerTime] - persist edilen son sunucu zamanı (saat-oynatma koruması)
 * @returns {{valid:true, status:'fresh'|'grace', payload:object, kid:string,
 *            graceRemainingSeconds:number, effectiveNowSeconds:number}
 *          |{valid:false, reason:string, effectiveNowSeconds?:number}}
 */
function verifyLicenseToken(token, opts) {
  const { publicKeys } = opts || {};
  if (!publicKeys || typeof publicKeys !== 'object') {
    return { valid: false, reason: 'no_public_keys' };
  }
  if (typeof token !== 'string') return { valid: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 3) return { valid: false, reason: 'malformed' };

  let header, payload;
  try {
    header = JSON.parse(b64uToBuf(parts[0]).toString('utf8'));
    payload = JSON.parse(b64uToBuf(parts[1]).toString('utf8'));
  } catch {
    return { valid: false, reason: 'malformed' };
  }

  // alg sabitlenir: 'none'/RS256 downgrade saldırısı kapalı
  if (!header || header.alg !== 'ES256') return { valid: false, reason: 'bad_alg' };
  const pem = header.kid ? publicKeys[header.kid] : undefined;
  if (!pem) return { valid: false, reason: 'unknown_kid' };

  let signatureOk = false;
  try {
    signatureOk = crypto.verify(
      'sha256',
      Buffer.from(parts[0] + '.' + parts[1], 'utf8'),
      { key: crypto.createPublicKey(pem), dsaEncoding: 'ieee-p1363' },
      b64uToBuf(parts[2]),
    );
  } catch {
    return { valid: false, reason: 'bad_signature' };
  }
  if (!signatureOk) return { valid: false, reason: 'bad_signature' };

  if (!Number.isFinite(payload.exp) || !Number.isFinite(payload.iat)) {
    return { valid: false, reason: 'missing_claims' };
  }

  const localNow = Number.isFinite(opts.nowSeconds)
    ? opts.nowSeconds
    : Math.floor(Date.now() / 1000);
  const now = effectiveNow(localNow, opts.lastServerTime);

  if (payload.iat > now + IAT_FUTURE_SKEW_SECONDS) {
    return { valid: false, reason: 'not_yet_valid', effectiveNowSeconds: now };
  }

  if (now <= payload.exp) {
    return {
      valid: true, status: 'fresh', payload, kid: header.kid,
      graceRemainingSeconds: payload.exp + GRACE_SECONDS - now,
      effectiveNowSeconds: now,
    };
  }
  const graceEnd = payload.exp + GRACE_SECONDS;
  if (now <= graceEnd) {
    return {
      valid: true, status: 'grace', payload, kid: header.kid,
      graceRemainingSeconds: graceEnd - now,
      effectiveNowSeconds: now,
    };
  }
  return { valid: false, reason: 'expired_beyond_grace', effectiveNowSeconds: now };
}

// ─────────────────────────────────────────────────────────────────────────────
// LIC-ENFORCE-01 — GRACE ARTIK SEBEBE GÖRE AYRILIR (yerel kara-liste damgası)
// ─────────────────────────────────────────────────────────────────────────────
//
// ÖLÇÜLEN AÇIK: 14 günlük grace ÖDEYEN müşterinin çevrimdışı toleransıdır —
// uçakta/internetsiz çalışan müşteriyi kesmemek için vardır. Ama jetonun içindeki
// `products` listesi jetonun İMZALANDIĞI andaki gerçektir: iade/iptal SONRASINDA
// fişi çeken kullanıcı, elindeki eski jetonla `exp(+72s) + grace(14g)` boyunca
// çalışmaya devam edebiliyordu (en kötü hâl ~17 gün).
//
// DAMGA bu iki sebebi AYIRIR:
//   * sunucuya ULAŞILAMIYOR  → damga YOK   → grace çalışır (ödeyen korunur)
//   * sunucu AÇIKÇA "yetki yok" dedi → damga VAR → o andan ÖNCE imzalanmış her
//     jeton (fresh olsun, grace olsun) GEÇERSİZ sayılır.
//
// Üç tasarım kuralı:
//   1. Damgayı YALNIZ sunucunun teslim ettiği bir jetonun DEĞERLENDİRMESİ düşürür.
//      Ağ hatası, 5xx, cihaz reddi ASLA damga düşürmez — yanlış pozitif en pahalı
//      hatadır (ADP-646 duruşu aynen sürüyor).
//   2. `at` alanı SUNUCU zamanıdır (yerel saat DEĞİL). Sistem saatini geri almak
//      damgayı düşüremez; damga jetonun `iat`'ıyla kıyaslanır, ikisi de sunucudan.
//   3. Damga GERİ ALINABİLİR ve bunu yalnız DAHA YENİ bir jeton yapar: kullanıcı
//      yeniden abone olduğunda gelen jetonun `iat`'ı damgadan büyüktür → damga
//      düşer. Eski bir `license.bin` yedeğini geri koymak (rollback) damgayı
//      DÜŞÜREMEZ, çünkü o jetonun `iat`'ı damgadan küçüktür.

/** Damga şeması sürümü — ileride alan eklenirse eski blob sessizce yoksayılmasın. */
const REVOCATION_STAMP_VERSION = 1;

/**
 * Sunucunun açık reddinden damga üret.
 * @param {{userId?:string|null, reason?:string, at:number}} o
 *   `at`: SUNUCU zamanı (epoch saniye) — tercihen `server_time`, yoksa reddi
 *   taşıyan jetonun `iat`'ı. Yerel saat KULLANILMAZ.
 * @returns {{v:number, userId:string|null, reason:string, at:number}|null}
 */
function makeRevocationStamp(o) {
  const at = o && Number.isFinite(o.at) ? Math.floor(o.at) : null;
  if (at === null) return null; // sunucu zamanı yoksa damga da yok (uydurmayız)
  return {
    v: REVOCATION_STAMP_VERSION,
    userId: o.userId ? String(o.userId) : null,
    reason: typeof o.reason === 'string' && o.reason ? o.reason : 'no_entitlement',
    at,
  };
}

/** Diskten okunan damgayı doğrula; şekli bozuksa/sürümü bilinmiyorsa null. */
function normalizeRevocationStamp(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.v !== REVOCATION_STAMP_VERSION) return null;
  if (!Number.isFinite(raw.at)) return null;
  return {
    v: REVOCATION_STAMP_VERSION,
    userId: raw.userId ? String(raw.userId) : null,
    reason: typeof raw.reason === 'string' && raw.reason ? raw.reason : 'no_entitlement',
    at: Math.floor(raw.at),
  };
}

/**
 * Bu damga elimizdeki jetonu BLOKE ediyor mu?
 *
 * Kural TEK cümle: jeton damgadan ÖNCE (ya da tam o anda) imzalanmışsa bloke.
 * `status` ('fresh'/'grace') BURADA sorulmaz — bir rollback saldırısında jeton
 * "fresh" görünür; kararı statüye bağlamak o kapıyı açık bırakırdı.
 *
 * @param {{v:number,userId:string|null,at:number}|null} stamp
 * @param {{valid:boolean, payload?:object}|null} verifyResult
 * @param {{userId?:string|null}} [opts] - bu kurulumda oturum açan kullanıcı;
 *   damga BAŞKA bir hesaba aitse uygulanmaz (aynı makinede iki hesap).
 * @returns {boolean}
 */
function revocationApplies(stamp, verifyResult, opts) {
  const st = normalizeRevocationStamp(stamp);
  if (!st) return false;
  if (!verifyResult || verifyResult.valid !== true || !verifyResult.payload) return false;
  const currentUser = opts && opts.userId ? String(opts.userId) : null;
  // Damga hesap-başınadır: aynı makinede B hesabına giren kullanıcı, A hesabının
  // reddiyle kilitlenmez. Taraflardan biri bilinmiyorsa (eski damga / oturumsuz
  // değerlendirme) kimlik kıyası ATLANIR — damga yine de uygulanır.
  if (st.userId && currentUser && st.userId !== currentUser) return false;
  const iat = verifyResult.payload.iat;
  if (!Number.isFinite(iat)) return true; // iat'sız jeton zaten güvenilmez
  return iat <= st.at;
}

/** period_end (ISO string) → epoch saniye; yok/bozuksa null. */
function periodEndSeconds(entry) {
  if (!entry) return null;
  return parseStampSeconds(entry.period_end);
}

/** ISO damga → epoch saniye; boş/bozuksa null ("ölçemedim" = damga YOK). */
function parseStampSeconds(raw) {
  if (!raw) return null;
  const s = Math.floor(Date.parse(raw) / 1000);
  return Number.isFinite(s) ? s : null;
}

/**
 * Bir ürün bu jetonla YETKİLİ mi? (ADR-027 iptal semantiği:
 * 'canceled' period_end'e KADAR aktif muamelesi görür; 'revoked' anında kapanır;
 * 'past_due' sağlayıcı retry penceresinde AÇIK tutulur — kullanıcıyı ödeme
 * retry'ı sırasında düşürmemek için, ama PAY-1'den beri SÜRESİZ DEĞİL:
 * damgalı satır PAST_DUE_GRACE_SECONDS sonra kapanır.)
 *
 * ADP-416 deneme kuralı: plan='trial' YALNIZ period_end'e kadar yetkilidir ve
 * GRACE'SİZDİR — jetonun 14 gün grace'i satın alınmış planların offline
 * toleransıdır, denemeyi uzatmaz (trial expired = kilit). period_end'siz trial
 * satırı (olmamalı) kapalı sayılır. effectiveNowSeconds saat-oynatma korumalı
 * olduğundan sistem saatini geri almak denemeyi uzatmaz.
 *
 * @param {{valid:boolean, payload?:object, effectiveNowSeconds?:number}} verifyResult
 * @param {string} product - ör. 'agentshot.pro'
 */
function isProductEntitled(verifyResult, product) {
  if (!verifyResult || verifyResult.valid !== true) return false;
  const list = Array.isArray(verifyResult.payload.products)
    ? verifyResult.payload.products : [];
  const entry = list.find((p) => p && p.product === product);
  if (!entry) return false;
  if (entry.plan === 'trial') {
    if (entry.status !== 'active') return false;
    const endSeconds = periodEndSeconds(entry);
    return endSeconds !== null && verifyResult.effectiveNowSeconds <= endSeconds;
  }
  if (entry.status === 'active') return true;
  if (entry.status === 'past_due') {
    // PAY-1 — GECİKME SÜRESİZ DEĞİL. `entry.past_due_since` = sunucudaki
    // `entitlements.past_due_since` damgası (license-token yüke koyar): satır İLK
    // kez `past_due`'ya geçtiği an. Damgadan önce kural tarihe HİÇ bakmıyordu ve
    // ödemesi düşen müşteri sonsuza kadar tam erişimdeydi (PAY-ENFORCE-R1'de
    // PROD'da ölçüldü). Damgasız satır ESKİSİ GİBİ açık kalır — geri-uyum:
    // ölçülemeyen bir damga yüzünden ÖDEYEN müşteriyi kilitlemek, sızıntıdan
    // pahalı bir hatadır. Bu kural sunucu ikizi `plan-caps.ts::isRowEntitled`
    // ile BİREBİR aynıdır.
    const since = parseStampSeconds(entry.past_due_since);
    if (since === null) return true;
    return verifyResult.effectiveNowSeconds <= since + PAST_DUE_GRACE_SECONDS;
  }
  if (entry.status === 'canceled') {
    // LIC-REFUND-01 — İADE EDİLMİŞ SATIR DÖNEM HAKKI KAZANMAZ.
    // `entry.revoked_at` = sunucudaki `entitlements.revoked_at` iade damgası
    // (license-token yüke koyar). İade satırı önce `revoked` yapar, ama Stripe
    // aboneliği de kapattığı için `sub.canceled` status'ü `canceled`e çevirir ve
    // damga satırda KALIR. Damgaya bakmayan kural, parası geri verilen müşteriye
    // dönem sonuna kadar erişim verirdi (canlı vaka evt_3U6m0k2WVOTzyDWy04Ct0ruE).
    // Damgasız `canceled` DEĞİŞMEZ: normal iptal ödenmiş dönemin sonuna kadar açık.
    // Bu kural sunucu ikizi `plan-caps.ts::isRowEntitled` ile BİREBİR aynıdır ve
    // crewpane-id `test/sec01-plan-caps.test.ts` iki tarafı aynı vakalarla ölçer.
    if (entry.revoked_at) return false;
    const endSeconds = periodEndSeconds(entry);
    return endSeconds !== null && verifyResult.effectiveNowSeconds <= endSeconds;
  }
  return false; // 'revoked' ve bilinmeyen statüler kapalı
}

/**
 * Jetondaki ürün girdisini kalan süresiyle döndür (UI "deneme: N gün kaldı"
 * göstergesi — ADP-416). Girdi yoksa/jeton geçersizse null.
 * @param {{valid:boolean, payload?:object, effectiveNowSeconds?:number}} verifyResult
 * @param {string} product
 * @returns {{product:string, plan:string, status:string, period_end:string|null,
 *            past_due_since:string|null, remainingSeconds:number|null}|null} remainingSeconds: period_end'e
 *   kalan saniye (0 tabanlı); period_end'siz (süresiz/LTD) planlarda null.
 */
function getProductEntry(verifyResult, product) {
  if (!verifyResult || verifyResult.valid !== true) return null;
  const list = Array.isArray(verifyResult.payload.products)
    ? verifyResult.payload.products : [];
  const entry = list.find((p) => p && p.product === product);
  if (!entry) return null;
  const endSeconds = periodEndSeconds(entry);
  return {
    product: entry.product,
    plan: entry.plan,
    status: entry.status,
    period_end: entry.period_end || null,
    // PAY-3: gecikme damgası UI'a kadar taşınır — band "N gün kaldı" diyebilsin.
    past_due_since: entry.past_due_since || null,
    remainingSeconds: endSeconds === null
      ? null
      : Math.max(0, endSeconds - verifyResult.effectiveNowSeconds),
  };
}

module.exports = {
  GRACE_SECONDS,
  // PAY-1 — `past_due` süre sınırı (sunucu `PAST_DUE_GRACE_DAYS` aynası)
  PAST_DUE_GRACE_SECONDS,
  effectiveNow,
  noteServerTime,
  verifyLicenseToken,
  isProductEntitled,
  getProductEntry,
  // LIC-ENFORCE-01 — grace'i sebebe göre ayıran yerel kara-liste damgası
  REVOCATION_STAMP_VERSION,
  makeRevocationStamp,
  normalizeRevocationStamp,
  revocationApplies,
};
