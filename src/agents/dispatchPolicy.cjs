// TOK-B (D-03) — "SÜRDÜR mü, TAZE mi?" kararının SAF çekirdeği.
//
// TOK-OPT-01 kuralı bugüne kadar Optimus'un KAFASINDAYDI:
//   "<1h ara + ilgili iş → sürdür · >1h VEYA bağlam ≥200K VEYA ilişkisiz iş →
//    taze aç (gerekirse 1 istekle özet devri) · ≥300 istek → zorunlu tazeleme."
// Bu dosya o kuralı ÜRÜNE koyar: karar sezgiyle değil ÖLÇÜMLE (bağlam boyutu,
// boşta geçen süre, istek sayısı, işin ilişkisi) verilir ve gerekçesi taşınır.
//
// 🔴 SÖZLEŞME (D-01/D-02 ile aynı dil):
//   1. ÖLÇEMEDİĞİMİZ ŞEY İÇİN KARAR YOK. Bağlam/istek ölçülemediyse `unmeasured`
//      döner ve dağıtım bugünkü davranışını sürdürür (sessizce "taze aç" demek,
//      ölçmediğimiz bir iddiaya dayanarak canlı bağlamı YOK ETMEK olurdu).
//   2. KİMLİĞE DEĞİL DURUMA BAKAR. Girdide ajan adı/id ALANI YOKTUR; testi
//      modülün KAYNAĞINDA da kimlik dallanması arar.
//   3. EŞİKLER KODA GÖMÜLÜ DEĞİL: hepsi `modelPricing.json` →
//      `contextEconomics.dispatch` (ölçüm künyeleriyle). Sabit eksikse karar
//      ÜRETİLMEZ — varsayılan uydurmak, sessizce yanlış politikadır.
//
// ── İLİŞKİ ÖLÇÜMÜ: neden bu şekilde (kalibrasyon, D-03 raporu §2) ────────────
// "İlişkisiz iş" ölçülebilir olmalı. Ölçüm = iki iş metninin içerik-kelime
// JACCARD örtüşmesi. Gerçek transkriptlerle (596 oturum) kalibre edildi:
//   • HAM örtüşme İŞE YARAMIYOR: ilişkisiz çiftlerin %44,6'sı eşiği geçiyor —
//     çünkü BİZİM dağıtım prompt'larımızın hepsi aynı kalıp metni taşıyor
//     (KANIT ZORUNLU / HAFIZA blokları). Kalıp temizlenmeden ölçüm yalan söyler.
//   • KALIP TEMİZLİĞİ (son N dağıtım metninde belge-frekansı > %20 olan kelimeyi
//     at) + eşik 0,05 → ilgiliyi bulma %60,3 · yanlış "ilgili" %8,3.
//   • 🔴 ASİMETRİ: "ilgili" hükmü güvenilir (%8 yanlış), "İLİŞKİSİZ" hükmü
//     DEĞİL — gerçekten ilgili çiftlerin ~%40'ı eşiğin ALTINDA kalıyor (kısa
//     devam mesajları: "devam", "şimdi de X"). Bu yüzden ilişkisizlik TEK BAŞINA
//     tazeleme tetiklemez: yanında bağlam tabanı (ölçülen) şartı vardır ve
//     tazeleme DEVİR ÖZETİYLE yapılır — yanlış "ilişkisiz" hükmünün bedeli
//     bir özet isteği olur, kaybolmuş bir iş bağlamı değil.

'use strict';

/** Örtüşme ölçümüne giren en kısa kelime (kısa ekler gürültü). */
const MIN_WORD_LEN = 4;
/** Kelime deseni: yol/dosya/görev-kodu parçaları korunur (`.`, `-`, `/`, `_`). */
const WORD_RE = /[0-9a-zA-ZçğıöşüÇĞİÖŞÜ_.\-/]+/g;

/**
 * Metnin içerik-kelime kümesi (küçük harf, ≥4 karakter, tekilleştirilmiş).
 * Saf: aynı metin → aynı küme.
 * @param {string} text
 * @returns {Set<string>}
 */
function contentTokens(text) {
  const out = new Set();
  if (typeof text !== 'string' || !text) return out;
  const found = text.toLowerCase().match(WORD_RE);
  if (!found) return out;
  for (const raw of found) {
    const w = raw.replace(/^[.\-/]+/, '').replace(/[.\-/]+$/, '');
    if (w.length < MIN_WORD_LEN) continue;
    out.add(w);
  }
  return out;
}

/**
 * Kalıp (boilerplate) kelimeleri: korpustaki belgelerin `dfCut` oranından
 * fazlasında geçen kelimeler. Bizim dağıtım metinlerimizde bu, her prompt'a
 * eklenen sabit blokların ta kendisidir.
 * @param {Array<Set<string>>} corpus son N dağıtım metninin kelime kümeleri
 * @param {number} dfCut 0..1
 */
function boilerplateWords(corpus, dfCut) {
  const df = new Map();
  for (const doc of corpus) {
    for (const w of doc) df.set(w, (df.get(w) || 0) + 1);
  }
  const n = corpus.length;
  const out = new Set();
  if (!n) return out;
  for (const [w, c] of df) if (c / n > dfCut) out.add(w);
  return out;
}

/** Jaccard; taraflardan biri boşsa null (ölçülemedi). */
function jaccard(a, b) {
  if (!a.size || !b.size) return null;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter += 1;
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : null;
}

/**
 * İki iş metni İLİŞKİLİ mi? — ölçüm (kalibrasyon yukarıda).
 *
 * @param {object} input {
 *   prevText: string|null,  // pane'e EN SON dağıtılan iş
 *   nextText: string|null,  // dağıtılmak ÜZERE olan iş
 *   corpus: Array<Set<string>>, // son N dağıtım metninin kelime kümeleri
 *   cfg: { minContentTokens, minCorpusDocs, boilerplateDfCut, minOverlap }
 * }
 * @returns {{related: boolean|null, overlap: number|null, reason: string}}
 *   related=null → ÖLÇÜLEMEDİ (politika bunu "ilişkisiz" saymaz)
 */
function relatedness(input = {}) {
  const cfg = input.cfg || {};
  const minTokens = Number(cfg.minContentTokens);
  const minDocs = Number(cfg.minCorpusDocs);
  const dfCut = Number(cfg.boilerplateDfCut);
  const minOverlap = Number(cfg.minOverlap);
  if (!(minTokens > 0) || !(minDocs > 0) || !(dfCut > 0) || !(minOverlap > 0)) {
    return { related: null, overlap: null, reason: 'config-missing' };
  }
  if (typeof input.prevText !== 'string' || !input.prevText.trim()) {
    // Pane'e bu oturumda hiç iş dağıtmadık → KIYAS YOK. "İlişkisiz" DEMEYİZ.
    return { related: null, overlap: null, reason: 'no-previous-work' };
  }
  const corpus = Array.isArray(input.corpus) ? input.corpus : [];
  if (corpus.length < minDocs) {
    // Kalıbı ayıklayacak kadar örnek yok → ham örtüşme YALAN söyler (%44,6 FPR).
    return { related: null, overlap: null, reason: 'corpus-too-small' };
  }
  const common = boilerplateWords(corpus, dfCut);
  const strip = (s) => {
    const out = new Set();
    for (const w of s) if (!common.has(w)) out.add(w);
    return out;
  };
  const a = strip(contentTokens(input.prevText));
  const b = strip(contentTokens(input.nextText));
  if (a.size < minTokens || b.size < minTokens) {
    // Kalıbı atınca geriye ölçülecek içerik kalmadı (kısa "devam" mesajları).
    return { related: null, overlap: null, reason: 'too-short' };
  }
  const value = jaccard(a, b);
  if (value === null) return { related: null, overlap: null, reason: 'too-short' };
  return { related: value >= minOverlap, overlap: value, reason: 'measured' };
}

// ---------------------------------------------------------------------------
// Karar
// ---------------------------------------------------------------------------

/** `contextEconomics.dispatch` → sayısal eşikler (eksikse null = karar YOK). */
function thresholdsFrom(pricing, engine) {
  const econ = (pricing && pricing.contextEconomics) || {};
  const d = econ.dispatch || {};
  const freshCtx = Number(econ.refreshCtxThresholdTokens);
  const minRefreshCtx = Number(d.minRefreshCtxTokens);
  const requests = Number(d.mandatoryRefreshRequests);
  // Bayatlık penceresi MOTORUN ölçülmüş TTL'i (D-01 ile AYNI kaynak); ölçülmemiş
  // motorda (codex) bayatlık HÜKMÜ YOKTUR — null kalır, kural hiç tetiklenmez.
  const engineCfg = ((pricing && pricing.engines) || {})[engine || ''] || {};
  const ttl = typeof engineCfg.cacheTtlMinutes === 'number' && engineCfg.cacheTtlMinutes > 0 ? engineCfg.cacheTtlMinutes : null;
  if (!(freshCtx > 0) || !(minRefreshCtx > 0) || !(requests > 0)) return null;
  return {
    freshCtxThresholdTokens: freshCtx,
    minRefreshCtxTokens: minRefreshCtx,
    mandatoryRefreshRequests: requests,
    staleGapMinutes: ttl,
    relatedness: d.relatedness || null,
  };
}

/**
 * SÜRDÜR / TAZELE kararı — saf (Date.now YOK, kimlik YOK).
 *
 * @param {object} input {
 *   measured: boolean,          // pane'in motor defteri okunabildi mi
 *   ctxTokens: number|null,     // SON isteğin bağlamı (D-01 ile aynı tanım)
 *   idleMinutes: number|null,   // son istekten beri geçen dakika
 *   requests: number|null,      // bu oturumdaki istek sayısı (tekilleştirilmiş)
 *   related: boolean|null,      // relatedness() hükmü (null = ölçülemedi)
 *   thresholds: object|null     // thresholdsFrom()
 * }
 * @returns {{action:'continue'|'refresh'|'unmeasured', handoff:boolean,
 *            code:string, reasons:Array, measured:object, thresholds:object|null}}
 */
function decide(input = {}) {
  const th = input.thresholds || null;
  const ctx = numOrNull(input.ctxTokens);
  const idle = numOrNull(input.idleMinutes);
  const requests = numOrNull(input.requests);
  const related = input.related === true ? true : input.related === false ? false : null;
  const measured = { ctxTokens: ctx, idleMinutes: idle, requests, related };

  // Ölçüm yoksa KARAR yok (kural 1). Dağıtım bugünkü davranışını sürdürür.
  if (input.measured !== true || !th || ctx === null) {
    return {
      action: 'unmeasured',
      handoff: false,
      code: !th ? 'config-missing' : input.measured !== true ? 'ledger-unmeasured' : 'context-unmeasured',
      reasons: [],
      measured,
      thresholds: th,
    };
  }

  const reasons = [];
  const push = (code, value, threshold) => reasons.push({ code, value, threshold });

  // 1) MEGA-OTURUM FRENİ — ≥300 istek (TOK-OPT-01: 13 mega-oturum harcamanın %37'si).
  if (requests !== null && requests >= th.mandatoryRefreshRequests) {
    push('mega-session', requests, th.mandatoryRefreshRequests);
  }
  // 2) BAĞLAM EŞİĞİ — ≥200K'dan sonra taze açmak ≥4 istekte amorti eder.
  if (ctx >= th.freshCtxThresholdTokens) {
    push('context-large', ctx, th.freshCtxThresholdTokens);
  }
  // 3) BAYAT ÖNBELLEK — >TTL boşluk. 🔴 Bağlam tabanı ŞART: taban altındaki bir
  //    oturumu tazelemek KAZANDIRMAZ (taze oturumun kendi tabanı zaten ~90K;
  //    ölçüm: yeniden-ısıtma = ctx × 2× fiyat, taze ısınma medyan $0,24).
  if (th.staleGapMinutes !== null && idle !== null && idle >= th.staleGapMinutes && ctx >= th.minRefreshCtxTokens) {
    push('cache-stale', idle, th.staleGapMinutes);
  }
  // 4) İLİŞKİSİZ İŞ — yalnız ölçülmüş "ilişkisiz" hükmü + bağlam tabanı birlikte.
  //    (Kalibrasyon asimetrisi: "ilişkisiz" hükmü tek başına %40 yanılıyor.)
  if (related === false && ctx >= th.minRefreshCtxTokens) {
    push('unrelated-work', ctx, th.minRefreshCtxTokens);
  }

  if (!reasons.length) {
    return {
      action: 'continue',
      handoff: false,
      // Gerekçe sırası BAĞLAYICI olana göre: tazelemeyi asıl engelleyen şey
      // bağlamın tabanın altında olmasıysa, kullanıcıya "ilgili iş" demek
      // kararın gerçek sebebini gizlerdi.
      code: ctx < th.minRefreshCtxTokens ? 'context-small' : related === true ? 'related-and-warm' : 'within-window',
      reasons: [],
      measured,
      thresholds: th,
    };
  }
  return {
    action: 'refresh',
    // DEVİR ÖZETİ: taşınacak bağlam varsa (taban üstü) tazeleme özetle yapılır.
    // Yanlış "ilişkisiz" hükmünün sigortası da budur (bkz. başlıktaki asimetri).
    handoff: ctx >= th.minRefreshCtxTokens,
    code: reasons[0].code,
    reasons,
    measured,
    thresholds: th,
  };
}

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// ---------------------------------------------------------------------------
// Dağıtım hafızası — "bu pane'e EN SON hangi iş verildi" + kalıp korpusu
// ---------------------------------------------------------------------------

/**
 * Saf-olmayan tek parça, bilerek KÜÇÜK ve kimlik körü: yalnız paneId (adres) →
 * son dağıtılan metin, artı son N metnin kelime kümesi (kalıp ayıklaması için).
 * `create()` ile örneklenir → testler kendi örneğini kurar, global sızıntı yok.
 */
function createStore(opts = {}) {
  const window = Number(opts.corpusWindow) > 0 ? Number(opts.corpusWindow) : 50;
  const lastByPane = new Map();
  const corpus = [];
  return {
    /** Pane'e en son dağıtılan iş metni (yoksa null). */
    lastText(paneId) {
      const v = lastByPane.get(String(paneId || ''));
      return typeof v === 'string' ? v : null;
    },
    /** Dağıtım GERÇEKLEŞTİĞİNDE çağrılır: hem kıyas tabanı hem korpus beslenir. */
    record(paneId, text) {
      if (typeof text !== 'string' || !text.trim()) return;
      lastByPane.set(String(paneId || ''), text);
      const doc = contentTokens(text);
      if (doc.size) {
        corpus.push(doc);
        while (corpus.length > window) corpus.shift();
      }
    },
    /** Oturum tazelendi → kıyas tabanı düşer (yeni konuşmanın geçmişi yoktur). */
    clear(paneId) {
      lastByPane.delete(String(paneId || ''));
    },
    corpus() {
      return corpus;
    },
    size() {
      return corpus.length;
    },
  };
}

module.exports = {
  MIN_WORD_LEN,
  contentTokens,
  boilerplateWords,
  jaccard,
  relatedness,
  thresholdsFrom,
  decide,
  createStore,
};
