// D-07 (SPRINT-TOK-01) — HAFIZA SEÇKİSİNİN GÖREVE GÖRE YAPILMASI: saf çekirdek.
//
// D-04 (docs/agent-results/D-04-memory-tax.md) ÖLÇTÜ, burası UYGULAR. Ölçülen üç şey:
//   1. Seçkinin sorgusu ajanın KİMLİĞİydi (görev metni spawn anında henüz yok) →
//      kullanım oranı %5,9 · oturumların %41'i enjekte edilen HİÇBİR kaydı açmadı.
//   2. Seçki bütçeyi DOLDURUYORDU: blok her spawn'da 6.350±60 karakter (varyans ≈ 0).
//      Yani çalışan şey seçim değil DOLDURMAydı — zayıf eşleşme de güçlü eşleşme de
//      aynı hacmi yazıyordu.
//   3. Blok 8.000 karakter tavanını doyurup ajanın ROL CÜMLESİNİ ortadan kesiyordu.
//
// BU MODÜLÜN SÖZLEŞMESİ (D-01/D-02/D-03 ile aynı dil):
//   🔴 KİMLİĞE DEĞİL DURUMA BAKAR. Girdilerde ajan ADI/ID'siyle dallanan tek satır
//      yoktur; "davranışsal muafiyet" bile kaydın KENDİ frontmatter `type` alanından
//      (durum) gelir, kimden geldiğinden değil. Testi kaynağı da tarar.
//   🔴 DOLDURMA YOK, EŞİK VAR. `relevance` [0,1] normalize edilmiş bir ORANdır;
//      eşiği geçen yoksa seçki BOŞ döner ("bu göreve uyan hafıza kaydı yok"), bütçe
//      kalan yerle doldurulmaz. Blok uzunluğunun varyansı > 0 olmak ZORUNDA.
//   🔴 KULLANILMAYAN KAYIT SÖNER, SİLİNMEZ. Defter (memoryUsageLedger) "N kez enjekte
//      edildi, 0 kez kullanıldı" diyorsa skor ÇARPAN ile düşürülür — kayıt hâlâ
//      seçilebilir (yeterince alakalıysa), ama aynı ölü ağırlık her göreve binmez.
//
// Saf: node builtin YOK (fs/path yok) → `node --test` doğrudan koşar, testler
// dosya sistemi kurmadan çekirdeği ölçer. Dosya okuyan sarmalayıcı memoryTaskBlock.cjs.

'use strict';

const { analyze, STEM_LEN } = require('./memoryLexical.cjs');

/**
 * 🪤 ÇİFT SAYIM TUZAĞI (ölçüldü, D-07 ilk koşu): `analyze` her uzun kelime için hem
 * TAM biçimi hem 4 karakterlik GÖVDESİNİ üretir ("gönderim" → gönderim + gönde).
 * İkisi de eşleşince TEK bir ortak kelime İKİ terim gibi puan topluyordu ve tek
 * kelimelik tesadüfi bir örtüşme eşiği geçiyordu. Çözüm: puanlama KELİME KÖKÜ
 * bazında yapılır (gövde başına EN YÜKSEK idf), böylece bir kelime bir kez sayılır —
 * ama gövde eşleşmesi (Türkçe çekimler) korunur.
 */
function stemKey(term) {
  return String(term).slice(0, STEM_LEN);
}

/** Frontmatter `metadata.type` değerlerinden DAVRANIŞSAL olanlar (ADR §4). */
// Neden bu ikisi: `user` = kullanıcının kim olduğu/tercihleri · `feedback` = bize
// verilmiş çalışma kuralı. D-04 ölçtü: bu sınıf doğası gereği ATIF ALMAZ
// (`user-pref-terse`: 41 enjeksiyon / 0 atıf) ama üslubu şekillendirir. Ölü-ağırlık
// metriğinden MUAF tutulmazsa metrik tam da en sessiz çalışan kayıtları budardı.
const BEHAVIORAL_TYPES = Object.freeze(['user', 'feedback']);

/** Seçkinin varsayılan eşikleri — hepsi çağıranın ezebileceği sayılar. */
const TARGET_DEFAULTS = Object.freeze({
  // ADR-MEMORY-INJECTION §3 Aşama B bütçesi.
  maxK: 5, // en fazla kaç kayıt
  maxChars: 2200, // blok gövdesinin karakter tavanı (artık nadiren bağlayıcı)
  lineChars: 300, // tek kaydın kancasından gösterilecek pay
  // 🔑 EŞİK — UYDURULMADI, 400 GERÇEK OTURUMDA KALİBRE EDİLDİ (rapor §3 tablosu):
  //   eşik 0,00 → isabet %17,7 · blok 2.252±41 ch (yani hâlâ DOLDURMA)
  //   eşik 0,14 → isabet %22,5 · 35/400 oturum hafızasız
  //   eşik 0,16 → isabet %24,5 · 95/400 oturum hafızasız · blok 1.440±591  ← SEÇİLDİ
  //   eşik 0,18 → isabet %30,2 ama 172/400 (%43) oturum hafızasız → ADR §8 risk-2
  //               (ajan hiç hafıza görmez, tekerleği yeniden icat eder) ağır basar.
  // Taban (rol-sorgusu, sevk edilen kod): isabet %6,2 · blok 6.351±42 ch.
  minRelevance: 0.16,
  // "İdeal satır" tanımı: sorgunun EN AYIRT EDİCİ bu kadar kelimesini tutan satır.
  // Uzun görev metinlerinde TÜM terimlerin toplamına bölmek her satırı sıfıra
  // yaklaştırır (uzun-sorgu tuzağı) — normalizasyon bu yüzden tepe-K üzerinden.
  //
  // 🪤 SABİT K DOYUYORDU (ölçüldü, D-07 kalibrasyonu): K=6'da 250 gerçek görevde
  // seçilen kayıtların İLGİSİ 10. sırada bile medyan 0,77 · 1. sırada 1,00 çıktı —
  // yani puan tavana yapışıp AYIRT ETMEYİ BIRAKTI ve eşik hiçbir şeyi elemedi
  // (blok uzunluğu varyansı ±44 ch ≈ yine "doldurma"). Sebep: gerçek görev metinleri
  // uzun (60+ kelime kökü) ve hafıza satırları da uzun — 6 kökü tutmak kolay.
  // ÇÖZÜM: ideal, sorgunun GENİŞLİĞİYLE ölçeklenir (kök sayısının bir oranı),
  // alt/üst sınırlarla. Böylece uzun bir görev metni gerçekten daha çok kanıt ister.
  idealTerms: 6, // ALT sınır (kısa sorgu)
  idealFraction: 0.35, // sorgunun kök sayısının bu oranı
  idealMax: 40, // ÜST sınır (çok uzun brifingde payda patlamasın)
});

/** Aşama A (spawn) çekirdeği: kimlikle birlikte giden EN AZ hafıza. */
const CORE_DEFAULTS = Object.freeze({
  maxCore: 3, // en fazla 3 davranışsal kayıt (ADR §3 Aşama A)
  coreChars: 600, // çekirdeğin karakter tavanı
  lineChars: 180,
  // 🔑 KABUL-FIX-01 (DT-10) — SABİTLENEN kayıt sayısı tavanı. ÖLÇÜM: kapsam
  // yakınlığı (own > global > shared) tek başına sıralarken 39 ajanın 39'unda
  // çekirdeğin 3 satırı da own/global'den doluyordu; TAKIM kapsamı çekirdeğe
  // yapısal olarak HİÇ giremiyordu ve Eren'in "yük testi YASAK" kuralı hiçbir
  // pane'e ulaşmıyordu. `metadata.always: true` o sırayı deler — ama 2'de durur:
  // çekirdeğin en az bir satırı kapsam-yakınlığı yoluna KALIR, yoksa "her şeyi
  // sabitle" D-04'ün ölçtüğü DOLDURMA'yı geri getirirdi.
  maxAlways: 2,
});

/** Ölü-ağırlık cezası: kaç enjeksiyondan sonra sönmeye başlar ve ne hızla. */
const DECAY_DEFAULTS = Object.freeze({
  deadAfter: 5, // bu kadar enjeksiyona rağmen 0 kullanım → sönme başlar
  factor: 0.6, // her `deadAfter` katında çarpan (0.6, 0.36, 0.216…) — SIFIR OLMAZ
});

// ---------------------------------------------------------------------------
// 1. İLGİ ÖLÇÜSÜ — mutlak puan değil, [0,1] ORAN
// ---------------------------------------------------------------------------

/**
 * Sorgu terimlerinin ayırt edicilik (idf) haritası + "ideal satır" mass'ı.
 *
 * memoryRecall.scoreLines mutlak bir idf TOPLAMI döndürür; o toplam korpusa ve
 * sorgu uzunluğuna göre ölçek değiştirdiği için ÜZERİNE EŞİK KONAMAZ (bugünkü
 * `minScore: 0.0001` de bu yüzden pratikte "her şey geçer" demek). Burada aynı
 * idf'i, sorgunun tepe-K teriminin toplamına BÖLEREK oranlıyoruz: sonuç
 * korpustan ve sorgu uzunluğundan bağımsız, eşiklenebilir bir sayı.
 *
 * @param {{terms:Set<string>}[]} docs satır başına terim kümesi
 * @param {string} queryText
 * @param {number} idealTerms
 * @returns {{idf:Map<string,number>, ideal:number, qTerms:string[]}}
 */
function queryModel(docs, queryText, idealTerms, cfg = {}) {
  const qTerms = [...new Set(analyze(queryText))].filter((t) => t.length >= 3);
  const N = Math.max(1, docs.length);
  const maxIdf = Math.log(1 + N); // tek satırda geçen terimin (df=1) ayırt ediciliği
  const idf = new Map();
  // Kelime kökü → o kökün en yüksek idf'i (çift sayım tuzağı, bkz. stemKey).
  const byStem = new Map();
  for (const t of qTerms) {
    let df = 0;
    for (const d of docs) if (d.has(t)) df += 1;
    if (df > 0) idf.set(t, Math.log(1 + N / df));
    // 🪤 KORPUSTA OLMAYAN TERİM PAYDAYA GİRER. İlk sürüm yalnız BULUNAN terimleri
    // topluyordu; ölçüldü: sorgunun tek bir terimi tutunca payda o tek terime eşit
    // oluyor ve oran ~1'e fırlıyordu (alakasız bir görev "eşiği geçti" diyordu).
    // "İdeal satır" tanımı gereği sorgunun EN AYIRT EDİCİ K terimini karşılar —
    // karşılayamadığımız terim de bu talebin parçasıdır.
    const w = df > 0 ? Math.log(1 + N / df) : maxIdf;
    const k = stemKey(t);
    byStem.set(k, Math.max(byStem.get(k) ?? 0, w));
  }
  // İdeal genişliği sorgunun KENDİ genişliğinden türer (sabit K doyma tuzağı).
  const fraction = Number(cfg.idealFraction) > 0 ? Number(cfg.idealFraction) : TARGET_DEFAULTS.idealFraction;
  const ceiling = Number(cfg.idealMax) > 0 ? Number(cfg.idealMax) : TARGET_DEFAULTS.idealMax;
  const k = Math.min(ceiling, Math.max(1, idealTerms, Math.round(byStem.size * fraction)));
  const ideal = [...byStem.values()]
    .sort((a, b) => b - a)
    .slice(0, k)
    .reduce((a, b) => a + b, 0);
  return { idf, ideal, qTerms, maxIdf, idealTerms: k, stems: byStem.size };
}

/**
 * Uzunluk cezası — memoryRecall.scoreLines ile AYNI eğri (kasten: iki seçici aynı
 * korpusta farklı uzunluk politikası uygularsa hangi satırın neden geldiği
 * açıklanamaz hâle gelir).
 */
function lengthPenalty(len) {
  return 1 + Math.log(1 + len / 400);
}

/**
 * Bir satırın sorguya İLGİSİ: [0,1]. Saf.
 * @returns {{relevance:number, hits:string[]}}
 */
function relevanceOf(terms, rawLen, model) {
  if (!model.ideal) return { relevance: 0, hits: [] };
  // Payda gibi PAY da kelime kökü bazında toplanır: bir kelime bir kez sayılır.
  const massByStem = new Map();
  const hits = [];
  for (const [t, w] of model.idf) {
    if (!terms.has(t)) continue;
    const k = stemKey(t);
    massByStem.set(k, Math.max(massByStem.get(k) ?? 0, w));
    hits.push(t);
  }
  let mass = 0;
  for (const w of massByStem.values()) mass += w;
  if (!mass) return { relevance: 0, hits: [] };
  const rel = mass / model.ideal / lengthPenalty(rawLen);
  return { relevance: Math.min(1, rel), hits };
}

// ---------------------------------------------------------------------------
// 2. KULLANIM GERİ-BESLEMESİ — ölü ağırlık söner, silinmez
// ---------------------------------------------------------------------------

/**
 * Defter sayacından ÇARPAN üret. Saf, kimlik körü: girdi yalnız sayılar + kaydın
 * KENDİ sınıfı.
 *
 * @param {{injected?:number, used?:number}|null} stats
 * @param {boolean} behavioral davranışsal sınıf → ceza YOK (ADR §4 muafiyeti)
 * @param {{deadAfter:number, factor:number}} cfg
 * @returns {number} (0,1] arası çarpan
 */
function decayFactor(stats, behavioral, cfg = DECAY_DEFAULTS) {
  if (behavioral) return 1;
  const injected = Number(stats && stats.injected) || 0;
  const used = Number(stats && stats.used) || 0;
  if (used > 0) return 1; // bir kez bile işe yaradıysa ceza YOK
  const deadAfter = Math.max(1, Number(cfg.deadAfter) || DECAY_DEFAULTS.deadAfter);
  if (injected < deadAfter) return 1;
  const steps = Math.floor(injected / deadAfter);
  const factor = Math.max(0.01, Math.min(1, Number(cfg.factor) || DECAY_DEFAULTS.factor));
  return Math.pow(factor, steps);
}

// ---------------------------------------------------------------------------
// 3. GÖREVE-GÖRE SEÇKİ (Aşama B)
// ---------------------------------------------------------------------------

/**
 * Adayları puanla + eşikle + bütçele.
 *
 * @param {{slug:string, scope:string, head:string, hook:string, raw:string,
 *          file:string|null, type:string}[]} candidates tüm kapsamların satırları
 * @param {string} queryText GÖREV METNİ (kimlik değil — D-07'nin bütün mesele si)
 * @param {{stats?:(slug:string)=>object|null}} deps
 * @param {object} opts TARGET_DEFAULTS'u ezer
 * @returns {{picks:Array, considered:number, aboveThreshold:number, chars:number,
 *            threshold:number, reason:string}}
 */
function selectTargeted(candidates, queryText, deps = {}, opts = {}) {
  const cfg = { ...TARGET_DEFAULTS, ...DECAY_DEFAULTS, ...opts };
  const list = Array.isArray(candidates) ? candidates : [];
  const empty = {
    picks: [],
    considered: list.length,
    aboveThreshold: 0,
    chars: 0,
    threshold: cfg.minRelevance,
    reason: 'no-candidates',
  };
  if (!list.length) return empty;
  const q = String(queryText || '').trim();
  if (!q) return { ...empty, reason: 'empty-query' };

  const docs = list.map((c) => new Set(analyze(`${c.head} ${c.hook}`)));
  const model = queryModel(docs, q, cfg.idealTerms, cfg);
  if (!model.ideal) return { ...empty, reason: 'query-has-no-discriminative-term' };

  const scored = [];
  for (let i = 0; i < list.length; i += 1) {
    const c = list[i];
    const { relevance, hits } = relevanceOf(docs[i], c.raw.length, model);
    if (relevance <= 0) continue;
    const behavioral = BEHAVIORAL_TYPES.includes(c.type);
    const stats = typeof deps.stats === 'function' ? deps.stats(c.slug) : null;
    const decay = decayFactor(stats, behavioral, cfg);
    scored.push({ ...c, relevance, hits, decay, score: relevance * decay });
  }
  // 🔑 EŞİK ÇARPANDAN SONRA UYGULANIR: sönmüş bir kayıt "eşiği geçti" diye geri
  // gelmesin. Aksi hâlde geri-besleme yalnız SIRALAMAYI değiştirir, enjeksiyonu
  // durdurmaz — kartın istediği tam olarak durdurulmasıydı.
  const passing = scored.filter((s) => s.score >= cfg.minRelevance).sort((a, b) => b.score - a.score);
  if (!passing.length) {
    return { ...empty, aboveThreshold: 0, reason: 'below-threshold' };
  }

  // Aynı kayıt birden çok kapsamda görünebilir (own/shared kopyası): ilki kalır.
  const seen = new Set();
  const picks = [];
  let chars = 0;
  for (const s of passing) {
    if (picks.length >= cfg.maxK) break;
    if (seen.has(s.slug)) continue;
    const text = renderPick(s, cfg.lineChars);
    // Sığmayanı ATLA, döngüyü KIRMA: sıradaki (daha kısa) kayıt bütçeye girebilir.
    if (chars + text.length + 1 > cfg.maxChars) continue;
    seen.add(s.slug);
    picks.push({ ...s, text });
    chars += text.length + 1;
  }
  return {
    picks,
    considered: list.length,
    aboveThreshold: passing.length,
    chars,
    threshold: cfg.minRelevance,
    reason: picks.length ? 'selected' : 'budget-empty',
  };
}

/** Bir seçilmiş kaydın satırı: KAYNAK (başlık+dosya) korunur, kanca kırpılır. Saf. */
function renderPick(pick, lineChars) {
  const flat = String(pick.hook || '').replace(/\s+/g, ' ').trim();
  const hook = flat.length <= lineChars ? flat : `${flat.slice(0, lineChars).trim()}…`;
  const head = String(pick.head || '').trim();
  // `head` sondaki boşluğu trim'lenmiş olarak gelir ("… —"); ayraç ile kanca
  // birbirine yapışmasın (ilk gerçek çıktıda görüldü: "…(x.md) —🆕 v3…").
  return head ? `${head} ${hook}`.trim() : `- ${pick.slug} — ${hook}`.trim();
}

/**
 * Aşama B bloğunun METNİ. Görünür sınırlı (`<hafıza …>`), kayıplılığını KENDİ
 * söyler, derinleşme yolunu verir. Boş seçkide '' döner — çağıran hiçbir şey
 * eklemez (ADR §3: "eşiği geçen yoksa hiçbir şey enjekte etme").
 *
 * @param {object} sel selectTargeted çıktısı
 * @param {{cliPath?:string|null, workspaceRoot?:string}} o
 */
function renderTaskBlock(sel, o = {}) {
  if (!sel || !sel.picks || !sel.picks.length) return '';
  const deeper =
    o.cliPath && o.workspaceRoot
      ? `\nDaha derini: \`node "${o.cliPath}" --workspace "${o.workspaceRoot}" "<konu>"\``
      : '';
  const head =
    `<hafıza · BU GÖREVE göre seçildi (k=${sel.picks.length}/${sel.considered}, ` +
    `eşik=${sel.threshold}) — kayıplıdır, aradığın yoksa aramayı kullan>`;
  return `${head}\n${sel.picks.map((p) => p.text).join('\n')}${deeper}\n</hafıza>`;
}

// ---------------------------------------------------------------------------
// 4. AŞAMA A ÇEKİRDEĞİ — spawn'da giden EN AZ hafıza
// ---------------------------------------------------------------------------

/**
 * Spawn'da enjekte edilecek DAVRANIŞSAL çekirdek: en fazla 3 kayıt, tek satır.
 *
 * 🔴 Seçim ölçütü kaydın KENDİ `metadata.type` alanı (durum), ajanın kimliği
 * DEĞİL. Aynı kod her ajanda aynı kuralı uygular; bir ajanın adına özel dal yok.
 * Sıra: (1) SABİTLENMİŞ mi (`metadata.always: true`, en fazla `maxAlways` adet),
 * (2) kapsam yakınlığı — kendi hafızası > global > takım, (3) defterde ölçülmüş
 * kullanım, (4) ad (deterministik). Rastgelelik yok: aynı durum → aynı çekirdek
 * (spawn'lar kıyaslanabilir olmalı).
 *
 * @param {{slug:string, scope:string, type:string, description:string}[]} facts
 * @param {{stats?:(slug:string)=>object|null}} deps
 * @param {object} opts CORE_DEFAULTS'u ezer
 * @returns {{lines:string[], slugs:string[], chars:number}}
 */
function behavioralCore(facts, deps = {}, opts = {}) {
  const cfg = { ...CORE_DEFAULTS, ...opts };
  const scopeRank = (s) => (s === 'own' ? 0 : s === 'global' ? 1 : 2);
  // KABUL-FIX-01 (DT-10) — SABİTLENEN KAYIT İLK ANAHTARDIR. Kapsam yakınlığı iyi bir
  // ikinci anahtardır ("bana en yakın hafıza önce") ama BİRİNCİ anahtar olduğunda
  // takım kapsamındaki BAĞLAYICI bir kuralı, ajanın kendi rastgele bir öğrenmesine
  // kaybettirir. `always` kaydın KENDİ frontmatter'ından gelir (durum), kimlikten değil.
  const pinned = (f) => (f && f.always === true ? 0 : 1);
  const pool = (Array.isArray(facts) ? facts : [])
    .filter((f) => f && BEHAVIORAL_TYPES.includes(f.type) && String(f.description || '').trim())
    .map((f) => {
      const st = typeof deps.stats === 'function' ? deps.stats(f.slug) : null;
      return { ...f, used: Number(st && st.used) || 0 };
    })
    .sort(
      (a, b) =>
        pinned(a) - pinned(b) ||
        scopeRank(a.scope) - scopeRank(b.scope) ||
        b.used - a.used ||
        String(a.slug).localeCompare(String(b.slug)),
    );

  const lines = [];
  const slugs = [];
  let chars = 0;
  let pins = 0;
  const maxAlways = Number.isFinite(cfg.maxAlways) && cfg.maxAlways >= 0 ? cfg.maxAlways : CORE_DEFAULTS.maxAlways;
  for (const f of pool) {
    if (lines.length >= cfg.maxCore) break;
    // Tavanı aşan sabit kayıt ATLANIR (sıralama gereği hepsi baştadır) — kalan yer
    // kapsam-yakınlığı yolunun hakkıdır.
    if (pinned(f) === 0) {
      if (pins >= maxAlways) continue;
    }
    const desc = String(f.description).replace(/\s+/g, ' ').trim();
    const clipped = desc.length <= cfg.lineChars ? desc : `${desc.slice(0, cfg.lineChars).trim()}…`;
    const text = `- ${f.slug}: ${clipped}`;
    if (chars + text.length + 1 > cfg.coreChars) continue;
    lines.push(text);
    slugs.push(f.slug);
    chars += text.length + 1;
    if (pinned(f) === 0) pins += 1;
  }
  return { lines, slugs, chars };
}

// ---------------------------------------------------------------------------
// 5. KİMLİK ÖNCE — 8.000 tavanı ROL CÜMLESİNİ yiyemez (K3)
// ---------------------------------------------------------------------------

/** Hafıza bloğu kırpıldığında bunu SÖYLEYEN işaret (sessiz kayıp yasağı). */
const TRIM_MARK = '\n…[hafıza bloğu kimlik için kırpıldı — tamamı için MEMORY.md/arama]';

/**
 * Hafıza bloğunu VERİLEN paya sığdır. Sığmıyorsa KUYRUKTAN kırpar ve kırpıldığını
 * yazar; pay bir satıra bile yetmiyorsa bloğu tamamen DÜŞÜRÜR ('' döner) — yarım
 * cümlelik bir hafıza kuralı, hiç hafıza kuralı olmamasından beterdir (D-04 §1.7'de
 * ölçülen hâl tam da buydu: yazma disiplini cümlesinin ORTASINDAN kesilmiş bloklar).
 * Saf.
 */
function clampMemoryBlock(block, allowance) {
  const text = typeof block === 'string' ? block.trim() : '';
  if (!text) return '';
  const room = Number(allowance) || 0;
  if (room <= 0) return '';
  if (text.length <= room) return text;
  if (room <= TRIM_MARK.length + 200) return ''; // anlamlı bir şey kalmıyor → hiç gönderme
  return `${text.slice(0, room - TRIM_MARK.length).trimEnd()}${TRIM_MARK}`;
}

/**
 * KİMLİK ÖNCE bütçeleme: `fixedLen` (kimlik + guard + protokol — HEPSİ korunur)
 * çıkarıldıktan SONRA kalan yer hafızanındır.
 *
 * D-04 §1.7 ölçtü: bugün sıra tersiydi — hafıza BAŞA ekleniyor, tavan KUYRUKTAN
 * kırpıyordu, dolayısıyla kesilen şey her zaman KİMLİKti (4/4 canlı taze spawn'da
 * rol cümlesi ortadan kesilmişti). Bu fonksiyon o sırayı tersine çevirir.
 *
 * @param {number} cap MAX_SYSTEM_PROMPT_LEN
 * @param {number} fixedLen hafızasız kompozisyonun uzunluğu (dokunulmaz)
 * @param {number} [preferred] hafızaya verilecek üst sınır (Aşama A bütçesi)
 * @returns {number} hafıza bloğuna ayrılan karakter payı (≥0)
 */
function memoryAllowance(cap, fixedLen, preferred) {
  const SEP = 2; // '\n\n'
  const room = Math.max(0, (Number(cap) || 0) - (Number(fixedLen) || 0) - SEP);
  const want = Number(preferred);
  return Number.isFinite(want) && want > 0 ? Math.min(room, want) : room;
}

module.exports = {
  BEHAVIORAL_TYPES,
  TARGET_DEFAULTS,
  CORE_DEFAULTS,
  DECAY_DEFAULTS,
  TRIM_MARK,
  queryModel,
  lengthPenalty,
  relevanceOf,
  decayFactor,
  selectTargeted,
  renderPick,
  renderTaskBlock,
  behavioralCore,
  clampMemoryBlock,
  memoryAllowance,
};
