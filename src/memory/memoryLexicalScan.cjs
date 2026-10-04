// CrewPane — ADP-862 (st1) KELİME KATMANI, FTS5'SİZ YOL (saf JS BM25 taraması).
//
// ── NEDEN VAR (ölçülmüş bir tuzak) ──────────────────────────────────────────
// ADP-871 kelime katmanını SQLite'ın GÖMÜLÜ FTS5'ine kurdu ve bunu doğru ölçtü:
// **Electron 42'nin** `node:sqlite`'ında `ENABLE_FTS5` AÇIK. Ama ajanların
// çalıştırdığı komut Electron değil, SİSTEM `node`'udur — ve orada FTS5 YOK:
//
//     $ node -e "…openIndexForSearch(...); store.searchLexical(db,'x')"
//     Error: no such module: fts5      (Node v23.6.1, node:sqlite)
//
// 🪤 Ve bu hata SESSİZ bir yanlış-pozitifle geliyor: `chunks_fts` sanal tablosunu
// Electron zaten YARATMIŞ olduğu için `CREATE VIRTUAL TABLE IF NOT EXISTS` hata
// vermiyor → `hasLexIndex(db)` **true** diyor, sorgu ise patlıyor. Yani "kelime
// katmanı var mı" sorusunun cevabı ancak GERÇEK BİR SORGU ile alınabilir.
//
// Bu modül o boşluğu kapatır: `chunks` DÜZ bir tablodur (FTS5 gerekmez), 4 440
// parçayı okuyup JS'te BM25 koşmak ÖLÇÜLDÜ — okuma 64 ms + analiz 36 ms. Bir CLI
// çağrısı için bedelsiz sayılır; karşılığında komut her ortamda çalışır.
//
// Sıralama fonksiyonu FTS5'in bm25()'iyle AYNI ailedendir (k1/b aynı varsayılanlar)
// ve jetonlar AYNI analizörden (memoryLexical.analyze) geçer → iki yol arasında
// sistematik bir sapma yok. Sonuç ŞEKLİ de store.searchLexical ile birebir aynıdır,
// böylece memoryHybrid ikisini ayırt etmeden birleştirebilir.
//
// Saf: yalnız repo modülleri, DB bağı çağıranın verdiği satır dizisinde → node --test.

'use strict';

const { analyze } = require('./memoryLexical.cjs');

const K1 = 1.2;
const B = 0.75;

/**
 * Satırları BM25 ile sırala.
 * @param {Array<{docPath:string,name?:string,scope?:string,headingPath?:any,
 *                lineStart?:number,lineEnd?:number,text:string}>} rows
 * @param {string} queryText
 * @param {number} k
 * @returns {Array} store.searchLexical ile AYNI şekil (score: büyük = iyi)
 */
function scanLexical(rows, queryText, k = 5) {
  const qTerms = [...new Set(analyze(queryText))];
  if (!qTerms.length || !Array.isArray(rows) || !rows.length) return [];

  const docs = [];
  let totalLen = 0;
  const df = new Map();
  for (const r of rows) {
    const head = Array.isArray(r.headingPath) ? r.headingPath.join(' ') : String(r.headingPath || '');
    const toks = analyze(`${r.name || ''} ${head} ${r.text || ''}`);
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    docs.push({ row: r, tf, len: toks.length });
    totalLen += toks.length;
    for (const t of qTerms) if (tf.has(t)) df.set(t, (df.get(t) || 0) + 1);
  }
  const N = docs.length;
  const avg = totalLen / N || 1;

  const idf = new Map();
  for (const t of qTerms) {
    const n = df.get(t) || 0;
    // FTS5 bm25()'in kullandığı olasılıksal IDF (negatife düşmemesi için +1'li hâli).
    idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
  }

  const scored = [];
  for (const d of docs) {
    let s = 0;
    for (const t of qTerms) {
      const f = d.tf.get(t);
      if (!f) continue;
      s += idf.get(t) * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.len) / avg)));
    }
    if (s > 0) scored.push({ s, d });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, k).map(({ s, d }) => ({
    docPath: d.row.docPath,
    name: d.row.name || '',
    scope: d.row.scope || '',
    headingPath: Array.isArray(d.row.headingPath) ? d.row.headingPath : [],
    lineStart: d.row.lineStart ?? null,
    lineEnd: d.row.lineEnd ?? null,
    text: d.row.text || '',
    score: s,
  }));
}

/**
 * FTS5 GERÇEKTEN çalışıyor mu? `hasLexIndex` YETMEZ (yukarıdaki tuzak) — tek yol
 * gerçek bir sorgu denemektir.
 * @returns {boolean}
 */
function ftsUsable(db) {
  try {
    db.prepare('SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ? LIMIT 1').get('"a"');
    return true;
  } catch {
    return false;
  }
}

/** `chunks`+`docs`'tan tarama satırlarını oku (FTS5 gerekmez). */
function readChunkRows(db, { limit = 0 } = {}) {
  const sql =
    `SELECT c.doc_path, c.heading_path, c.line_start, c.line_end, c.text, d.name, d.scope
       FROM chunks c JOIN docs d ON d.path = c.doc_path` + (limit ? ` LIMIT ${Number(limit) | 0}` : '');
  return db
    .prepare(sql)
    .all()
    .map((r) => ({
      docPath: r.doc_path,
      name: r.name,
      scope: r.scope,
      headingPath: (() => {
        try {
          return JSON.parse(r.heading_path);
        } catch {
          return [];
        }
      })(),
      lineStart: Number(r.line_start),
      lineEnd: Number(r.line_end),
      text: r.text,
    }));
}

/**
 * "Sorguda ayırt edici TAM terim var mı" kanıtı — store.hasExactTermEvidence'ın
 * FTS5'siz eşleniği (alaka tabanının ikinci kanıtı; bkz. memoryHybrid.MIN_SCORE).
 * Kökler DEĞİL yalnız ham jetonlar sayılır ve sık terim kanıt sayılmaz.
 */
function hasExactTermEvidenceScan(rows, queryText, { minLen = 3, maxRatio = 0.01 } = {}) {
  const { tokens } = require('../voice/turkishMorph.cjs');
  const raw = [...new Set(tokens(queryText))].filter((t) => t.length >= minLen).slice(0, 16);
  if (!raw.length || !rows.length) return false;
  const cap = Math.max(20, Math.floor(rows.length * maxRatio));
  const counts = new Map(raw.map((t) => [t, 0]));
  for (const r of rows) {
    const head = Array.isArray(r.headingPath) ? r.headingPath.join(' ') : '';
    const set = new Set(analyze(`${r.name || ''} ${head} ${r.text || ''}`));
    for (const t of raw) if (set.has(t)) counts.set(t, counts.get(t) + 1);
  }
  for (const t of raw) {
    const n = counts.get(t);
    if (n > 0 && n <= cap) return true;
  }
  return false;
}

module.exports = { K1, B, scanLexical, ftsUsable, readChunkRows, hasExactTermEvidenceScan };
