// CrewPane — ADP-871 (SPRINT-MEMORY-SEARCH · Faz 3) HİBRİT ARAMA.
//
// İki liste, tek cevap:
//   • ANLAM katmanı  — ADP-870'in vektör indeksi (store.searchVectors)
//   • KELİME katmanı — FTS5/BM25 (store.searchLexical, ADP-871)
// Birleştirme: Reciprocal Rank Fusion. Puan değil SIRA kullanılır çünkü iki katmanın
// puanları KIYASLANAMAZ (kosinüs 0..1, bm25 negatif ve sınırsız); normalize etmeye
// kalkmak sorgudan sorguya kayan bir ölçek uydurmak olurdu.
//
// ── ÖNCEKİ ÖLÇÜMÜN UYARISI (bu modülün tasarımını belirledi) ────────────────
// ADP-869'da EŞİT ağırlıklı RRF(k=60) recall@5'i DÜŞÜRDÜ: vektör tek başına %66.7
// iken hibrit %60. Sebep: BM25'in ilk sıraları, vektörün doğru bulduğu dokümanı
// ilk-5'ten DIŞARI itiyordu. Yani "hibrit her zaman iyidir" YANLIŞTIR; ağırlık ve
// birleştirme düzeyi ölçülmesi gereken parametrelerdir. Bu modül ikisini de açık
// tutar (`weights`, `level`) ve varsayılanları ADP-871 §4'te ÖLÇÜLEN değerlerdir.
//
// ── BİRLEŞTİRME DÜZEYİ ──────────────────────────────────────────────────────
// `level:'doc'` (varsayılan): her liste ÖNCE dokümana indirgenir (doküman başına en
// iyi parça), sonra füzyon. Neden: tek bir uzun doküman vektör listesinin 5 sırasını
// birden doldurabiliyor ve RRF onu 5 ayrı kanıt sanıp haksız yere öne çıkarıyor.
// `level:'chunk'` ölçüm için duruyor (ADP-871 §4 tablosu).

'use strict';

const { analyze } = require('./memoryLexical.cjs');

/**
 * RRF sabiti — BU BORU HATTININ EN ETKİLİ PARAMETRESİ (ölçüldü, ADP-871 §4b).
 *
 * Literatür varsayılanı 60'tır ve ADP-869'un füzyonu da onu kullanmıştı; ölçtüm ve
 * DEĞİŞTİRDİM. Gerekçe aritmetik: k=60'ta 1. sıra ile 50. sıra arasındaki katkı farkı
 * yalnız 1/61 ÷ 1/110 = 1.8 kat — yani sıra neredeyse hiç önemsenmez, "iki liste de
 * gördü mü" her şeye baskın gelir. k=60 çok sayıda BENZER KALİTEDE sistem için
 * türetilmişti; bizde listelerden biri (kelime, %50) diğerinden (anlam, %66.7)
 * belirgin zayıf. Küçük k güçlü listenin sırasına saygı duyar, zayıf listeye ise
 * "kaçırılanı listeye SOK" rolü bırakır.
 *
 * ÖLÇÜM (30 altın soru, recall@5): k=60 → %63.3 (tabanın ALTINDA) · k=20 → %66.7 ·
 * k=10 → %73.3 · k=5 → %76.7 · k=3 → %73.3 · k=2 → %76.7. k∈[2,10] aralığındaki
 * 18 ayarın 18'i de tabanı (%66.7) geçiyor ya da eşitliyor → seçilen nokta izole bir
 * tepe DEĞİL, geniş bir plato. ADP-869'un "hibrit recall'ü düşürdü" bulgusunun
 * kök nedeni de buydu: hibrit değil, k=60 kötüydü.
 */
const RRF_K = 5;

/** Kaç aday çekilir (füzyondan ÖNCE). Derin liste = füzyona daha çok şans. */
const CANDIDATES = 50;

/**
 * Ölçülen varsayılan ağırlıklar (ADP-871 §4b ızgarası).
 * Kelime katmanı anlam katmanının biraz altında: rolü "kendi başına sıralamak" değil,
 * anlamın kaçırdığı TAM TERİMİ listeye SOKMAK. k=5'te w=0.7 ile w=1.0 ölçüm gürültüsü
 * içinde AYNI (recall %76.7, ilk-1 %33.3, MRR 0.498 / 0.508); ortadaki değer seçildi
 * çünkü k∈[2,7] boyunca en az oynayan sütun o.
 */
const DEFAULT_WEIGHTS = Object.freeze({ vector: 1, lexical: 0.7 });

/**
 * ALAKA TABANI — "bulamadım" diyebilmenin şartı (ölçüldü, ADP-871 §4d).
 *
 * Yoğun arama HER sorguya cevap döndürür: kosinüsün her zaman bir maksimumu vardır.
 * Yani eşik konmazsa "zxqwv çilingir mandalina teleferik" sorgusuna da 5 hafıza
 * gösterilir — istenen dürüstlük sınırının (görev §10) tam tersi.
 *
 * KALİBRASYON (bge-m3-q8, 789 doküman · en iyi kosinüs):
 *     30 gerçek altın soru : min 0.512 · ortanca 0.588
 *     8 saçma sorgu        : maks 0.460
 *     10 meşru TAM-TERİM   : min 0.469  ("RRF k=60")  ← çakışma tam BURADA
 *
 * Tek bir kosinüs eşiği bu üçünü ayıramaz: 0.48 saçmayı eler ama meşru "RRF k=60"u
 * da eler. O yüzden karar İKİ KANITLI: sorgu ancak (a) anlamsal benzerlik tabanın
 * ALTINDAysa VE (b) sorgudaki tam terimlerin HİÇBİRİ korpusta geçmiyorsa reddedilir.
 * Ayırt edici sinyal (b): uydurma kelimeler korpusta hiç yoktur — kelime katmanının
 * onlara verdiği eşleşmeler yalnız 5-harf kök tesadüfüdür ("teleferik"→"telef").
 *
 * ⚠ AÇIKÇA HATAYA-AÇIK tarafta duruyor: şüphede SONUÇ GÖSTERİR. Bir hafıza aramasında
 * "alakasız sonuç göstermek" ile "gerçek soruyu reddetmek" eşit maliyetli değildir.
 * ⚠ Bu sayı MODELE ÖZGÜdür (kosinüs ölçeği modelden modele kayar) — model değişirse
 * ADP-871 ölçüm düzeneği yeniden koşulmalı.
 */
const MIN_SCORE = 0.48;

/**
 * Reciprocal Rank Fusion. Saf.
 * @param {Array<{key:string}[]>} lists sıralı listeler (0. eleman = en iyi)
 * @param {{k?:number, weights?:number[]}} [opts] weights[i] = lists[i]'nin ağırlığı
 * @returns {{key:string, score:number, ranks:(number|null)[]}[]} azalan puanla sıralı
 */
function rrfFuse(lists, { k = RRF_K, weights = [] } = {}) {
  const acc = new Map(); // key -> { score, ranks }
  lists.forEach((list, li) => {
    const w = weights[li] ?? 1;
    (list || []).forEach((item, i) => {
      const key = item.key;
      if (key == null) return;
      let cur = acc.get(key);
      if (!cur) {
        cur = { key, score: 0, ranks: lists.map(() => null) };
        acc.set(key, cur);
      }
      // Aynı liste aynı anahtarı birden çok kez içerirse (parça düzeyi) EN İYİ sıra sayılır.
      if (cur.ranks[li] != null) return;
      cur.ranks[li] = i + 1;
      cur.score += w / (k + i + 1);
    });
  });
  return [...acc.values()].sort((a, b) => b.score - a.score || String(a.key).localeCompare(String(b.key)));
}

/** Listeyi dokümana indirge: doküman başına EN İYİ sıralı parça. Saf, sıra korunur. */
function bestPerDoc(list) {
  const seen = new Set();
  const out = [];
  for (const h of list || []) {
    if (seen.has(h.docPath)) continue;
    seen.add(h.docPath);
    out.push(h);
  }
  return out;
}

/**
 * Parçadan KISA ALINTI. Saf.
 * Sorgu terimlerinden biri metinde geçiyorsa alıntı ORANIN etrafından alınır —
 * "nereden geldi" sorusunun cevabı kullanıcının gözünde eşleşen cümledir, dosyanın
 * ilk cümlesi değil. Terim yoksa baştan kesilir.
 */
function excerptFor(text, queryText, maxChars = 220) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (flat.length <= maxChars) return flat;
  const terms = [...new Set(analyze(queryText || ''))].filter((t) => t.length >= 4);
  const lower = flat.toLocaleLowerCase('tr');
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return `${flat.slice(0, maxChars).trim()}…`;
  const start = Math.max(0, at - Math.floor(maxChars / 3));
  const piece = flat.slice(start, start + maxChars).trim();
  return `${start > 0 ? '…' : ''}${piece}…`;
}

/**
 * HİBRİT ARAMA. İki katmanı koşar, RRF ile birleştirir, sunuma hazır sonuç döner.
 *
 * @param {object} db açık indeks veritabanı
 * @param {{queryText:string, queryVec?:Float32Array|number[], k?:number,
 *          candidates?:number, weights?:{vector:number,lexical:number},
 *          level?:'doc'|'chunk', store?:object}} opts
 * @returns {{results:Array, sources:{vector:number,lexical:number}}}
 *
 * queryVec YOKSA (gömme çalışma zamanı kurulu değil) arama YALNIZ kelime katmanıyla
 * koşar — sessizce boş dönmez, elindekiyle cevap verir. Bu bilerek: ADP-870 §3b'de
 * model paket dışında ve kurulu olmayabilir.
 */
function searchHybrid(db, {
  queryText,
  queryVec = null,
  k = 5,
  candidates = CANDIDATES,
  weights = DEFAULT_WEIGHTS,
  level = 'doc',
  rrfK = RRF_K,
  minScore = MIN_SCORE,
  store = require('./memoryIndexStore.cjs'),
} = {}) {
  const q = String(queryText || '').trim();
  if (!q) return { results: [], sources: { vector: 0, lexical: 0 } };

  const vecHits = queryVec ? store.searchVectors(db, queryVec, candidates) : [];
  const lexHits = store.searchLexical(db, q, candidates);

  // ALAKA TABANI (bkz. MIN_SCORE): iki kanıt da yoksa dürüst ret.
  const bestScore = vecHits.length ? vecHits[0].score : 0;
  if (queryVec && bestScore < minScore && !store.hasExactTermEvidence(db, q)) {
    return { results: [], sources: { vector: vecHits.length, lexical: lexHits.length }, belowFloor: true, bestScore };
  }

  const keyOf = level === 'chunk' ? (h) => `${h.docPath}#${h.lineStart}-${h.lineEnd}` : (h) => h.docPath;
  const prep = (list) => (level === 'chunk' ? list : bestPerDoc(list)).map((h) => ({ ...h, key: keyOf(h) }));

  const vList = prep(vecHits);
  const lList = prep(lexHits);
  const fused = rrfFuse([vList, lList], { k: rrfK, weights: [weights.vector, weights.lexical] });

  // Anahtar -> gösterilecek parça. Vektörün seçtiği parça tercih edilir (anlamsal
  // olarak sorunun cevabına en yakın pencere odur); yoksa BM25'inki.
  const byKey = new Map();
  for (const h of lList) if (!byKey.has(h.key)) byKey.set(h.key, h);
  for (const h of vList) byKey.set(h.key, h);

  const seenDoc = new Set();
  const results = [];
  for (const f of fused) {
    const hit = byKey.get(f.key);
    if (!hit) continue;
    // Parça düzeyinde füzyonda bile kullanıcıya doküman başına TEK satır gösterilir.
    if (seenDoc.has(hit.docPath)) continue;
    seenDoc.add(hit.docPath);
    results.push({
      docPath: hit.docPath,
      name: hit.name,
      scope: hit.scope,
      headingPath: hit.headingPath,
      lineStart: hit.lineStart,
      lineEnd: hit.lineEnd,
      excerpt: excerptFor(hit.text, q),
      text: hit.text,
      score: f.score,
      vectorRank: f.ranks[0],
      lexicalRank: f.ranks[1],
      matchedBy: [f.ranks[0] != null ? 'anlam' : null, f.ranks[1] != null ? 'kelime' : null].filter(Boolean),
    });
    if (results.length >= k) break;
  }
  return { results, sources: { vector: vecHits.length, lexical: lexHits.length }, bestScore };
}

/** Sonuç yoksa söylenecek TEK cümle. Uydurma yok (görev spec'i §10). */
const NOT_FOUND = 'Hafızada bunu bulamadım.';

/**
 * Sonuçları okunur metne çevir: KAYNAK DOSYA + BAŞLIK + KISA ALINTI. Saf.
 * Kullanıcı "bu nereden geldi?" diye sorabilmeli — üçü de zorunlu.
 */
function formatResults(results, { max = 5 } = {}) {
  const list = (results || []).slice(0, max);
  if (!list.length) return NOT_FOUND;
  return list
    .map((r, i) => {
      const head = Array.isArray(r.headingPath) && r.headingPath.length ? r.headingPath.join(' › ') : '(başlıksız)';
      const via = r.matchedBy?.length ? ` [${r.matchedBy.join('+')}]` : '';
      return `${i + 1}. ${r.name} › ${head}  (satır ${r.lineStart}-${r.lineEnd})${via}\n   "${r.excerpt}"`;
    })
    .join('\n');
}

module.exports = {
  RRF_K,
  CANDIDATES,
  DEFAULT_WEIGHTS,
  MIN_SCORE,
  NOT_FOUND,
  rrfFuse,
  bestPerDoc,
  excerptFor,
  searchHybrid,
  formatResults,
};
