// CrewPane — Seat Gate Dunning and Cancellation Parsers.
'use strict';

/**
 * PAY-ENDED-01 — JETONDAN İPTAL DURUMUNU ÖLÇ (karar DEĞİL, VERİ).
 *
 * `readPastDue`in iptal ikizi. Sunucu ikizi `_shared/dunning.ts::cancelAccessEndsAt`
 * ile BİREBİR aynı kuraldır: ofis, tek bir satırın değil SATIRLARIN BİRLİKTE
 * kararıdır. Dört kapı da `null` döndürür ve hepsi bilerek:
 *   (a) İADE damgası (`revoked_at`) → LIC-REFUND-01 erişimi ANINDA kapatır;
 *       parası geri verilene "dönmek ister misin" demek yanlış olur.
 *   (b) `past_due` satırı → kullanıcı GECİKME zincirinin müşterisi. İki farklı
 *       hikâye ("kartın geçmedi" / "aboneliğin bitiyor") aynı anda gösterilmez.
 *   (c) İptal EDİLMEMİŞ aktif satır (ör. `plan='ltd'` ömür boyu paket) → ofis
 *       kapanmıyor, veda şeridi YALAN olurdu. PROD'da 12 böyle satır var.
 *   (d) Hiç iptal adayı yok ya da dönem sonu ölçülemiyor.
 *
 * 🔴 EN GEÇ BİTEN KAZANIR — `readPastDue`in TERSİ (orada EN ERKEN damga kazanır).
 * Gecikmede erişim İLK satır düşünce durur; iptalde SON satır bitene kadar açık
 * kalır. Aynı kuralı iki yere yazmak, kullanıcıya yanlış gün söylemenin en sessiz
 * yoluydu.
 *
 * @param {object} verify - verifyLicenseToken sonucu (valid + payload)
 * @param {string[]} productIds - CrewPane erişimi veren ürün kimlikleri
 * @returns {{periodEnd:string, daysLeft:number, ended:boolean}|null}
 */
function readCancelEnding(verify, productIds) {
  if (!verify || verify.valid !== true || !verify.payload) return null;
  const all = Array.isArray(verify.payload.products) ? verify.payload.products : [];
  const wanted = new Set(productIds || []);
  const rows = all.filter((r) => r && wanted.has(r.product));
  if (rows.length === 0) return null;
  if (rows.some((r) => r.revoked_at)) return null;                      // (a)
  if (rows.some((r) => r.status === 'past_due')) return null;           // (b)

  let latest = null;
  for (const r of rows) {
    const ends = r.cancel_at_period_end === true || r.status === 'canceled';
    if (!ends) {
      // (c) Bilinmeyen statüyü "bitiyor" saymak, ölçemediğimiz bir satır yüzünden
      // ÖDEYEN müşteriye veda postası/şeridi göstermek olurdu.
      if (r.status === 'active') return null;
      continue;
    }
    const t = r.period_end ? Date.parse(r.period_end) : NaN;
    if (!Number.isFinite(t)) continue;                                  // (d)
    if (latest === null || t > latest) latest = t;
  }
  if (latest === null) return null;

  const nowSeconds = Number.isFinite(verify.effectiveNowSeconds)
    ? verify.effectiveNowSeconds
    : Math.floor(Date.now() / 1000);
  const remaining = Math.floor(latest / 1000) - nowSeconds;
  return {
    periodEnd: new Date(latest).toISOString(),
    // `Math.floor` PARİTE: sunucu ikizi `dunning.ts::daysUntilEnd` aynı ifadeyi
    // kullanır. Yukarı yuvarlasaydık şeritte "3 gün", postada "4 gün" yazardı.
    daysLeft: Math.max(0, Math.floor(remaining / 86400)),
    ended: remaining < 0,
  };
}

/**
 * PAY-3 — JETONDAN GECİKME DURUMUNU ÖLÇ (karar DEĞİL, VERİ).
 *
 * PAY-1 sunucuda `entitlements.past_due_since` damgasını yazar ve `license-token`
 * onu jetona koyar. Burada o damga bir SAYACA çevrilir: kaç gün kaldı, doldu mu.
 *
 * Damgasız satır `null` döner (ve band ÇIKMAZ): PAY-1'in geri-uyum kuralı gereği
 * damgasız `past_due` erişim vermeye devam eder — sayacı olmayan bir band
 * "N gün kaldı" diyemez ve kullanıcıyı sebepsiz telaşlandırır.
 *
 * @param {object} verify - verifyLicenseToken sonucu (valid + payload)
 * @param {string[]} productIds - CrewPane erişimi veren ürün kimlikleri
 * @param {number} graceSeconds - `PAST_DUE_GRACE_SECONDS` (istemci ikizi sabiti)
 * @returns {{since:string|null, graceDays:number, daysLeft:number|null, expired:boolean}|null}
 */
function readPastDue(verify, productIds, graceSeconds) {
  if (!verify || verify.valid !== true || !verify.payload) return null;
  const rows = Array.isArray(verify.payload.products) ? verify.payload.products : [];
  const wanted = new Set(productIds || []);
  const pastDueRows = rows.filter((r) => r && r.status === 'past_due' && wanted.has(r.product));
  if (pastDueRows.length === 0) return null;
  const graceDays = Math.round(graceSeconds / 86400);
  // Birden çok ürün gecikmişse EN ESKİ damga kazanır: kilit hepsi için aynı gün
  // düşer, kullanıcı iki ayrı sayaç görmez.
  let oldest = null;
  for (const r of pastDueRows) {
    const t = r.past_due_since ? Date.parse(r.past_due_since) : NaN;
    if (!Number.isFinite(t)) continue;
    if (oldest === null || t < oldest) oldest = t;
  }
  if (oldest === null) {
    // Satır gecikmiş ama damgası YOK/bozuk → ölçemiyoruz (PAY-1 geri-uyumu).
    return { since: null, graceDays, daysLeft: null, expired: false };
  }
  const nowSeconds = Number.isFinite(verify.effectiveNowSeconds)
    ? verify.effectiveNowSeconds
    : Math.floor(Date.now() / 1000);
  const endsAt = Math.floor(oldest / 1000) + graceSeconds;
  const remaining = endsAt - nowSeconds;
  return {
    since: new Date(oldest).toISOString(),
    graceDays,
    daysLeft: Math.max(0, Math.floor(remaining / 86400)),
    expired: remaining < 0,
  };
}

module.exports = {
  readCancelEnding,
  readPastDue,
};
