// CrewPane — ADP-870 (SPRINT-MEMORY-SEARCH · Faz 2) hafıza indeksi deposu.
//
// DEPO KARARI — ölçülmüş sadeleştirme. Görev spec'i "SQLite vektör EKLENTİSİ" diyordu;
// ölçtüm ve eklentiyi ALMIYORUZ, iki nedenle:
//   1. `sqlite-vec` gibi eklentiler platform başına derlenmiş .dylib/.dll ister →
//      mac(arm64+x64) + win(x64) için üç ikili, imzalama/asarUnpack yükü, Windows
//      hattı (SPRINT-WINDOWS-IMPL) hâlâ açıkken üçüncü bir yerel bağımlılık.
//   2. Ölçeğimizde ANN indeksinin getirisi YOK: 785 dosya → 4.4 K parça. 4.4 K × 1024
//      boyut float32 = 18 MB; kaba-kuvvet kosinüs ÖLÇÜLDÜ 3.2 ms (ADP-870 raporu).
//      Kullanıcı 20 ms'lik gömme süresini zaten ödüyor; ANN 3 ms'i 0.3 ms yapardı.
// Yerine: Node 24'ün GÖMÜLÜ `node:sqlite`'ı (Electron 42 = Node 24.16 — ölçüldü) +
// vektörler BLOB. YERLİ MODÜL YOK → electron-rebuild yok, asarUnpack yok, Windows'ta
// ek ikili yok. Arama Faz 3'te bu tablodan kaba kuvvetle koşacak.
//
// PARMAK İZİ KİLİDİ: model/dtype/boyut/parçalama parametreleri değişirse eski vektörler
// YENİSİYLE KIYASLANAMAZ. Bunlar `meta` tablosunda saklanır; uyuşmazlıkta indeks
// SESSİZCE değil, AÇIKÇA sıfırlanır (reset:true döner) — yoksa yarısı eski yarısı yeni
// modelle gömülmüş bir indeks üretilir ve hiçbir hata vermez.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { lexTextFor, ftsMatchQuery, LEX_VERSION } = require('./memoryLexical.cjs');
const { tokens } = require('../voice/turkishMorph.cjs');

const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS docs (
  path        TEXT PRIMARY KEY,
  scope       TEXT NOT NULL,
  name        TEXT NOT NULL,
  hash        TEXT NOT NULL,
  mtime_ms    INTEGER NOT NULL,
  size        INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL,
  indexed_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chunks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_path     TEXT NOT NULL,
  ordinal      INTEGER NOT NULL,
  heading_path TEXT NOT NULL,
  line_start   INTEGER NOT NULL,
  line_end     INTEGER NOT NULL,
  tokens       INTEGER NOT NULL,
  text         TEXT NOT NULL,
  vec          BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS chunks_doc_idx ON chunks(doc_path);
`;

// ADP-900 — MODELSİZ (yalnız kelime katmanı) İNDEKSLEME. Faz 2'de indeksleme gömme
// modeline BAĞLIYDI: model yoksa çocuk `unavailable` deyip çıkıyor, yani müşterinin
// kurulumunda İNDEKS HİÇ OLUŞMUYORDU — ve indeks olmayınca kelime katmanı da yoktu.
// Artık vektör İSTEĞE BAĞLI: parça satırı vektörsüz (`vec` = 0 bayt) yazılabilir.
//
// `docs.vec_dim` bunun DEFTERİdir ve şart: artımlı plan "dosya değişmedi" diyerek
// atlar, yani model sonradan indiğinde vektörler ASLA yazılmazdı. Bu sütun sayesinde
// "içerik aynı ama vektörü yok" hâli görülür ve o dosya yeniden işlenir.
//
// EKLEMELİ göç (SCHEMA_VERSION artmaz): artsaydı parmak izi değişir ve Faz 2'de
// indekslenmiş herkes 21 dakikalık yeniden gömme öderdi.
function ensureVecDimColumn(db) {
  try {
    const cols = db.prepare('PRAGMA table_info(docs)').all();
    if (cols.some((c) => c.name === 'vec_dim')) return;
    db.exec('ALTER TABLE docs ADD COLUMN vec_dim INTEGER NOT NULL DEFAULT 0');
    // 🪤 VARSAYILAN 0'I OLDUĞU GİBİ BIRAKMAK, MEVCUT HER İNDEKSİ "vektörsüz" GÖSTERİR
    // ve ilk koşuda 21 DAKİKALIK yeniden gömme başlatırdı. Gerçek durum zaten diskte:
    // vektör BLOB'unun uzunluğu / 4 = boyut. Göç onu OKUR, varsaymaz.
    db.exec(
      'UPDATE docs SET vec_dim = COALESCE((SELECT MAX(LENGTH(c.vec)) / 4 FROM chunks c WHERE c.doc_path = docs.path), 0)',
    );
  } catch {
    /* eski sqlite / yarış: aşağıdaki okumalar 0 varsayar (yeniden gömme, veri kaybı değil) */
  }
}

// ADP-871 (Faz 3) — KELİME KATMANI. Ayrı DDL, çünkü BU TABLO PARMAK İZİNE GİRMEZ:
// içeriği `chunks.text`ten TÜRETİLEBİLİR olduğu için modelden bağımsızdır. Bilerek
// SCHEMA_VERSION'ı da artırmıyorum — artırsaydım Faz 2'de indekslenmiş her kullanıcı
// 21 DAKİKALIK yeniden GÖMME öderdi; oysa eksik olan yalnız leksik tablo ve o saniyeler
// içinde chunks'tan geri doldurulabiliyor (bkz. ensureLexIndex).
// rowid = chunks.id (birebir); tokenize=unicode61 remove_diacritics 0 → 'ı' ile 'i',
// 'ş' ile 's' AYRI kalır (Türkçede anlam taşır, ADP-854 dersi).
const FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(lex, tokenize = 'unicode61 remove_diacritics 0');
`;

/**
 * 🪤 FTS5 GARANTİ DEĞİL — ÖLÇÜLDÜ. Aynı depoda iki çalışma zamanı var ve ikisi
 * anlaşmıyor:
 *     Electron 42 (Node 24.16) → FTS5 VAR   (ENABLE_FTS5 derleme seçeneği açık)
 *     sistem Node v23.6.1      → "no such module: fts5"
 * İlk yazımda `CREATE VIRTUAL TABLE` çıplaktı; birim test takımı (sistem Node'uyla
 * koşuyor) 12 testte KIRMIZI verdi — yani leksik katmanı EKLEMEK, Faz 2'nin çalışan
 * VEKTÖR aramasını da öldürüyordu. Kelime katmanı bir EKLENTİDİR: yoksa özellik
 * küçülür, uygulama ÇÖKMEZ. Bu WeakSet o kabiliyeti veritabanı başına hatırlar.
 */
const LEX_OK = new WeakSet();

/** Bu veritabanında kelime katmanı çalışıyor mu? */
function hasLexIndex(db) {
  return LEX_OK.has(db);
}

/** Dosya içeriğinin kimliği. Saf. */
function contentHash(text) {
  return crypto.createHash('sha1').update(text).digest('hex');
}

/**
 * İndeksin "aynı kurallarla üretildi mi" parmak izi. Saf.
 * Buraya giren HER ŞEY değişince indeks baştan kurulur — o yüzden yalnız gömme
 * sonucunu GERÇEKTEN değiştiren alanlar var (parçalama boyu vektörü değiştirir).
 */
function fingerprintOf({ model, dtype, dim, chunk }) {
  return JSON.stringify({
    schema: SCHEMA_VERSION,
    model: String(model || ''),
    dtype: String(dtype || ''),
    dim: Number(dim || 0),
    chunk: {
      maxTokens: chunk?.maxTokens ?? null,
      targetTokens: chunk?.targetTokens ?? null,
      minTokens: chunk?.minTokens ?? null,
      overlapRatio: chunk?.overlapRatio ?? null,
    },
  });
}

/** Float32Array -> BLOB (Uint8Array). Saf. Vektörler NORMALİZE yazılır (arama = iç çarpım). */
function encodeVector(vec) {
  const f32 = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength).slice();
}

/** BLOB -> Float32Array. Saf. */
function decodeVector(blob) {
  const u8 = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  // Kopya ŞART: SQLite'ın döndürdüğü tampon hizalı olmayabilir (byteOffset % 4).
  const copy = u8.slice();
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

/**
 * İndeksi aç. Parmak izi uyuşmuyorsa TABLOLARI BOŞALTIR ve reset:true döner.
 * @returns {{db:import('node:sqlite').DatabaseSync, reset:boolean, fingerprint:string}}
 */
function openIndex({ file, fingerprint, sqlite = require('node:sqlite') } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new sqlite.DatabaseSync(file);
  // WAL: indeksleyici ÇOCUK süreç yazarken main aynı dosyadan okuyabilsin (Faz 3 arama).
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(SCHEMA_SQL);
  ensureVecDimColumn(db); // ADP-900 — modelsiz indekslemenin defteri (eklemeli göç)
  try {
    db.exec(FTS_SQL);
    LEX_OK.add(db);
  } catch {
    /* FTS5 yok — kelime katmanı kapalı, anlam katmanı çalışmaya devam eder */
  }

  const cur = db.prepare('SELECT value FROM meta WHERE key = ?').get('fingerprint');
  let reset = false;
  if (!cur || cur.value !== fingerprint) {
    db.exec('DELETE FROM chunks');
    db.exec('DELETE FROM docs');
    if (LEX_OK.has(db)) db.exec('DELETE FROM chunks_fts');
    const setMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    setMeta.run('fingerprint', fingerprint);
    // Sıfırdan kurulan indeksin her satırı GÜNCEL analizden geçecek (upsertDoc) →
    // sürümü şimdi damgala, yoksa ilk aramada gereksiz bir geri-doldurma koşar.
    setMeta.run('lex_version', String(LEX_VERSION));
    reset = Boolean(cur); // ilk kurulum "sıfırlama" değildir
  }
  return { db, reset, fingerprint };
}

/**
 * ARAMA İÇİN AÇ — parmak izi kontrolü YAPMAZ, dolayısıyla asla SİLMEZ.
 * `openIndex` uyuşmayan parmak izinde tabloları boşaltır; bu doğru davranıştır ama
 * YAZAN taraf içindir. Arama yolu yanlış bir parmak iziyle çağrılsa 21 dakikalık
 * indeksi bir SORGU yüzünden çöpe atardı. Dosya yoksa null döner (indeks kurulmamış).
 * @returns {{db:object, fingerprint:string|null}|null}
 */
function openIndexForSearch({ file, sqlite = require('node:sqlite') } = {}) {
  if (!file || !fs.existsSync(file)) return null;
  const db = new sqlite.DatabaseSync(file);
  db.exec(SCHEMA_SQL);
  ensureVecDimColumn(db); // ADP-900
  try {
    db.exec(FTS_SQL);
    LEX_OK.add(db);
  } catch {
    /* FTS5 yok — kelime katmanı kapalı */
  }
  const fp = db.prepare('SELECT value FROM meta WHERE key = ?').get('fingerprint');
  return { db, fingerprint: fp ? fp.value : null };
}

/** İndekste kayıtlı dokümanlar: path -> {hash, mtimeMs, size, chunkCount}. */
function listDocs(db) {
  const out = new Map();
  // ADP-900 — `vec_dim` artımlı planın girdisidir: 0 = bu doküman vektörsüz yazıldı
  // (modelsiz kurulum). Sütun okunamazsa (çok eski dosya) 0 varsayılır.
  let rows;
  try {
    rows = db.prepare('SELECT path, hash, mtime_ms, size, chunk_count, vec_dim FROM docs').all();
  } catch {
    rows = db.prepare('SELECT path, hash, mtime_ms, size, chunk_count FROM docs').all();
  }
  for (const r of rows) {
    out.set(r.path, {
      hash: r.hash,
      mtimeMs: Number(r.mtime_ms),
      size: Number(r.size),
      chunkCount: Number(r.chunk_count),
      vecDim: Number(r.vec_dim || 0),
    });
  }
  return out;
}

/**
 * Bir dokümanın parçalarını + vektörlerini yaz (varsa öncekini SİLER). Tek işlem.
 * chunks[i] ile vectors[i] AYNI sırada olmalı.
 */
function upsertDoc(db, doc, chunks, vectors, now = Date.now()) {
  // ADP-900 — `vectors === null` = MODELSİZ yazım (yalnız kelime katmanı). Boş
  // vektör YAZILIR ve `docs.vec_dim = 0` damgalanır; arama tarafı 0 baytlık vektörü
  // ELER (searchVectors), böylece "hepsi 0 puan" gibi sessiz bir yanlış sıralama olmaz.
  const lexicalOnly = vectors == null;
  if (!lexicalOnly && chunks.length !== vectors.length) {
    throw new Error(`upsertDoc: ${chunks.length} parça ama ${vectors.length} vektör (${doc.path})`);
  }
  const vecDim = lexicalOnly ? 0 : (vectors[0]?.length ?? 0);
  const delChunks = db.prepare('DELETE FROM chunks WHERE doc_path = ?');
  const insChunk = db.prepare(
    'INSERT INTO chunks (doc_path, ordinal, heading_path, line_start, line_end, tokens, text, vec) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const insDoc = db.prepare(
    `INSERT INTO docs (path, scope, name, hash, mtime_ms, size, chunk_count, indexed_at, vec_dim)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       scope=excluded.scope, name=excluded.name, hash=excluded.hash, mtime_ms=excluded.mtime_ms,
       size=excluded.size, chunk_count=excluded.chunk_count, indexed_at=excluded.indexed_at,
       vec_dim=excluded.vec_dim`,
  );
  // ADP-871: leksik satırlar parça satırlarıyla AYNI işlemde yaşar/ölür — yoksa vektör
  // ile BM25 farklı sürümleri görür ve hibrit sessizce yanlış birleştirir.
  const lex = LEX_OK.has(db);
  const delFts = lex ? db.prepare('DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE doc_path = ?)') : null;
  const insFts = lex ? db.prepare('INSERT INTO chunks_fts (rowid, lex) VALUES (?, ?)') : null;
  db.exec('BEGIN');
  try {
    delFts?.run(doc.path);
    delChunks.run(doc.path);
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const res = insChunk.run(
        doc.path,
        c.ordinal,
        JSON.stringify(c.headingPath || []),
        c.lineStart,
        c.lineEnd,
        c.tokens,
        c.text,
        lexicalOnly ? new Uint8Array(0) : encodeVector(vectors[i]),
      );
      insFts?.run(res.lastInsertRowid, lexTextFor({ name: doc.name, headingPath: c.headingPath, text: c.text }));
    }
    insDoc.run(doc.path, doc.scope, doc.name, doc.hash, Math.round(doc.mtimeMs), doc.size, chunks.length, now, vecDim);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** İçerik AYNI ama dosya damgası kaymış: yalnız mtime/size tazele (yeniden gömme YOK). */
function touchDoc(db, docPath, mtimeMs, size) {
  db.prepare('UPDATE docs SET mtime_ms = ?, size = ? WHERE path = ?').run(Math.round(mtimeMs), size, docPath);
}

/** Silinmiş dosyayı indeksten kaldır. */
function deleteDoc(db, docPath) {
  db.exec('BEGIN');
  try {
    if (LEX_OK.has(db)) {
      db.prepare('DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE doc_path = ?)').run(docPath);
    }
    db.prepare('DELETE FROM chunks WHERE doc_path = ?').run(docPath);
    db.prepare('DELETE FROM docs WHERE path = ?').run(docPath);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Özet sayaçlar (rapor/ilerleme yüzeyleri için). */
function stats(db) {
  const d = db.prepare('SELECT COUNT(*) AS n FROM docs').get();
  const c = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(tokens),0) AS t FROM chunks').get();
  // ADP-900 — ANLAM KATMANI KAÇ PARÇAYI KAPSIYOR. "İndeks hazır" demek yetmez:
  // modelsiz kurulan bir indekste bu sayı 0'dır ve UI bunu "kapalı katman" olarak
  // DÜRÜSTÇE gösterir (yarım kurulumu "hazır" göstermek yalan olurdu).
  const v = db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE LENGTH(vec) >= 4').get();
  return { docs: Number(d.n), chunks: Number(c.n), tokens: Number(c.t), vectorChunks: Number(v.n) };
}

/** Bir dokümanın parçalarını meta verisiyle oku (meta veri denetimi + Faz 3 gösterimi). */
function chunksOf(db, docPath) {
  return db
    .prepare('SELECT ordinal, heading_path, line_start, line_end, tokens, text FROM chunks WHERE doc_path = ? ORDER BY ordinal')
    .all(docPath)
    .map((r) => ({
      ordinal: Number(r.ordinal),
      headingPath: JSON.parse(r.heading_path),
      lineStart: Number(r.line_start),
      lineEnd: Number(r.line_end),
      tokens: Number(r.tokens),
      text: r.text,
    }));
}

/**
 * Kaba-kuvvet kosinüs araması. Vektörler yazılırken normalize edildiği için
 * kosinüs = iç çarpım. Faz 3 hibrit birleştirmesi bunun üstüne gelecek.
 * @returns {{docPath:string,name:string,scope:string,headingPath:string[],lineStart:number,lineEnd:number,score:number,text:string}[]}
 */
function searchVectors(db, queryVec, k = 5) {
  const q = queryVec instanceof Float32Array ? queryVec : Float32Array.from(queryVec);
  // ADP-900 — `LENGTH(c.vec) >= 4`: modelsiz yazılmış parçaların vektörü BOŞTUR.
  // Elenmeselerdi iç çarpımları 0 çıkar, listeye girer ve "anlam katmanı koştu ama
  // hepsi alakasız" gibi SESSİZ bir yanlışlık üretirlerdi.
  const rows = db
    .prepare(
      'SELECT c.doc_path, c.heading_path, c.line_start, c.line_end, c.text, c.vec, d.name, d.scope FROM chunks c JOIN docs d ON d.path = c.doc_path WHERE LENGTH(c.vec) >= 4',
    )
    .all();
  const scored = [];
  for (const r of rows) {
    const v = decodeVector(r.vec);
    let dot = 0;
    const n = Math.min(v.length, q.length);
    for (let i = 0; i < n; i++) dot += v[i] * q[i];
    scored.push({
      docPath: r.doc_path,
      name: r.name,
      scope: r.scope,
      headingPath: JSON.parse(r.heading_path),
      lineStart: Number(r.line_start),
      lineEnd: Number(r.line_end),
      text: r.text,
      score: dot,
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

// ── ADP-871 · KELİME KATMANI ────────────────────────────────────────────────

/**
 * Leksik indeksi parça tablosuyla HİZALA. Faz 2'de indekslenmiş bir veritabanı
 * açıldığında `chunks_fts` BOŞ olur — o hâlde hibrit sessizce yalnız-vektöre düşerdi
 * ve kimse fark etmezdi. Bu yüzden sayılar uyuşmuyorsa tablo chunks'tan yeniden
 * kurulur: GÖMME YOK, yalnız metin analizi (4 440 parça ≈ saniyeler).
 * @returns {{backfilled:number, chunks:number, skipped:boolean}}
 */
function ensureLexIndex(db) {
  if (!LEX_OK.has(db)) return { backfilled: 0, chunks: 0, skipped: true, available: false };
  const chunkN = Number(db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n);
  const ftsN = Number(db.prepare('SELECT COUNT(*) AS n FROM chunks_fts').get().n);
  // Sayı EŞİT olsa bile analiz kuralı değişmişse tablo BAYATTIR: sorgu yeni jetonları
  // üretir, indekste eskiler durur ve arama hiçbir hata vermeden kötüleşir. Ölçüldü.
  const curVer = db.prepare('SELECT value FROM meta WHERE key = ?').get('lex_version');
  const verOk = curVer && Number(curVer.value) === LEX_VERSION;
  if (chunkN === ftsN && verOk) return { backfilled: 0, chunks: chunkN, skipped: true };

  const rows = db
    .prepare('SELECT c.id, c.heading_path, c.text, d.name FROM chunks c JOIN docs d ON d.path = c.doc_path')
    .all();
  const ins = db.prepare('INSERT INTO chunks_fts (rowid, lex) VALUES (?, ?)');
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM chunks_fts');
    for (const r of rows) {
      ins.run(r.id, lexTextFor({ name: r.name, headingPath: JSON.parse(r.heading_path), text: r.text }));
    }
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('lex_version', String(LEX_VERSION));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { backfilled: rows.length, chunks: chunkN, skipped: false, lexVersion: LEX_VERSION };
}

/**
 * BM25 araması (SQLite FTS5). Vektör aramasıyla AYNI sonuç şeklini döndürür ki
 * hibrit birleştirici iki listeyi ayrım gözetmeden işleyebilsin.
 * `score`: bm25() negatif döner (küçük = iyi); işareti çevrilir → büyük = iyi.
 */
function searchLexical(db, queryText, k = 5) {
  if (!LEX_OK.has(db)) return [];
  const match = ftsMatchQuery(queryText);
  if (!match) return [];
  const rows = db
    .prepare(
      `SELECT c.doc_path, c.heading_path, c.line_start, c.line_end, c.text, d.name, d.scope,
              bm25(chunks_fts) AS bm
         FROM chunks_fts
         JOIN chunks c ON c.id = chunks_fts.rowid
         JOIN docs d   ON d.path = c.doc_path
        WHERE chunks_fts MATCH ?
        ORDER BY bm
        LIMIT ?`,
    )
    .all(match, k);
  return rows.map((r) => ({
    docPath: r.doc_path,
    name: r.name,
    scope: r.scope,
    headingPath: JSON.parse(r.heading_path),
    lineStart: Number(r.line_start),
    lineEnd: Number(r.line_end),
    text: r.text,
    score: -Number(r.bm),
  }));
}

/**
 * Sorguda AYIRT EDİCİ bir tam terim var mı? ("bulamadım" kararının ikinci kanıtı)
 *
 * İki eleme birlikte çalışır:
 *  1. KÖKLERE BAKILMAZ, yalnız jetonun HAM hâli aranır. Kelime katmanı 5-harf kök de
 *     indekslediği için alakasız bir sorgu bile eşleşme üretir ("teleferik" → "telef"
 *     → "telefon"); kök kanıtı bu yüzden kanıt sayılmaz.
 *  2. SIK GEÇEN TERİM KANIT DEĞİLDİR. İlk sürümde yalnız "geçiyor mu" soruluyordu ve
 *     ÖLÇÜM 8 saçma sorgunun 5'inin sızdığını gösterdi: "lahmacun tarifi nasıl
 *     yapılır" / "mars gezegeninde su var mı" gibi cümlelerde konu kelimeleri korpusta
 *     YOK ama "nasıl", "var", "su" elbette VAR. Ayırt edici olan NADİRLİKTİR: bir
 *     terim korpusun küçük bir kısmında geçiyorsa o sorguyu gerçekten "bir şeye"
 *     bağlar; her yerde geçiyorsa hiçbir şeye bağlamaz.
 *
 * @param {number} minLen 3'ten kısa jetonlar atlanır ("k", "mi" ayırt edici değil)
 * @param {number} maxRatio bir terim korpusun bundan fazlasında geçiyorsa kanıt sayılmaz
 */
function hasExactTermEvidence(db, queryText, { minLen = 3, maxRatio = 0.01, maxTerms = 16 } = {}) {
  if (!LEX_OK.has(db)) return false;
  const raw = [...new Set(tokens(queryText))].filter((t) => t.length >= minLen).slice(0, maxTerms);
  if (!raw.length) return false;
  const total = Number(db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n) || 1;
  // Taban 20: küçük bir hafızada "%1" sıfıra yuvarlanır ve HER terim sık sayılırdı.
  const cap = Math.max(20, Math.floor(total * maxRatio));
  // LIMIT cap+1 ile sayıyoruz: tam df'yi hesaplamaya gerek yok, "cap'i aştı mı" yeter.
  const stmt = db.prepare('SELECT COUNT(*) AS n FROM (SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ? LIMIT ?)');
  for (const t of raw) {
    try {
      const n = Number(stmt.get(`"${t.replace(/"/g, '""')}"`, cap + 1).n);
      if (n > 0 && n <= cap) return true;
    } catch {
      /* bozuk jeton — sıradaki */
    }
  }
  return false;
}

module.exports = {
  SCHEMA_VERSION,
  contentHash,
  fingerprintOf,
  encodeVector,
  decodeVector,
  openIndex,
  openIndexForSearch,
  listDocs,
  upsertDoc,
  touchDoc,
  deleteDoc,
  stats,
  chunksOf,
  searchVectors,
  hasLexIndex,
  hasExactTermEvidence,
  ensureLexIndex,
  searchLexical,
};
