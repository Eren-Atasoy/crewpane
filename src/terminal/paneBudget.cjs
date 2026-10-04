// CrewPane — TOK-C: PANE BÜTÇESİ + OTOMATİK DURAKLATMA (SPRINT-TOK-01)
//
// ─────────────────────────────────────────────────────────────────────────────
// NE YAPAR
// ─────────────────────────────────────────────────────────────────────────────
// Bir pane'in ÖLÇÜLEN harcaması (D-01'in okuduğu motor defteri) bir eşiği
// geçtiğinde, sistemin O PANE'E kendiliğinden iş yazmasını durdurur ve sebebini
// EKRANDA bırakır. Kullanıcı tek tıkla devam ettirir.
//
// Bu dosya SAF karardır: fs / ipc / DOM bilmez, saat bile dışarıdan gelir
// (`now`). `node --test` doğrudan koşar (paneBudget.test.cjs).
//
// ─────────────────────────────────────────────────────────────────────────────
// ÜÇ KURAL (ihlali kusurdur, tercih değil)
// ─────────────────────────────────────────────────────────────────────────────
// 1) 🔴 DAVRANIŞ KİMLİĞE DEĞİL DURUMA BAKAR. Bu modül ajan adı/id'si, departman,
//    rol GÖRMEZ — girdisi yalnız SAYI (harcanan, limit, saat). "Şu ajanı
//    duraklatma" gibi bir istisna yazılamaz, çünkü yazacak alan YOK. Kural
//    testle de sürülüyor: modülün kaynağında kimlik alanı geçemez
//    (paneBudget.test.cjs "kimlik körlüğü").
//
// 2) 🔴 ÖLÇEMEDİĞİMİZ ŞEY İÇİN DURAKLATMA YOK. Defter okunamadıysa / model
//    fiyatlanamadıysa karar `unmeasured`tır ve pane KOŞMAYA DEVAM EDER. Tahmine
//    dayanarak bir ajanı durdurmak, D-01'in "ölçemiyorsan gösterme" sözleşmesinin
//    aynı sınıftan ihlali olurdu — üstelik burada bedeli daha ağır (iş durur).
//
// 3) 🔴 SESSİZ ÖLDÜRME YOK. Karar her zaman bir `reason` + insanın okuyacağı
//    RAKAMLARI (kullanılan / limit / kaynak) taşır; çağıran onları ekrana basar.
//    "Duraklatıldı" tek başına bir cevap değildir: NEDEN, NE KADAR, NASIL DEVAM.
//
// ─────────────────────────────────────────────────────────────────────────────
// NEDEN "ÖDENEK" (allowance) VAR
// ─────────────────────────────────────────────────────────────────────────────
// "Devam et" limiti SİLMEZ, üstüne bir ÖDENEK ekler (varsayılan: limitin
// kendisi). Sebep ölçülebilir: limit silinseydi kullanıcı frenden tamamen
// çıkmış olurdu; hiçbir şey eklenmeseydi bir sonraki istekte aynı duvar geri
// gelir ve "devam" düğmesi işe yaramaz görünürdü. Ödenek, freni koruyarak
// ilerlemeye izin verir ve KAÇ KEZ devam edildiğini sayar (kart onu da yazar).
//
// ─────────────────────────────────────────────────────────────────────────────
// ÖLÇÜM KAYNAĞI — "dolar" ile "API karşılığı" AYNI ŞEY DEĞİL
// ─────────────────────────────────────────────────────────────────────────────
// Abonelikli motorda (`billing: 'subscription'`) fatura jetona göre çıkmaz →
// `session.usd` NULL, `usdEquivalent` doludur (ADP-917). Bütçe o durumda
// karşılığı kullanır ama bunu `source: 'equivalent'` diye SÖYLER; kart da öyle
// yazar. Karşılığı sessizce "harcanan para" diye göstermek, iki farklı kapsamı
// aynı sayıyla anlatan TOK-01 hatasının aynısı olurdu.

'use strict';

/** Uyarı eşiği: limitin bu oranına gelince kart sarıya döner (durdurmaz). */
const DEFAULT_WARN_RATIO = 0.8;

/** Bütçe kapalı sayılan değerler: null / 0 / negatif / sayı olmayan. */
function positiveOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Bütçe ayarını normalize eder. Bilinmeyen alanlar DÜŞER (ileride bir yerden
 * gelen `agentId`/`agentName` gibi bir alan sessizce taşınmasın — kural 1).
 *
 * @param {{usd?: number|null, tokens?: number|null, warnRatio?: number}} [cfg]
 * @returns {{usd: number|null, tokens: number|null, warnRatio: number, enabled: boolean}}
 */
function normalize(cfg = {}) {
  const usd = positiveOrNull(cfg.usd);
  const tokens = positiveOrNull(cfg.tokens);
  const ratio = typeof cfg.warnRatio === 'number' && cfg.warnRatio > 0 && cfg.warnRatio < 1 ? cfg.warnRatio : DEFAULT_WARN_RATIO;
  return { usd, tokens, warnRatio: ratio, enabled: usd !== null || tokens !== null };
}

/**
 * Ödenek defterini normalize eder: kaç kez devam edildi, ne kadar ek ödenek var.
 * @param {{usd?: number, tokens?: number, count?: number, atMs?: number|null}} [grant]
 */
function normalizeGrant(grant = {}) {
  return {
    usd: Math.max(0, positiveOrNull(grant.usd) ?? 0),
    tokens: Math.max(0, positiveOrNull(grant.tokens) ?? 0),
    count: Number.isFinite(grant.count) && grant.count > 0 ? Math.floor(grant.count) : 0,
    atMs: typeof grant.atMs === 'number' && Number.isFinite(grant.atMs) ? grant.atMs : null,
  };
}

/**
 * "Devam et" — limiti SİLMEZ, ödenek ekler (yukarıdaki gerekçe).
 *
 * 🔴 ÖDENEK AŞIMI DA KAPSAR — ölçülerek bulundu (e2e T4, ilk koşum): limit $0.05
 * iken ölçülen harcama $0.22'ydi (kullanıcı freni harcama olduktan SONRA koydu ya
 * da tek bir istek eşiği katladı). "Ödenek = limit" kuralı yeni tavanı $0.10
 * yapıyor ve pane DURAKLATILMIŞ kalıyordu: düğme "Devam et" diyor, hiçbir şey
 * devam etmiyor. Bir freni gevşetmemek için kullanıcının tıkladığı düğmeyi işe
 * yaramaz bırakmak dürüstlük değil, kusurdur.
 *
 * Kural: yeni tavan = max(eski tavan + limit, HARCANAN + limit) → her "devam"
 * ziyaretçiye EN AZ bir bütçelik gerçek pay bırakır ve fren yerinde kalır
 * (limitin kendisi hiç değişmez, sayaç artar, ikinci duvar yine gelir).
 *
 * @param {object} budget  normalize edilmiş bütçe
 * @param {object} grant   mevcut ödenek defteri
 * @param {number} nowMs
 * @param {{usd?: number|null, tokens?: number|null}} [used] ÖLÇÜLEN harcama (varsa)
 * @returns {object} yeni ödenek defteri
 */
function extend(budget, grant, nowMs, used = {}) {
  const b = normalize(budget);
  const g = normalizeGrant(grant);
  const next = (limit, cur, spent) => {
    if (limit === null) return cur;
    const ceilingByStep = limit + cur + limit; // eski tavan + bir limit daha
    const ceilingBySpend = typeof spent === 'number' && Number.isFinite(spent) ? spent + limit : 0;
    return Math.max(ceilingByStep, ceilingBySpend) - limit; // ödenek = tavan − limit
  };
  return {
    usd: next(b.usd, g.usd, used ? used.usd : null),
    tokens: next(b.tokens, g.tokens, used ? used.tokens : null),
    count: g.count + 1,
    atMs: typeof nowMs === 'number' ? nowMs : null,
  };
}

/**
 * Ölçülen harcamayı bütçeyle karşılaştırır.
 *
 * @param {object} args
 * @param {object|null} args.usage   `tokenCost.summarize()` çıktısı (ya da onun
 *                                   `{session:{...}, billing}` alt kümesi)
 * @param {object} args.budget       ayar (usd / tokens / warnRatio)
 * @param {object} [args.grant]      "devam et" ödenekleri
 * @returns {{
 *   state: 'off'|'unmeasured'|'ok'|'warn'|'paused',
 *   reason: string,
 *   metric: 'usd'|'tokens'|null,
 *   source: 'usd'|'equivalent'|'tokens'|null,
 *   used: number|null, limit: number|null, effectiveLimit: number|null,
 *   ratio: number|null, resumeCount: number, warnRatio: number
 * }}
 */
function evaluate(args = {}) {
  const budget = normalize(args.budget);
  const grant = normalizeGrant(args.grant);
  const base = {
    metric: null,
    source: null,
    used: null,
    limit: null,
    effectiveLimit: null,
    ratio: null,
    resumeCount: grant.count,
    warnRatio: budget.warnRatio,
  };

  // Bütçe kurulmamış: bu bir "sınırsız" iddiası değil, ölçülen bir AYAR yokluğu.
  if (!budget.enabled) return { ...base, state: 'off', reason: 'no-budget' };

  const usage = args.usage || null;
  const session = usage && usage.session ? usage.session : null;
  // Kural 2 — kapsamın KENDİ hükmü (TOK-01): `measured=false` ise sayı yok.
  if (!session || session.measured !== true) {
    return { ...base, state: 'unmeasured', reason: session ? session.reason || 'not-measured' : 'no-usage' };
  }

  /* Ölçülen değerler. Dolar iki kaynaktan gelebilir ve İKİSİ AYNI ŞEY DEĞİL:
     - `usd`            → gerçekten faturalanan (API kullanımı)
     - `usdEquivalent`  → abonelikte "API'de ederdi" karşılığı (ADP-917)
     Hangisi kullanıldıysa `source` onu söyler; kart da ekranda öyle yazar. */
  const usdUsed = typeof session.usd === 'number' ? session.usd : null;
  const equivUsed = typeof session.usdEquivalent === 'number' ? session.usdEquivalent : null;
  const tokensUsed = typeof session.tokens === 'number' ? session.tokens : null;

  const candidates = [];
  if (budget.usd !== null) {
    const used = usdUsed !== null ? usdUsed : equivUsed;
    const source = usdUsed !== null ? 'usd' : equivUsed !== null ? 'equivalent' : null;
    if (source) {
      candidates.push({ metric: 'usd', source, used, limit: budget.usd, effectiveLimit: budget.usd + grant.usd });
    }
  }
  if (budget.tokens !== null && tokensUsed !== null) {
    candidates.push({
      metric: 'tokens',
      source: 'tokens',
      used: tokensUsed,
      limit: budget.tokens,
      effectiveLimit: budget.tokens + grant.tokens,
    });
  }

  // Bütçe var ama ÖLÇÜLEBİLİR karşılığı yok (ör. dolar bütçesi + fiyatlanamayan
  // model). Duraklatma YOK — kural 2.
  if (candidates.length === 0) return { ...base, state: 'unmeasured', reason: 'no-priceable-metric' };

  // 🔴 EN DOLU ölçüt kazanır: iki bütçeden HANGİSİ önce dolduysa karar odur.
  // ("İlk tanımlı olan" gibi bir sıra, ikinci bütçeyi sessizce süs yapardı.)
  const scored = candidates
    .map((c) => ({ ...c, ratio: c.effectiveLimit > 0 ? c.used / c.effectiveLimit : null }))
    .sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0));
  const top = scored[0];

  const out = { ...base, ...top };
  if (top.ratio !== null && top.used >= top.effectiveLimit) {
    return { ...out, state: 'paused', reason: 'budget-exceeded' };
  }
  if (top.ratio !== null && top.ratio >= budget.warnRatio) {
    return { ...out, state: 'warn', reason: 'budget-near' };
  }
  return { ...out, state: 'ok', reason: 'within-budget' };
}

/**
 * Kapıya tek satırlık cevap: bu pane'e KENDİLİĞİNDEN iş yazılabilir mi?
 * 🔴 Yalnız `paused` engeller. `unmeasured` ENGELLEMEZ (kural 2) — ölçemediğimiz
 * bir şey yüzünden çalışan bir ajanı durdurmayız.
 */
function blocksAutomation(decision) {
  return !!decision && decision.state === 'paused';
}

module.exports = {
  DEFAULT_WARN_RATIO,
  normalize,
  normalizeGrant,
  extend,
  evaluate,
  blocksAutomation,
};
