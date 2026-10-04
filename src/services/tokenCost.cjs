// ADP-887 — JETON → DOLAR: SAF hesap katmanı (fs YOK, ağ YOK, tarih YOK).
//
// Eren'in isteği: "hangi terminal, hangi model ne kadar tüketiyor, dolar bazında."
// Bu modülün TEK işi ölçülmüş jeton sayısını fiyat tablosuyla çarpmak. Fiyat
// `modelPricing.json`'da yaşar (tek kaynak) — burada TEK BİR rakam gömülü değildir.
//
// 🔴 DÜRÜSTLÜK SÖZLEŞMESİ (görevin kabul kriteri): bu modül "bilmiyorum"u ASLA
// 0 dolar diye döndürmez. Üç ayrı hâl vardır ve üçü de ÇAĞIRANA ayrı ayrı görünür:
//   • measured:false            → hiç ölçüm yok (defter okunamadı) → usd null
//   • billing:'subscription'    → fatura abonelikte → usd null + note
//   • priced:false              → jeton var ama fiyat bilinmiyor  → usd null + reason
// usd yalnız (ölçüm VAR) ∧ (fiyat VAR) ∧ (fatura API) iken sayıdır; 0 ancak
// gerçekten 0 jeton tüketilmişse çıkar.
//
// ── ADP-917 — İKİNCİ SAYI: `usdEquivalent` (KARŞILIK) ────────────────────────
// Eren: "118K jeton · API'de ~$2.10 ederdi · aboneliğinle karşıladın."
// `usd` = FATURA (abonelikte null kalır, sözleşme bozulmaz) · `usdEquivalent` =
// aynı jeton hacminin liste fiyatındaki KARŞILIĞI (fatura kipinden bağımsız).
// İki sayı AYRI alanlardır; çağıran birini diğerinin yerine yazamaz. Fiyat
// bilinmiyorsa karşılık da null'dur ve gerekçesi `equivalentReason`'dadır —
// fiyatsız model "$0" DEĞİL, "fiyatlanmadı" diye görünür.
//
// Tarih dışarıdan verilir (`at`) — Date.now() burada YASAK: tanıtım fiyatı
// penceresi (sonnet-5) test edilebilir olsun diye.

'use strict';

const DEFAULT_PRICING = require('../agents/modelPricing.json');

/** Tarih sonekli tam kimlik: `claude-haiku-4-5-20251001` → `claude-haiku-4-5`. */
const DATED_SUFFIX = /-\d{8}$/;

/**
 * TOK-01 — MOTORUN KENDİ FİYAT TABLOSU.
 *
 * Eskiden tabloda YALNIZ Anthropic modelleri vardı; codex `pricingTable:null` ile
 * "fiyatsız motor" işaretliydi. Sonuç Eren'in ekran kanıtıdır: gerçek bir codex
 * pane'i "1.18M jeton · +31.69M önbellek · **fiyatlanmadı**" diyordu. Jeton doğru,
 * para YOK — hem de fiyat OpenAI'nin kendi liste sayfasında dururken.
 *
 * Artık her motor KENDİ tablosuna bakabilir (`engines.<e>.pricingTable`):
 *   • `"models"` / tanımsız → kökteki Anthropic tablosu (varsayılan, eski davranış)
 *   • `"<ad>"`              → `engineTables.<ad>` (models + aliases + cacheMultipliers)
 *   • `null`                → motorun fiyatı GERÇEKTEN bilinmiyor → 'no-pricing-table'
 *
 * Dönen görünüm `pricing` ile AYNI şekildedir; normalizeModelId/priceFor/usdForUsage
 * hiç değişmeden onu kullanır (tek kod yolu — iki motor için iki hesap YOK).
 *
 * @returns {object|null} null = bu motorun fiyat tablosu yok
 */
function pricingViewFor(pricing, engine) {
  const cfg = engine ? (pricing.engines || {})[engine] : null;
  const table = cfg ? cfg.pricingTable : undefined;
  if (table === null) return null;
  if (typeof table === 'string' && table !== 'models') {
    const t = (pricing.engineTables || {})[table];
    // Tabloya İSİMLE işaret edilmiş ama tablo YOKSA sessizce Anthropic fiyatına
    // düşmek FELAKET olurdu (yanlış motorun parası). Bilinmiyor de, geç.
    if (!t) return null;
    return {
      ...pricing,
      models: t.models || {},
      aliases: t.aliases || {},
      cacheMultipliers: t.cacheMultipliers || pricing.cacheMultipliers,
      source: t.source || pricing.source,
    };
  }
  return pricing;
}

/**
 * Motorun yazdığı ham model kimliğini fiyat tablosu anahtarına çevir.
 * @returns {string|null} null = tabloda yok (çağıran "fiyat bilinmiyor" der, 0 DEMEZ)
 */
function normalizeModelId(raw, pricing = DEFAULT_PRICING) {
  if (typeof raw !== 'string') return null;
  let id = raw.trim().toLowerCase();
  if (!id) return null;
  const models = pricing.models || {};
  const aliases = pricing.aliases || {};
  if (models[id]) return id;
  if (typeof aliases[id] === 'string' && models[aliases[id]]) return aliases[id];
  // ADP-887 — sağlayıcı öneki (bedrock `anthropic.claude-opus-5`) kırpılır.
  if (id.includes('.') && id.split('.').length === 2) {
    const tail = id.split('.')[1];
    if (models[tail]) return tail;
  }
  if (DATED_SUFFIX.test(id)) {
    const trimmed = id.replace(DATED_SUFFIX, '');
    if (models[trimmed]) return trimmed;
    if (typeof aliases[trimmed] === 'string' && models[aliases[trimmed]]) return aliases[trimmed];
  }
  return null;
}

/** Ekranda gösterilecek insan-okur model adı (tabloda yoksa ham kimliğin kendisi). */
function modelLabel(rawOrKey, pricing = DEFAULT_PRICING) {
  const key = normalizeModelId(rawOrKey, pricing);
  if (key) return (pricing.models[key] && pricing.models[key].label) || key;
  return typeof rawOrKey === 'string' && rawOrKey.trim() ? rawOrKey.trim() : null;
}

/** `YYYY-MM-DD` ≤ karşılaştırması (saat dilimi tuzağı yok — düz sözlük sırası). */
function onOrBefore(dateIso, untilIso) {
  return typeof dateIso === 'string' && typeof untilIso === 'string' && dateIso <= untilIso;
}

/**
 * Bir modelin O ANDA geçerli $/1M fiyatı.
 * @param {string} rawModel motorun yazdığı kimlik
 * @param {{ at?: string, speed?: string, pricing?: object }} opts `at` = 'YYYY-MM-DD'
 * @returns {{ key, input, output, basis: 'list'|'intro'|'fast' }|null}
 */
function priceFor(rawModel, opts = {}) {
  const pricing = opts.pricing || DEFAULT_PRICING;
  const key = normalizeModelId(rawModel, pricing);
  if (!key) return null;
  const m = pricing.models[key];
  if (!m) return null;
  // Hızlı mod AYRI fiyatlıdır (Opus 5/4.8) — usage.speed'ten gelir, tahmin edilmez.
  if (opts.speed === 'fast' && m.fastMode) {
    return { key, input: m.fastMode.input, output: m.fastMode.output, basis: 'fast' };
  }
  // Tanıtım fiyatı penceresi AÇIKSA o geçerlidir; tarih kodda değil tabloda.
  if (m.introPrice && opts.at && onOrBefore(opts.at, m.introPrice.until)) {
    return { key, input: m.introPrice.input, output: m.introPrice.output, basis: 'intro' };
  }
  return { key, input: m.input, output: m.output, basis: 'list' };
}

/** Boş sayaç — toplama tarafında tek şekil (undefined aritmetiği NaN üretmesin). */
function emptyUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
  };
}

/** İki sayaç topla (saf; kaynakları değiştirmez). */
function addUsage(a, b) {
  const x = a || emptyUsage();
  const y = b || emptyUsage();
  return {
    inputTokens: (x.inputTokens || 0) + (y.inputTokens || 0),
    outputTokens: (x.outputTokens || 0) + (y.outputTokens || 0),
    cacheReadTokens: (x.cacheReadTokens || 0) + (y.cacheReadTokens || 0),
    cacheWrite5mTokens: (x.cacheWrite5mTokens || 0) + (y.cacheWrite5mTokens || 0),
    cacheWrite1hTokens: (x.cacheWrite1hTokens || 0) + (y.cacheWrite1hTokens || 0),
  };
}

/** Sayaçtaki TÜM jetonlar (fatura/sıralama tabanı — ekranda TEK BAŞINA gösterilmez). */
function totalTokens(usage) {
  const u = usage || emptyUsage();
  return (
    (u.inputTokens || 0) +
    (u.outputTokens || 0) +
    (u.cacheReadTokens || 0) +
    (u.cacheWrite5mTokens || 0) +
    (u.cacheWrite1hTokens || 0)
  );
}

// ── ADP-924 — "GERÇEK İŞ" ↔ "ÖNBELLEK OKUMA" AYRIMI ─────────────────────────
//
// Eren 2 basit komut yazdı, kart "133K jeton / TÜM OTURUMLAR 2.69M" dedi. Sezgisi
// doğruydu: `totalTokens` beşini de topluyor ve toplamın büyük çoğunluğu
// `cacheReadTokens` — Claude Code'un HER TURDA aynı geçmiş bağlamı önbellekten
// yeniden okuması. Bu sayı turlar boyunca KÜMÜLATİF katlanır (aynı 100K bağlam
// 50 turda 5M "jeton" gibi görünür) ama YENİ İŞ DEĞİLDİR.
//
// ÖLÇÜLDÜ (bu makinenin gerçek `~/.claude` defterleri, son 14 oturum): toplam
// 268.464.633 jetonun 261.086.838'i (%97,3) cache_read. Gerçek iş yalnız %2,7.
//
// Anthropic'in kendi modeli de bu ayrımı yapar (prompt-caching dokümanı):
//   total_input = cache_read_input_tokens + cache_creation_input_tokens + input_tokens
//   • `input_tokens`  → önbellekten OKUNMAYAN/önbelleğe YAZILMAYAN artık
//   • `cache_creation`→ bağlama YENİ giren içerik (1.25×/2× — pahalı, yeni iştir)
//   • `cache_read`    → daha önce işlenmiş içeriğin tekrarı (0.1× — yeni DEĞİL)
//
// 🔴 Ama "cache'i toplamdan tamamen çıkarmak" da yanlış cevap (Claude Code'un
// kendi #22537 hatası: /stats cache'i dışlayınca kullanım ~1000× eksik okundu).
// Doğru cevap GİZLEMEK değil AYIRMAK: iki ayrı, ADI FARKLI alan. `totalTokens`
// sözleşmesi DOKUNULMADAN durur (dolar hesabı ve sıralama onu kullanmaya devam
// eder — dolar zaten DOĞRUYDU, `cacheMultipliers.read=0.1` uygulanıyor).
//
// ── ADP-929 — SINIR BİR ADIM DAHA KAYDI: `cache_creation` DA ÖNBELLEKTİR ────
//
// ADP-924 `cache_creation`'ı (önbelleğe YAZILAN içerik) "yeni iş" tarafında
// bırakmıştı; gerekçe fiyattı (1.25×/2× — okumadan pahalı). Gerçek kullanımda
// ÖLÇÜLDÜ ki bu, kullanıcının sorduğu soruyu hâlâ cevaplamıyor: Eren üç kez
// "merhaba" yazdı, kart "12K jeton" dedi (Claude Code'un kendi göstergesi aynı
// turlar için yüzlerce jeton diyordu). Defter (2026-08-06, oturum 5dcfc7ca):
//
//   input 6 · output 412 · cache_creation 11.189 · cache_read 84.472
//   ADP-924 "gerçek iş" = 11.607  →  bunun **%96,4'ü** cache_creation.
//
// O 11.189 jeton kullanıcının yazdığı şey DEĞİL: sistem promptu + araç tanımları
// oturum açılırken bir kez önbelleğe yazılıyor. Kullanıcı "merhaba" yazınca da,
// 300 satır kod yazdırınca da orada duruyor → sayı YAPILAN İŞLE değil ALTYAPIYLA
// ölçekleniyor. Aynı sınıf hata, farklı alan (bkz. yukarıdaki "kümülatif tekrar"
// tespiti): bir alanı "iş" saymadan önce sor — *kullanıcı bu jetonu ısmarladı mı?*
//
// ⇒ Sınır artık **kullanıcının turu** ile **önbellek altyapısı** arasında:
//   • `newTokens`   = input + output                     → GERÇEK İŞ (birincil sayı)
//   • `cacheTokens` = cacheRead + cacheWrite5m + 1h      → ÖNBELLEK (ayrı satır)
// Yazma/okuma kırılımı SİLİNMEZ (`cacheWriteTokens`/`cacheReadOnlyTokens` ile
// ekrana ipucu olarak çıkar) ve `tokens` (hepsi) yine dokunulmadan durur — dolar
// beş alandan hesaplanmaya devam eder, yani bu ayrım PARAYI DEĞİŞTİRMEZ.

/** GERÇEK İŞ: kullanıcının bu turda ısmarladığı jeton — girdi + çıktı. */
function newWorkTokens(usage) {
  const u = usage || emptyUsage();
  return (u.inputTokens || 0) + (u.outputTokens || 0);
}

/** ÖNBELLEK YAZMA: sistem promptu/araç tanımlarının önbelleğe alınması (1.25×/2×). */
function cacheWriteTokens(usage) {
  const u = usage || emptyUsage();
  return (u.cacheWrite5mTokens || 0) + (u.cacheWrite1hTokens || 0);
}

/** ÖNBELLEK OKUMA: aynı geçmişin tekrar okunması — yeni iş değil, 0.1× fiyatlı. */
function cacheReadTokens(usage) {
  const u = usage || emptyUsage();
  return u.cacheReadTokens || 0;
}

/** ÖNBELLEK (ADP-929): yazma + okuma — ikisi de altyapı, kullanıcının işi değil. */
function cacheAllTokens(usage) {
  return cacheWriteTokens(usage) + cacheReadTokens(usage);
}

/**
 * Sayaç × fiyat → dolar. Önbellek fiyatı AYRI bir sayı değil, girdi fiyatının
 * katıdır (modelPricing.cacheMultipliers) — taban fiyat değişince kendiliğinden
 * doğru kalır.
 * @returns {{ usd:number, parts:{input:number,output:number,cacheRead:number,cacheWrite:number} }}
 */
function usdForUsage(usage, price, pricing = DEFAULT_PRICING) {
  const u = usage || emptyUsage();
  const mult = pricing.cacheMultipliers || { read: 0.1, write5m: 1.25, write1h: 2.0 };
  const perToken = (perMillion) => perMillion / 1_000_000;
  const parts = {
    input: (u.inputTokens || 0) * perToken(price.input),
    output: (u.outputTokens || 0) * perToken(price.output),
    cacheRead: (u.cacheReadTokens || 0) * perToken(price.input * mult.read),
    cacheWrite:
      (u.cacheWrite5mTokens || 0) * perToken(price.input * mult.write5m) +
      (u.cacheWrite1hTokens || 0) * perToken(price.input * mult.write1h),
  };
  return { usd: parts.input + parts.output + parts.cacheRead + parts.cacheWrite, parts };
}

/**
 * Bir modelin tek satırlık maliyet hükmü — DÜRÜSTLÜK SÖZLEŞMESİNİN uygulandığı yer.
 *
 * @param {object} row { model, usage, speed? }
 * @param {object} opts { billing:'subscription'|'api'|'unknown', at, pricing, engine }
 * @returns {{
 *   model:string|null, label:string|null, usage:object, tokens:number,
 *   usd:number|null, priced:boolean, basis:string|null, reason:string|null
 * }}
 */
function costForModel(row, opts = {}) {
  const pricing = opts.pricing || DEFAULT_PRICING;
  const usage = row && row.usage ? row.usage : emptyUsage();
  const tokens = totalTokens(usage);
  // ADP-924/929 — aynı sayacın İKİ okunuşu; `tokens` (hepsi) dokunulmadan kalır.
  const newTokens = newWorkTokens(usage);
  const cacheTokens = cacheAllTokens(usage);
  // Önbellek içindeki yazma/okuma kırılımı: ayrım hiçbir şeyi SİLMESİN diye
  // ekrana ipucu (title) olarak taşınır.
  const cacheWrite = cacheWriteTokens(usage);
  const cacheRead = cacheReadTokens(usage);
  // TOK-01 — etiket de MOTORUN tablosundan okunur (gpt-5.6-sol "Sol" diye görünür).
  const view = pricingViewFor(pricing, opts.engine);
  const label = modelLabel(row && row.model, view || pricing);

  // ── 1) KARŞILIK (ADP-917) — "API'de ne ederdi": fatura kipinden BAĞIMSIZ. ──
  //
  // Eren: "118K jeton · API'de ~$2.10 ederdi · aboneliğinle karşıladın."
  //
  // 🔴 KARŞILIK ≠ FATURA. `usdEquivalent` bir tahakkuk DEĞİL, jeton hacminin
  // liste fiyatı üzerinden ÖLÇÜLMÜŞ karşılığıdır — abonelikte de hesaplanır,
  // çünkü orada sorulan soru "ne ödedim" değil "ne kadar değer kullandım".
  // Faturaya dönüşen sayı AYRI alanda (`usd`) durur ve abonelikte null KALIR:
  // ADP-887'nin dürüstlük sözleşmesi (sahte fatura yasak) korunuyor, üstüne
  // ölçülebilir bir karşılık ekleniyor.
  let equivalent = null;
  let equivalentReason = null;
  let basis = null;
  let rate = null;
  let parts = null;
  if (!view) {
    // Motorun fiyat tablosu YOK → karşılık UYDURULAMAZ.
    equivalentReason = 'no-pricing-table';
  } else {
    const price = priceFor(row && row.model, { at: opts.at, speed: row && row.speed, pricing: view });
    if (!price) {
      // Model tabloda yok → "fiyatlanmadı" (asla 0). Motorun tablosu VAR ama bu
      // model onda yok: jeton sayısı yine DOĞRUDUR, eksik olan yalnız fiyattır.
      equivalentReason = 'model-not-priced';
    } else {
      const r = usdForUsage(usage, price, view);
      equivalent = r.usd;
      parts = r.parts;
      basis = price.basis;
      rate = { input: price.input, output: price.output };
    }
  }

  const base = {
    model: (row && row.model) || null,
    label,
    usage,
    tokens,
    newTokens,
    cacheTokens,
    cacheWriteTokens: cacheWrite,
    cacheReadOnlyTokens: cacheRead,
    usd: null,
    priced: false,
    basis,
    reason: null,
    usdEquivalent: equivalent,
    equivalentReason,
    ...(parts ? { parts } : {}),
    ...(rate ? { rate } : {}),
  };

  // ── 2) FATURA — `usd` yalnız GERÇEKTEN tahakkuk eden tutardır. ─────────────
  // Abonelik: jetonu (ve karşılığı) göster, FATURA gösterme.
  if (opts.billing === 'subscription') return { ...base, reason: 'subscription' };
  // Fatura kipi bilinmiyor → uydurma yok.
  if (opts.billing !== 'api') return { ...base, reason: 'billing-unknown' };
  // Fiyat yoksa fatura da yazılamaz (karşılığın gerekçesi faturanınkiyle aynıdır).
  if (equivalentReason) return { ...base, reason: equivalentReason };
  return { ...base, usd: equivalent, priced: true };
}

// ── TOK-A — "BU OTURUMU TAZELEMEK NE KAZANDIRIR?" ────────────────────────────
//
// TOK-OPT-01 gerçek defterlerle ÖLÇTÜ (~115K istek): faturanın %63,4'ü aynı
// bağlamın HER TURDA yeniden okunması (cache_read) ve istek başına maliyet oturum
// derinleştikçe büyüyor — ilk 25 istekte $0.093, 300. istekte $0.271. Yani "büyük
// oturumda devam etmek" görünmez bir vergi ödüyor. İkinci ölçüm daha da keskin:
// önbellek penceresi 1 SAAT ve >1h boşluktan sonra dönen ilk istek bağlamın
// TAMAMINI 2× yazma fiyatıyla yeniden ısıtıyor (437 olay = $1.894; medyan $3.45).
//
// Kart bu iki gerçeği zaten TAŞIYABİLİYORDU (son isteğin bağlamı + zamanı
// defterde var) ama SÖYLEMİYORDU. Bu fonksiyon o iki satırı üretir:
//   1) tazeleme kazancı  — istek başına ~$X + ısınma ~$Y + ~N istekte amorti
//   2) bayat-önbellek    — pencere kapandıysa devamın ödeyeceği yeniden-ısıtma
//
// 🔴 DÜRÜSTLÜK (bu dosyanın sözleşmesi): tek bir dolar UYDURULMAZ. Sabitler
// jetondur (modelPricing.contextEconomics, ölçümle geldi), dolara çevirmek için
// SON İSTEĞİN modelinin gerçek fiyatı kullanılır. Fiyat bilinmiyorsa, bağlam
// ölçülemediyse ya da motorun önbellek penceresi ölçülmemişse → null / gösterme.

// ── TOK-R1 — "BAĞLAM" ≠ "BU OTURUM" (Eren'in 241K ⟂ 531.6K vakası) ─────────
//
// MÜŞTERİ VAKASI (2026-08-18 ~11:15, screenshot): Claude'un kendi satırı
// "/clear to save 531.6k tokens" derken kartın en büyük rakamı "241K" diyordu —
// 2,20× ayrışma. İKİSİ DE DOĞRUYDU, farklı şeyleri sayıyorlardı:
//
//   kart  → `session.newTokens` = Σ(input + output)  ... oturum boyunca BİRİKMİŞ İŞ
//   Claude→ son isteğin BAĞLAMI  = input + cache_read + cache_write ... ŞU ANKİ pencere
//
// ÖLÇÜLDÜ (bu makinenin gerçek defterleri, 2026-08-18 11:20, 6 canlı worker pane'i):
//
//   pane-72 optimus    iş 112.412 · bağlam 298.439 → 2,65×   (100 istek)
//   pane-80 blaster    iş 128.479 · bağlam 344.512 → 2,68×   (164 istek)
//   pane-84 inferno    iş  85.770 · bağlam 293.574 → 3,42×   (141 istek)
//   pane-85 ironhide   iş 100.134 · bağlam 280.647 → 2,80×   (125 istek)
//   pane-86 perceptor  iş  22.637 · bağlam 116.484 → 5,15×   ( 44 istek)
//   pane-87 wheeljack  iş  16.133 · bağlam 133.895 → 8,30×   ( 52 istek)
//
// Eren'in 2,20×'i bu bandın tam içinde ⇒ sapma DEĞİL, TANIM farkı. Ama kart
// kullanıcının sorduğu soruyu ("bu pane'i temizlersem ne kazanırım") hiç
// cevaplamıyordu: bağlam rakamı YALNIZ `refresh` içinde ve YALNIZ bir `title`
// ipucunda yaşıyordu — üstelik `refresh` fiyat bilinmiyorsa komple null oluyor.
// Bu blok bağlamı FİYATTAN BAĞIMSIZ, kendi adıyla dışarı verir; `refresh` (dolar
// hükmü) aynen kalır. Ölçülemezse null — 0 BASILMAZ (bu dosyanın sözleşmesi).

/**
 * TOK-R1 — pane'in ŞU ANKİ bağlamı (son isteğin girdi + önbellek toplamı).
 * `/clear` bunu düşürür; `session.newTokens` (birikmiş iş) düşmez.
 * @returns {{tokens:number, tokensText:string, atMs:number|null, model:string|null}|null}
 */
function contextNow(lastRequest) {
  const last = lastRequest;
  if (!last || typeof last.ctxTokens !== 'number' || !(last.ctxTokens > 0)) return null;
  return {
    tokens: last.ctxTokens,
    tokensText: formatTokens(last.ctxTokens),
    atMs: typeof last.atMs === 'number' ? last.atMs : null,
    model: typeof last.model === 'string' ? last.model : null,
  };
}

/**
 * Son isteğin bağlamı + boşta geçen süre → tazeleme ipucu (saf; Date.now YOK).
 *
 * @param {object} input {
 *   lastRequest: { atMs:number, ctxTokens:number, model:string, speed?:string },
 *   nowMs: number, engine?: string, pricing?: object, at?: string
 * }
 *   `ctxTokens` = son isteğin girdi + önbellek okuma + önbellek yazma toplamı,
 *   yani BİR SONRAKİ isteğin yeniden okuyacağı/yazacağı bağlam.
 * @returns {object|null} null = ölçülemedi (kart HİÇBİR ŞEY göstermez)
 */
function refreshHint(input = {}) {
  const pricing = input.pricing || DEFAULT_PRICING;
  const last = input.lastRequest;
  const nowMs = typeof input.nowMs === 'number' && Number.isFinite(input.nowMs) ? input.nowMs : null;
  if (!last || typeof last.ctxTokens !== 'number' || !(last.ctxTokens > 0)) return null;
  // Fiyat YOKSA dolar da yok — "tazele, ~$? kazanırsın" satırı anlamsızdır.
  const view = pricingViewFor(pricing, input.engine || null);
  if (!view) return null;
  const price = priceFor(last.model, { at: input.at, speed: last.speed, pricing: view });
  if (!price) return null;

  const econ = pricing.contextEconomics || {};
  const baseline = Number(econ.freshBaselineCtxTokens);
  const warmupTokens = Number(econ.freshWarmupWriteTokens);
  const threshold = Number(econ.refreshCtxThresholdTokens);
  // Ölçüm sabitleri eksikse ipucu ÜRETİLMEZ (varsayılan uydurmak = sahte tavsiye).
  if (!(baseline >= 0) || !(warmupTokens > 0) || !(threshold > 0)) return null;

  const mult = view.cacheMultipliers || pricing.cacheMultipliers || { read: 0.1, write5m: 1.25, write1h: 2.0 };
  const perToken = price.input / 1_000_000;
  const ctx = last.ctxTokens;

  // (1) İSTEK BAŞINA KAZANÇ: taze oturumda bu bağlamın FAZLASI okunmaz.
  // Her tur ctx kadar jeton 0.1× fiyatla yeniden okunuyor; taze oturum tabanı
  // (ölçülen medyan 90K) yine okunacak → kazanç yalnız ARADAKİ fark.
  const savePerRequest = Math.max(0, ctx - baseline) * mult.read * perToken;
  // (2) ISINMA: taze oturumun ilk isteği sistem promptu + araç tanımlarını
  // önbelleğe YAZAR. Ölçülen medyan 22.786 jeton, 1 saatlik yazma çarpanıyla.
  const warmupUsd = warmupTokens * mult.write1h * perToken;
  const amortizeRequests = savePerRequest > 0 ? Math.ceil(warmupUsd / savePerRequest) : null;
  // (3) YENİDEN-ISITMA: pencere kapandıysa devam eden ilk istek bağlamın
  // TAMAMINI 2× yazma fiyatıyla yeniden yazar (TOK-OPT-01'de medyan 252K jeton).
  const rewarmUsd = ctx * mult.write1h * perToken;

  // Önbellek penceresi MOTORUN ölçülmüş değeri; ölçülmediyse bayatlık HÜKMÜ YOK
  // (null ≠ false: "taze" demek de bir iddia olurdu).
  const engineCfg = (pricing.engines || {})[input.engine || ''] || {};
  const ttlMinutes = typeof engineCfg.cacheTtlMinutes === 'number' && engineCfg.cacheTtlMinutes > 0
    ? engineCfg.cacheTtlMinutes
    : null;
  const idleMs = nowMs !== null && typeof last.atMs === 'number' ? Math.max(0, nowMs - last.atMs) : null;
  const idleMinutes = idleMs === null ? null : Math.floor(idleMs / 60_000);
  const stale = ttlMinutes === null || idleMinutes === null ? null : idleMinutes >= ttlMinutes;

  return {
    ctxTokens: ctx,
    ctxTokensText: formatTokens(ctx),
    model: last.model || null,
    modelLabel: modelLabel(last.model, view),
    basis: price.basis,
    idleMinutes,
    ttlMinutes,
    stale,
    savePerRequestUsd: savePerRequest,
    savePerRequestUsdText: formatUsd(savePerRequest),
    warmupUsd,
    warmupUsdText: formatUsd(warmupUsd),
    rewarmUsd,
    rewarmUsdText: formatUsd(rewarmUsd),
    amortizeRequests,
    // Kartın iki satırının HÜKMÜ burada (eşik ölçümden gelir, JSX'te değil):
    // kazanç satırı ancak bağlam ölçülen eşiği geçtiyse ve kazanç POZİTİFse.
    showSaving: ctx >= threshold && savePerRequest > 0 && amortizeRequests !== null,
    showStale: stale === true,
    thresholdTokens: threshold,
    baselineTokens: baseline,
    warmupTokens,
  };
}

/**
 * Pane kartının TAM verisi: bu oturum + toplam + model kırılımı.
 *
 * @param {object} input {
 *   engine, billing, models: [{model, usage, speed?}], totalModels?: [...],
 *   measured: boolean, at
 * }
 *   `models`      → BU oturum (pane'in şu anki konuşması)
 *   `totalModels` → TÜM oturumlar (aynı cwd/motor geçmişi); verilmezse session=total
 */
function summarize(input = {}) {
  const pricing = input.pricing || DEFAULT_PRICING;
  const at = input.at || null;
  const engine = input.engine || null;
  const billing = input.billing || 'unknown';
  const measured = input.measured === true;

  // ── TOK-01 — KAPSAM BAŞINA ÖLÇÜM HÜKMÜ ──────────────────────────────────────
  //
  // `measured` tek bir bayraktı ve iki kapsamın (BU OTURUM · TÜM OTURUMLAR) VEYA'sı
  // olarak hesaplanıyordu. Defteri bulunamayan bir OTURUM, toplam okunabildiği için
  // "ölçüldü" sayılıyor ve ekranda `0` yazıyordu — kullanıcı bunu "hiç jeton yakmadım"
  // diye okuyor, sayı da hiç değişmediği için "SABİT KALIYOR" diye bildiriyordu.
  // Artık her kapsam kendi `measured` + `reason`ını taşır; ölçülemeyen kapsam sayı
  // DEĞİL gerekçe gösterir (`0` yalnız gerçekten 0 jetonda çıkar).
  const roll = (rows, scopeMeasured, scopeReason) => {
    const list = (Array.isArray(rows) ? rows : [])
      .map((r) => costForModel(r, { billing, at, pricing, engine }))
      // Sıfır jetonlu satır ekranda gürültüdür (eski/boş defter artığı) — düşür.
      .filter((r) => r.tokens > 0)
      // Biçimlendirme MAIN'de yapılır: renderer para/jeton biçimini KOPYALAMASIN
      // (iki yerde biçim = sessiz sapma). Tek kaynak burasıdır.
      .map((r) => ({
        ...r,
        tokensText: formatTokens(r.tokens),
        // ADP-924/929 — model satırı da AYRIMI taşır (kart ile aynı dilbilgisi).
        newTokensText: formatTokens(r.newTokens),
        cacheTokensText: formatTokens(r.cacheTokens),
        cacheWriteTokensText: formatTokens(r.cacheWriteTokens),
        cacheReadOnlyTokensText: formatTokens(r.cacheReadOnlyTokens),
        usdText: formatUsd(r.usd),
        // ADP-917 — karşılık metni de BURADA üretilir (renderer biçim kopyalamaz).
        usdEquivalentText: formatUsd(r.usdEquivalent),
      }));
    const tokens = list.reduce((n, r) => n + r.tokens, 0);
    // ── ADP-956 — DOLARIN KIRILIMI: "31K önbellek ama sadece $0.02" ──────────
    //
    // Eren sordu: 31K önbelleğin ne kadarı okuma, ne kadarı yazma — ve $0.02'yi
    // hangi kalem şişiriyor? Kart bunu SÖYLEYEMİYORDU: jeton kırılımı vardı
    // (yazma/okuma), ama PARANIN kırılımı yalnızca model satırının `parts`ında
    // duruyordu ve roll-up onu DÜŞÜRÜYORDU. Sonuç: iki sayı yan yana duruyor,
    // aralarındaki bağ görünmüyor.
    //
    // ÖLÇÜLDÜ (gerçek defter, oturum 5d395bdb, claude-haiku-4-5):
    //   önbellek 30.894 = okuma 22.035 (%71,3) + yazma 8.859 (%28,7)
    //   fatura   $0,021246 = yazma $0,017718 (%83,4) + okuma $0,002204 (%10,4)
    //                      + çıktı $0,001315 (%6,2) + girdi $0,000010
    // ⇒ Jetonun %28,7'si paranın %83,4'ü. Sebep: 1 saatlik yazma çarpanı 2,0× —
    //   okumanın (0,1×) YİRMİ KATI. Bu ters-orantı kartta görünmeden "31K → $0.02"
    //   hep tuhaf görünür; görününce aritmetik kendini açıklar.
    //
    // 🔴 ÖLÇÜLDÜ (215.624 satır, ~/.claude defterlerinin TAMAMI): gerçek
    // `cache_creation`'ın **%100'ü 1 SAATLİK** (1.257.805.432 jeton; 5dk = 0).
    // Yani pahalı çarpan istisna değil, KURAL — kırılımı göstermek şart.
    //
    // 📐 Dolar DOĞRUYDU ve burada değişmiyor: bu blok yalnızca zaten hesaplanmış
    // `parts`ı toplar (türetme/yeniden-hesap YOK). Fiyatı bilinmeyen satır
    // `parts` taşımaz → toplama hiç girmez, yani "bilmiyorum" 0$ diye görünmez.
    const priceable = list.filter((r) => r.parts);
    const costParts = priceable.length
      ? priceable.reduce(
          (acc, r) => ({
            input: acc.input + r.parts.input,
            output: acc.output + r.parts.output,
            cacheRead: acc.cacheRead + r.parts.cacheRead,
            cacheWrite: acc.cacheWrite + r.parts.cacheWrite,
          }),
          { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        )
      : null;
    // Faturayı EN ÇOK şişiren kalem (pay = o kalemin toplam içindeki oranı).
    // Toplam 0 ise pay hesaplanamaz → sürücü de yok (0'a bölme yok).
    let costDriver = null;
    if (costParts) {
      const sum = costParts.input + costParts.output + costParts.cacheRead + costParts.cacheWrite;
      if (sum > 0) {
        const [key, usd] = Object.entries(costParts).sort((a, b) => b[1] - a[1])[0];
        costDriver = { key, usd, share: usd / sum };
      }
    }
    // ADP-924 — kapsamın iki okunuşu; toplamları AYRI toplanır (türetme yok:
    // `tokens - cacheTokens` yazsaydım filtrelenen satırlar sessizce sapardı).
    const newTokens = list.reduce((n, r) => n + r.newTokens, 0);
    const cacheTokens = list.reduce((n, r) => n + r.cacheTokens, 0);
    const cacheWrite = list.reduce((n, r) => n + r.cacheWriteTokens, 0);
    const cacheReadOnly = list.reduce((n, r) => n + r.cacheReadOnlyTokens, 0);
    // 🔴 usd toplamı: fiyatlı satır YOKSA null (0 yazmak yalan olur).
    const priced = list.filter((r) => r.priced);
    const usd = priced.length ? priced.reduce((n, r) => n + r.usd, 0) : null;
    // ADP-917 — KARŞILIK toplamı: fiyatı BİLİNEN satırların "API'de ederdi" toplamı.
    // Hiçbiri bilinmiyorsa null → ekran "fiyatlanmadı" der, 0$ DEMEZ.
    const equiv = list.filter((r) => typeof r.usdEquivalent === 'number');
    const usdEquivalent = equiv.length ? equiv.reduce((n, r) => n + r.usdEquivalent, 0) : null;
    // Karşılık KISMİ mi? (bazı satır fiyatlı, bazısı değil) → ekran "eksik" desin.
    const equivalentPartial = equiv.length > 0 && equiv.length < list.length;
    // Kısmi fiyatlama şeffaf: bazı satırlar fiyatlanamadıysa çağıran bilsin.
    // 🪤 E2E'de görüldü: abonelik kartında "N model fiyatlanamadı — toplam EKSİK"
    // yazıyordu. Orada eksik bir şey YOK — dolar göstermemek TASARIM. Uyarı yalnız
    // BEKLENMEDİK fiyatsızlık için (tabloda olmayan model / fiyatsız motor).
    const unpriced = list.filter((r) => !r.priced && r.tokens > 0 && r.reason !== 'subscription').length;
    return {
      models: list,
      // Kapsamın kendi hükmü. Çağıran (kart) bu bayrağa bakar: false ise SAYI
      // BASMAZ, `reason`u yazar. Verilmediyse kartın genel `measured`ına düşer —
      // eski çağıranlar (testler/e2e) davranış değişikliği görmez.
      measured: typeof scopeMeasured === 'boolean' ? scopeMeasured : measured,
      reason: scopeReason || null,
      tokens,
      newTokens,
      cacheTokens,
      cacheWriteTokens: cacheWrite,
      cacheReadOnlyTokens: cacheReadOnly,
      usd,
      unpricedModels: unpriced,
      usdEquivalent,
      equivalentPartial,
      tokensText: formatTokens(tokens),
      newTokensText: formatTokens(newTokens),
      cacheTokensText: formatTokens(cacheTokens),
      cacheWriteTokensText: formatTokens(cacheWrite),
      cacheReadOnlyTokensText: formatTokens(cacheReadOnly),
      usdText: formatUsd(usd),
      usdEquivalentText: formatUsd(usdEquivalent),
      // ADP-956 — paranın kırılımı (ham + biçimli). Fiyatsızsa null KALIR.
      costParts,
      costDriver,
      costPartsText: costParts
        ? {
            input: formatUsd(costParts.input),
            output: formatUsd(costParts.output),
            cacheRead: formatUsd(costParts.cacheRead),
            cacheWrite: formatUsd(costParts.cacheWrite),
          }
        : null,
    };
  };

  const session = roll(input.models, input.sessionMeasured, input.sessionReason);
  const total = input.totalModels
    ? roll(input.totalModels, input.totalMeasured, input.totalReason)
    : session;

  return {
    engine,
    engineLabel: (pricing.engines && pricing.engines[engine] && pricing.engines[engine].label) || engine,
    billing,
    measured,
    at,
    // CDX-TOKEN-03 — kaynak etiketi MOTORUN tablosundan (BUG-R3 #6: GPT kırılımlı
    // kartta "Anthropic platform pricing" yazıyordu; sayı doğru, etiket yanlıştı).
    // Tablosu bilinmeyen motorda (view=null) kaynak UYDURULMAZ.
    priceSource: (() => {
      const view = pricingViewFor(pricing, engine);
      return view ? view.source || null : null;
    })(),
    session,
    total,
    // TOK-A — tazeleme ipucu: SON İSTEK ölçülemediyse null (kart hiç göstermez).
    refresh: refreshHint({ lastRequest: input.lastRequest, nowMs: input.nowMs, engine, pricing, at }),
    // TOK-R1 — ŞU ANKİ BAĞLAM (`/clear`in düşüreceği rakam). `refresh`ten AYRI:
    // o fiyat bilinmezse komple null olur, bu ölçüm fiyattan bağımsızdır.
    context: contextNow(input.lastRequest),
  };
}

/** Ekran biçimi: küçük tutarlar 0.00 diye görünmesin (yalan izlenim). */
function formatUsd(usd) {
  if (typeof usd !== 'number' || !Number.isFinite(usd)) return null;
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  if (usd < 1000) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd).toLocaleString('en-US')}`;
}

/**
 * Ekran biçimi: 1.234.567 → "1.23M".
 *
 * ── ADP-917 (bağımsız doğrulama turu) — MERDİVEN "M"DE BİTMEZ ────────────────
 * GERÇEK defterle ölçüldü (fikstürler bu bölgeye hiç girmiyordu): bu makinedeki
 * "tüm oturumlar" toplamı 5.306.412.560 jeton → eski kod bunu **"5306.41M"** diye
 * yazıyordu. 276px'lik kartın ikincil satırında bu hem okunmuyor hem "M" birimi
 * yanıltıyordu. Milyar basamağı gerçek kullanımda BUGÜN var → 'B' basamağı eklendi.
 *
 * 🪤 İkinci kusur YUVARLAMA TERFİSİ: 999.999 → `(n/1000).toFixed(0)` = **"1000K"**
 * (bir üst birim dururken). Artık yuvarlanmış değer 1000'e ulaşırsa bir üst birime
 * terfi eder → "1.00M".
 */
function formatTokens(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '—';
  if (n < 1000) return String(n);
  // Ondalık basamak birime göre: K'da 10'un altında 1 hane bilgi taşır, üstünde
  // gürültüdür; M/B'de iki hane (0.01M = 10K çözünürlük) okunur kalır.
  const UNITS = [
    { div: 1e3, suffix: 'K' },
    { div: 1e6, suffix: 'M' },
    { div: 1e9, suffix: 'B' },
  ];
  for (let i = 0; i < UNITS.length; i += 1) {
    const { div, suffix } = UNITS[i];
    const v = n / div;
    const text = v.toFixed(suffix === 'K' ? (v < 10 ? 1 : 0) : 2);
    // Üst birim VARSA ve yuvarlama 1000'e vardıysa oraya terfi et ("1000K" YASAK).
    if (i < UNITS.length - 1 && Number(text) >= 1000) continue;
    return `${text}${suffix}`;
  }
  // Merdivenin sonu: 1000B üstü (bugün ulaşılamaz) yine 'B' ile yazılır.
  return `${(n / 1e9).toFixed(2)}B`;
}

module.exports = {
  DEFAULT_PRICING,
  pricingViewFor,
  normalizeModelId,
  modelLabel,
  priceFor,
  emptyUsage,
  addUsage,
  totalTokens,
  newWorkTokens,
  cacheWriteTokens,
  cacheReadTokens,
  cacheAllTokens,
  usdForUsage,
  costForModel,
  refreshHint,
  contextNow,
  summarize,
  formatUsd,
  formatTokens,
};
