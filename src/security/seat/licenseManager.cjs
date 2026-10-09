// CrewPane — Seat Gate License Evaluation, Token Management and Integrity.
'use strict';

const planCatalog = require('../../config/planCatalog.cjs');
const { decideAccess } = require('./decideAccess.cjs');
const { readPastDue, readCancelEnding } = require('./dunningParser.cjs');
const { DEVICE_DENIALS } = require('./constants.cjs');

/**
 * SEC-W2-A2 — isteğe binen bütünlük raporu (tek yer).
 *
 * Sağlayıcı ATARSA rapor gönderilmez: bir ölçüm arızası ÖDEYEN müşteriyi
 * kesmemeli. `null` dönmek "ölçmedim" demektir ve sunucuda zorlama YOKTUR.
 */
function integrityReport(ctx) {
  if (typeof ctx.opts.getIntegrityReport !== 'function') return null;
  try {
    const r = ctx.opts.getIntegrityReport();
    return r && r.jws && r.root ? { jws: r.jws, root: r.root } : null;
  } catch (e) {
    ctx.log(`seatGate: bütünlük raporu okunamadı (${e.message}) — rapor gönderilmiyor`);
    return null;
  }
}

/**
 * LIC-ENFORCE-01 — SUNUCUNUN TESLİM ETTİĞİ JETONDAN DAMGA KARARI.
 *
 * Bu fonksiyon YALNIZ sunucu bir jeton teslim ettiğinde çağrılır; ağ hatası,
 * 5xx ve cihaz reddi buraya HİÇ gelmez — bu, "ödeyen çevrimdışı müşteri
 * kesilmez" kuralının kod hâlidir.
 *
 * Üç sonuç ayrılır (birbirine karıştırılırsa yanlış pozitif doğar):
 *   * `undefined` → HÜKÜM YOK (jeton doğrulanamadı; eski damgaya dokunma)
 *   * `null`      → yetki VAR   → damga DÜŞER (yeniden abone oldu)
 *   * damga       → yetki YOK   → sunucunun AÇIK reddi kaydedilir
 *
 * @returns {{v:number,userId:string|null,reason:string,at:number}|null|undefined}
 */
function revocationVerdict(ctx, token, serverTime) {
  const { authPkg, lastServerTime, userId } = ctx;
  const verify = authPkg.verifyWithEmbeddedKeys(token, { lastServerTime });
  if (!verify.valid) return undefined; // doğrulanamayan jetondan hüküm çıkarmayız
  const ids = planCatalog.accessProductIds();
  if (ids.some((productId) => authPkg.isProductEntitled(verify, productId))) return null;
  // Sebep VERİDEN türer (isim bazlı `if` yok): erişim veren ürünlerin jetondaki
  // statüsüne bakılır. Ret cümlesi kullanıcıya "neden" diyebilsin diye taşınır.
  const entries = Array.isArray(verify.payload.products) ? verify.payload.products : [];
  const mine = entries.filter((p) => p && ids.includes(p.product));
  const reason = mine.some((p) => p.status === 'revoked') ? 'revoked'
    : mine.some((p) => p.status === 'canceled') ? 'canceled'
      // PAY-3 — ÖDEME GECİKMESİ AYRI BİR SEBEPTİR. Eskiden `inactive` kefesine
      // düşüyordu ve kullanıcı "aboneliğin sona erdi (iptal veya iade)" cümlesini
      // görüyordu; ne iptal etmişti ne iade almıştı — kartı düşmüştü.
      : mine.some((p) => p.status === 'past_due') ? 'past_due'
        : mine.length ? 'inactive' : 'no_entitlement';
  return authPkg.makeRevocationStamp({
    // Jetonun `sub`'ı SUNUCU gerçeğidir; oturum kaydı yalnız yedek.
    userId: verify.payload.sub || userId || null,
    reason,
    // `server_time` yoksa jetonun kendi `iat`'ı: ikisi de SUNUCU saatidir.
    at: Number.isFinite(serverTime) ? serverTime : verify.payload.iat,
  });
}

/** Durumu YENİDEN hesapla — ucuz, tamamen yerel (ağ YOK): ES256 doğrulama + grace. */
function evaluate(ctx) {
  let licenseStatus = 'none'; // fresh | grace | expired | invalid | none
  let seat = false;
  let products = [];
  let accessProducts = [];
  let tier = null;
  let verify = null;
  // LIC-ENFORCE-01 — damga jetondan ÖNCE sorulur mu? HAYIR: damga jetonun
  // `iat`'ıyla kıyaslandığı için önce doğrulama şart. Ama karar SIRASI şudur:
  // jeton geçerli olsa BİLE damga onu geçersiz kılabilir.
  let revoked = false;
  if (ctx.licenseToken) {
    verify = ctx.authPkg.verifyWithEmbeddedKeys(ctx.licenseToken, { lastServerTime: ctx.lastServerTime });
    revoked = !!(ctx.authPkg.revocationApplies
      && ctx.authPkg.revocationApplies(ctx.revocation, verify, { userId: ctx.userId }));
    if (revoked) {
      // Sunucu bu hesabın yetkisini kapattı ve elimizdeki jeton O ANDAN ÖNCE
      // imzalanmış. Grace uygulanMAZ (grace çevrimdışı ÖDEYEN müşteri içindir),
      // eski bir license.bin yedeği geri konsa da bu dal değişmez.
      licenseStatus = 'revoked';
    } else if (verify.valid) {
      licenseStatus = verify.status; // fresh | grace
      // ADP-614: eski (crewpane.seat) VE yeni (basic/pro/ultra) modelin
      // hepsi kataloğun içindedir — her biri jetona karşı AYNI yoldan
      // (isProductEntitled: status/period_end/trial semantiği) sınanır.
      accessProducts = planCatalog
        .accessProductIds()
        .filter((productId) => ctx.authPkg.isProductEntitled(verify, productId));
      tier = planCatalog.resolveTier(accessProducts); // en yüksek rank kazanır
      seat = accessProducts.length > 0;
      products = (verify.payload.products || [])
        .filter((p) => p && p.status === 'active')
        .map((p) => p.product);
    } else {
      licenseStatus = verify.reason === 'expired_beyond_grace' ? 'expired' : 'invalid';
    }
  }
  ctx.snapshot = {
    requireSeat: ctx.requireSeat,          // kapı açık mı (bu sürümde false)
    requireLogin: ctx.requireLogin,        // ADP-520 — login duvarı açık mı (renderer gate buna bakar)
    signedIn: ctx.signedIn,
    email: ctx.email,
    userId: ctx.userId,
    licenseStatus,
    seat,                                  // CrewPane erişimi var mı (katalogdaki HERHANGİ bir ürün)
    tier: tier ? tier.id : null,          // 'basic' | 'pro' | 'ultra' | null
    tierLabel: tier ? tier.label : null,  // 'Basic' | 'Pro' | 'Ultra' | null
    tierRank: tier ? tier.rank : 0,
    // Yetenek İSKELETİ — ADP-614 hiçbir yerde ZORLAMAZ (zorlama ADP-616).
    caps: tier ? tier.caps : null,
    accessProducts,       // CrewPane erişimi veren AKTİF ürünler (çoğu zaman 1)
    products,             // jetondaki AKTİF ürünler (Pro/Ultra/Suite'te üçü birden)
    productLabels: planCatalog.productLabels(), // etiketler tek kaynaktan
    graceRemainingSeconds: verify && verify.valid && !revoked ? verify.graceRemainingSeconds : 0,
    // LIC-ENFORCE-01 — ret VERİ olarak taşınır (Ayarlar/destek "neden kapandı?"
    // sorusunu log'suz cevaplayabilsin). Metin renderer'da YAZILMAZ (denial'da).
    revocation: revoked ? { reason: ctx.revocation.reason, at: ctx.revocation.at } : null,
    billingUrl: ctx.billingUrl,           // ADP-646 — "Satın al" hedefi (renderer kapısı bunu açar)
    // SEC-01 — sunucunun cihaz kararı: { enforced, limit, active, tier, ... }
    // ya da tavan aşıldıysa { denied:true, limit, active, devices[] }.
    device: ctx.deviceInfo,
    // SEC-W2-A2 — sunucunun bütünlük reddi (karar değil, sunucunun DURUMU).
    integrityDenied: ctx.integrityDenied,
    // PAY-3 — ödeme gecikmesi SAYACI (karar değil, VERİ). `decideAccess` bunu
    // okuyup band ya da kilit üretir; damgasız satırda `since` null gelir ve
    // hiçbir şey gösterilmez (PAY-1 geri-uyumu).
    pastDue: readPastDue(
      verify,
      planCatalog.accessProductIds(),
      ctx.authPkg.PAST_DUE_GRACE_SECONDS || 3 * 24 * 60 * 60,
    ),
    // PAY-ENDED-01 — iptal SAYACI (karar değil, VERİ). `decideAccess` bunu
    // okuyup geri sayım şeridi ya da "aboneliğin bitti" kilidi üretir.
    cancelEnding: readCancelEnding(verify, planCatalog.accessProductIds()),
  };
  // ADP-646 — kapı kararı + kullanıcı metni SNAPSHOT'IN İÇİNDE: renderer kendi
  // Türkçe cümlesini kurmaz, main ne diyorsa onu basar (tek gerçek kaynak).
  const decision = decideAccess(ctx.snapshot);
  ctx.snapshot.accessAllowed = decision.allowed;
  ctx.snapshot.denial = decision.allowed ? null : {
    reason: decision.reason,
    title: decision.title,
    message: decision.message,
    action: decision.action,
    titleKey: decision.titleKey,
    messageKey: decision.messageKey,
    params: decision.params,
  };
  // PAY-3 — BAND (ret DEĞİL): erişim açıkken gösterilen uyarı şeridi.
  ctx.snapshot.notice = decision.notice || null;
  return ctx.snapshot;
}

function state(ctx) {
  return ctx.snapshot || evaluate(ctx);
}

/**
 * KAPI (ADP-646 — artık GERÇEKTEN çağrılır). Korunan her eylem bunu çağırır:
 *   const gate = seatGate.requireSeat('pty:spawn');
 *   if (!gate.allowed) throw new Error(gate.message);
 *
 * Karar `decideAccess` ile tek yerde verilir → main'in reddettiği durum ile
 * renderer'ın gösterdiği ekran ASLA ayrışamaz.
 *
 * @param {string} [action] - log/telemetri için eylem adı
 * @returns {{allowed:boolean, reason?:string, title?:string, message?:string, action?:string}}
 */
function requireSeatFor(ctx, action) {
  const s = evaluate(ctx);
  const decision = decideAccess(s);
  if (!decision.allowed) {
    ctx.log(`seatGate: ${action || 'action'} REDDEDİLDİ (${decision.reason})`);
    return decision;
  }
  if (s.requireSeat) ctx.log(`seatGate: ${action || 'action'} izinli (katman=${s.tier || 'seat'})`);
  return { allowed: true };
}

/**
 * ADP-622 — UYGULAMA DB'Sİ İÇİN KİMLİK: kullanıcının CrewPane ID **access
 * token**'ı (JWT). Tek çıkış noktası burasıdır; main bunu IPC/bridge üstünden
 * dağıtır, refresh token ve oturum dokümanı MAIN'de (safeStorage) KALIR.
 */
async function accessToken(ctx) {
  if (!ctx.signedIn) return { ok: false, reason: 'not_signed_in' };
  let session = null;
  let offline = false;
  try {
    session = await ctx.auth.getSession();
  } catch (e) {
    // Ağ hatası VE zaman aşımı (INC-20260917-02) aynı kefede: oturum KORUNUR
    // (getSession throw eder, silmez) → depodaki jetonla devam. offline ≠ çıkış.
    offline = true;
    const why = (e && e.name === 'TimeoutError') ? `zaman aşımı: ${e.message}` : e.message;
    ctx.log(`seatGate accessToken: oturum tazelenemedi (${why}) — depodaki jeton denenir`);
  }
  if (!session && offline) {
    const doc = await ctx.sessionStore.load().catch(() => null);
    session = doc && doc.session ? doc.session : null;
  }
  if (!session || typeof session.access_token !== 'string' || !session.access_token) {
    if (!offline) {
      // Sunucu refresh'i reddetti → oturum gerçekten bitti; durumu da düzelt
      ctx.signedIn = false;
      ctx.email = null;
      ctx.userId = null;
      evaluate(ctx);
      ctx.emitChange();
      return { ok: false, reason: 'session_expired' };
    }
    return { ok: false, reason: 'offline_no_token' };
  }
  return {
    ok: true,
    token: session.access_token,
    // GoTrue semantiği: EPOCH SANİYE (ms değil) — önbellekler buna göre yaşar.
    expiresAt: Number.isFinite(session.expires_at) ? session.expires_at : null,
    userId: (session.user && session.user.id) || ctx.userId || null,
  };
}

/** Oturum jetonunu veren tek okuyucu (offline'da depodaki jetona düşer). */
async function sessionAccessToken(ctx) {
  const s = await ctx.auth.getSession().catch((e) => {
    ctx.log(`seatGate sessionAccessToken: oturum tazelenemedi (${(e && e.message) || e}) — depodaki jeton denenir`);
    return null;
  });
  if (s) return s.access_token;
  const doc = await ctx.sessionStore.load().catch(() => null);
  return doc && doc.session ? doc.session.access_token : null;
}

/** Taze lisans jetonu çek. Ağ hatasında CACHED jeton KORUNUR (offline ≠ kilit). */
async function refreshLicense(ctx) {
  if (!ctx.signedIn) return { ok: false, reason: 'not_signed_in' };
  const res = await ctx.authPkg.fetchLicenseToken({
    supabaseUrl: ctx.supabaseUrl,
    apiKey: ctx.anonKey,
    // SEC-01 — cihaz kimliği isteğe binen tek yer.
    device: ctx.deviceParam(),
    // SEC-W2-A2 — paket bütünlük raporu isteğe binen tek yer.
    integrity: integrityReport(ctx),
    getAccessToken: ctx.sessionAccessToken,
  });
  if (res.ok) {
    if (typeof res.serverTime === 'number') {
      // Saat-oynatma defteri: monotonik sunucu zamanı (ADP-383).
      ctx.lastServerTime = ctx.authPkg.noteServerTime({ lastServerTime: ctx.lastServerTime }, res.serverTime).lastServerTime;
    }
    ctx.licenseToken = res.token;
    // LIC-ENFORCE-01 — sunucu KONUŞTU: kararını jetonla birlikte diske yaz.
    const verdict = revocationVerdict(ctx, res.token, res.serverTime);
    if (verdict !== undefined) {
      const was = ctx.revocation;
      ctx.revocation = verdict;
      if (ctx.revocation && (!was || was.at !== ctx.revocation.at)) {
        ctx.log(`seatGate: ⛔ sunucu erişimi KAPATTI (${ctx.revocation.reason}) — `
          + 'grace UYGULANMAZ, damga diske yazıldı');
      } else if (!ctx.revocation && was) {
        ctx.log('seatGate: erişim yeniden AÇILDI — kara-liste damgası düştü');
      }
    }
    await ctx.licenseStore.save({ token: ctx.licenseToken, lastServerTime: ctx.lastServerTime, revocation: ctx.revocation });
    // Başarıda önceki ret TEMİZLENİR
    ctx.applyDeviceInfo(res.device);
    // SEC-W2-A2 — sunucu jetonu TESLİM ETTİ: bütünlük reddi varsa DÜŞER.
    if (ctx.integrityDenied) {
      ctx.integrityDenied = false;
      ctx.log('seatGate: bütünlük reddi DÜŞTÜ — paket yeniden doğrulandı');
    }
    // SEC-02 — koltuk ELİMİZDE: kirayı düzenli tazelemeye başla.
    ctx.startHeartbeat();
    ctx.log(`seatGate: lisans jetonu tazelendi (serverTime=${res.serverTime || '-'})`);
  } else if (DEVICE_DENIALS[res.reason]) {
    ctx.deviceInfo = {
      denied: true,
      enforced: true,
      feature: DEVICE_DENIALS[res.reason],
      reason: res.reason,
      limit: res.limit,
      active: res.active,
      registered_limit: res.registeredLimit,
      registered_active: res.registeredActive,
      concurrent_limit: res.concurrentLimit,
      concurrent_active: res.concurrentActive,
      lease_minutes: res.leaseMinutes,
      tier: res.tier,
      devices: res.devices,
      actions: res.actions,
      serverMessage: res.message,
    };
    ctx.stopHeartbeat();
    ctx.log(`seatGate: CİHAZ REDDİ (${res.reason} katman=${res.tier} tavan=${res.limit} `
      + `aktif=${res.active}) — cached jeton korunuyor`);
  } else if (res.reason === 'integrity_mismatch') {
    ctx.integrityDenied = true;
    ctx.stopHeartbeat();
    ctx.log('seatGate: BÜTÜNLÜK REDDİ — sunucu paketi tanımadı, yeni jeton yok '
      + `(build=${res.buildId || '-'}) — cached jeton korunuyor`);
  } else {
    ctx.log(`seatGate: jeton tazelenemedi (${res.reason}${res.status ? ' ' + res.status : ''}) — cached jeton korunuyor`);
  }
  evaluate(ctx);
  ctx.emitChange();
  return res;
}

/** e2e dikişi (main yalnız test instance'ında dışarı açar): jeton tohumla. */
async function seedLicense(ctx, token, serverTime, stamp) {
  ctx.licenseToken = token;
  ctx.lastServerTime = typeof serverTime === 'number' ? serverTime : ctx.lastServerTime;
  if (stamp !== undefined) ctx.revocation = ctx.authPkg.normalizeRevocationStamp(stamp);
  await ctx.licenseStore.save({ token, lastServerTime: ctx.lastServerTime, revocation: ctx.revocation });
  evaluate(ctx);
  ctx.emitChange();
  return ctx.snapshot;
}

module.exports = {
  integrityReport,
  revocationVerdict,
  evaluate,
  state,
  requireSeatFor,
  accessToken,
  sessionAccessToken,
  refreshLicense,
  seedLicense,
};
