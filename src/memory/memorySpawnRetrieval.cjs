// CrewPane — ADP-872 (Faz 4) SPAWN YOLUNDA HİBRİT GERİ-ÇAĞIRMA (RAG).
//
// ADP-871 hibrit aramayı (BM25 + vektör, Reciprocal Rank Fusion) KURDU ama onu
// yalnız uygulama-içi yüzeyler çağırıyordu. ASIL kazanç orada değil: her ajan
// oturumu açılışında hafıza indeksinin TAMAMINI taşıyor (ADP-862 ölçümü: ~31 400
// jeton/oturum). Bu modül hibrit aramayı O yola bağlar — indeksin tamamı yerine
// göreve İLGİLİ 3-5 PARÇA.
//
// ── SENKRON OLMAK ZORUNDA ───────────────────────────────────────────────────
// `buildSpawn` argv'yi senkron kurar. Bu yüzden:
//   • kelime katmanı: SQLite (FTS5 varsa BM25, yoksa saf-JS BM25 taraması),
//   • anlam katmanı: ÖNBELLEKLİ sorgu vektörü (memoryQueryVectorCache) — model
//     burada YÜKLENMEZ. Önbellek boşsa `warm` geri-çağrısı ateşlenir (fire-and-
//     forget) ve SONRAKİ spawn tam hibrit olur.
// Yani ilk spawn tek katmanlı, sonrakiler iki katmanlı. Bu bir kusur değil bilinçli
// bir takas ve `layers` alanında AÇIKÇA raporlanır — "hibrit koştu" diye yalan yok.
//
// ── FÜZYON ──────────────────────────────────────────────────────────────────
// Birleştirme memoryHybrid.searchHybrid'e DEVREDİLİR: puanlar ASLA ortalanmaz
// (kosinüs 0..1 ile bm25 negatif-sınırsız kıyaslanamaz), yalnız SIRA kullanılır
// (RRF, k=5 — ADP-871 §4b'de ölçülmüş değer). Burada ikinci bir sıralama mantığı
// YAZILMAZ: iki yerde füzyon = sessiz sapma.
//
// Saf-ish: node builtin + repo modülleri; tüm dış bağımlılıklar `deps` ile
// enjekte edilebilir → `node --test` altında (FTS5 olmadan) koşar.

'use strict';

const os = require('node:os');

const hybrid = require('./memoryHybrid.cjs');
const qvec = require('./memoryQueryVectorCache.cjs');

/** Spawn bloğuna kaç parça girer. Küçük TUTULUR: kazancın kendisi bu sayıdır. */
const DEFAULT_K = 3;

/**
 * Kelime katmanı adaptörü.
 *
 * 🪤 ÖLÇÜLDÜ (ADP-862): sistem `node`'unun `node:sqlite`'ında FTS5 YOK ve yetenek
 * kontrolü YANLIŞ-POZİTİF verir (`hasLexIndex` true der, ilk sorgu patlar). Bu
 * yüzden yetenek ŞEMAYA değil GERÇEK SORGUYA sorulur (`scan.ftsUsable`).
 * FTS5 yoksa `chunks` düz tablosundan saf-JS BM25 koşar — sonuç ŞEKLİ birebir aynı,
 * füzyon ikisini ayırt etmez.
 */
function lexicalAdapter(db, { store, scan }) {
  if (scan.ftsUsable(db)) {
    try {
      store.ensureLexIndex(db);
      return { adapter: store, mode: 'fts5' };
    } catch {
      /* geri-doldurma yapılamadı → taramaya düş */
    }
  }
  let rows = null;
  const load = () => {
    if (!rows) rows = scan.readChunkRows(db);
    return rows;
  };
  return {
    mode: 'scan',
    adapter: {
      searchLexical: (_db, q, n) => scan.scanLexical(load(), q, n),
      searchVectors: store.searchVectors,
      hasExactTermEvidence: (_db, q) => scan.hasExactTermEvidenceScan(load(), q),
    },
  };
}

/**
 * Spawn için hibrit geri-çağırıcı.
 *
 * @param {object} o
 * @param {string} o.workspaceRoot hafıza kökü
 * @param {string} [o.homedir]
 * @param {number} [o.k] kaç parça
 * @param {(query:string)=>void} [o.warm] önbellekte vektör YOKKEN çağrılır (fire-and-forget)
 * @param {object} [o.deps] test dikişi: { store, scan, indexService, cache, hybrid }
 * @returns {(queryText:string)=>{hits:Array, layers:{vector:boolean,lexical:boolean},
 *                                reason:string|null, dbFile:string|null, mode:string|null}}
 *
 * ASLA FIRLATMAZ: hafıza bir spawn'ı bloklayamaz. Her hata `reason` ile boş sonuç.
 */
// SMOKE-ISO-01 — `homedir` varsayılanı `undefined`: bkz. memoryIndexService.indexDbPath.
function createSpawnRetriever({ workspaceRoot, homedir = undefined, k = DEFAULT_K, warm = null, deps = {} } = {}) {
  const store = deps.store || require('./memoryIndexStore.cjs');
  const scan = deps.scan || require('./memoryLexicalScan.cjs');
  const indexService = deps.indexService || require('./memoryIndexService.cjs');
  const cache = deps.cache || qvec;
  const fuse = deps.hybrid || hybrid;

  return function retrieve(queryText) {
    const empty = (reason, extra = {}) => ({ hits: [], layers: { vector: false, lexical: false }, reason, dbFile: null, mode: null, ...extra });
    const q = String(queryText || '').trim();
    if (!q) return empty('empty_query');

    let db = null;
    let file = null;
    try {
      file = indexService.indexDbPath({ workspaceRoot, homedir });
      const opened = store.openIndexForSearch({ file });
      // İndeks HİÇ kurulmamış olabilir (kullanıcının ilk açılışı) → sessizce eski
      // davranışa düşülür; çağıran seçki satırlarını yine gösterir.
      if (!opened) return { ...empty('index_not_built'), dbFile: file };
      db = opened.db;

      const { adapter, mode } = lexicalAdapter(db, { store, scan });

      // ANLAM katmanı: yalnız ÖNBELLEKTEN. Yoksa ısıtmayı tetikle ve bu turda
      // kelime katmanıyla devam et (bkz. modül başlığı).
      let queryVec = null;
      try {
        queryVec = cache.readVector({ file: cache.vectorPath({ workspaceRoot, homedir, query: q }) });
      } catch {
        queryVec = null;
      }
      if (!queryVec && typeof warm === 'function') {
        try {
          warm(q);
        } catch {
          /* ısıtma en iyi çabadır */
        }
      }

      // ── ALAKA TABANI, TEK KATMANLI TURDA DA ─────────────────────────────
      // 🪤 ÖLÇÜLDÜ (kanıt betiği §5): memoryHybrid'in tabanı `if (queryVec && …)`
      // ile korunuyor — yani anlam katmanı YOKKEN taban HİÇ çalışmıyor ve BM25 her
      // sorguya bir şey döndürüyor ("zxqwv çilingir mandalina teleferik" → 3 parça,
      // 5-harf kök tesadüfü). Arama yüzeyinde bu yalnız kötü bir sonuç listesidir;
      // SPAWN yolunda ise alakasız parçalar her oturumun bağlamına GİRER — yani bu
      // görevin amacının (jeton tasarrufu) tam tersi. Soğuk spawn'ın vektörü hiç
      // olmadığı için bu yol istisna değil KURAL.
      //
      // Taban hibritin ikinci kanıtıyla AYNI: sorgunun ayırt edici bir TAM TERİMİ
      // korpusta geçiyor mu (uydurma kelimeler hiç geçmez). Tek fark, burada tek
      // kanıt yeter — ölçecek anlamsal benzerlik yok.
      if (!queryVec) {
        let evidence = true;
        try {
          evidence = adapter.hasExactTermEvidence(db, q);
        } catch {
          evidence = true; // kanıt SORULAMADIYSA eleme: şüphede sonuç göster (hibritin kuralı)
        }
        if (!evidence) return { ...empty('below_relevance_floor'), dbFile: file, mode, layers: { vector: false, lexical: true } };
      }

      const out = fuse.searchHybrid(db, { queryText: q, queryVec, k, store: adapter });
      return {
        hits: out.results || [],
        layers: { vector: Boolean(queryVec), lexical: true },
        reason: out.belowFloor ? 'below_relevance_floor' : null,
        dbFile: file,
        mode,
      };
    } catch (err) {
      return { ...empty(`retrieval_failed: ${err.message}`), dbFile: file };
    } finally {
      try {
        if (db) db.close();
      } catch {
        /* zaten kapalı */
      }
    }
  };
}

module.exports = { DEFAULT_K, lexicalAdapter, createSpawnRetriever };
