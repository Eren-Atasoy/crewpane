// CrewPane — SEARCH-2 (bumblebee) GENEL ARAMA DEPOSU (SQLite FTS5).
//
// SEARCH-1 hafif kaynakları (görev başlığı, ayar, komut, entegrasyon, skill)
// bellek-içi arıyor — 0-8 ms, indekse gerek yok. Bu depo AĞIR olanlar içindir:
// rapor GÖVDELERİ (1.401 dosya / 17,7 MB), hafıza (1.817), görev AÇIKLAMALARI
// (2.817) ve ajan CLI oturumları (19,5 MB metin). Prototipte tek FTS5 indeksi
// 8.208 belge / 92.105 parçayı 18,8 s'de kurdu, sorgu 0,1-20 ms (SEARCH-R1 §3).
//
// ── ADP-900'ün DEPOSU YENİDEN KULLANILMAZ, DESENİ KULLANILIR ────────────────
// `memoryIndexStore.cjs` yalnız hafıza dosyalarını ve bge-m3 VEKTÖRLERİNİ tutar;
// oraya rapor/oturum eklemek onun parmak izini bozar ve kullanıcıya 21 dakikalık
// yeniden gömme ödetir (ADP-900 §5 dersi). Bu yüzden AYRI DB, AYNI gramer:
// `memoryLexical.analyze/ftsMatchQuery` (Türkçe 5-harf kök + tam terim) ve
// FTS5 yetenek algılama (aşağıda) oradan devralındı.
//
// ── ÜÇ ÖLÇÜLMÜŞ KARAR ──────────────────────────────────────────────────────
// 1) `lex` SAKLANMAZ. Prototip DB'si 224 MB'tı çünkü `text` + `lex` + FTS üçü de
//    diskteydi; `lex` metinden HER ZAMAN yeniden türetilebilir bir ara üründür.
//    Burada FTS tablosu `content=''` + `contentless_delete=1` ile kurulur: yalnız
//    ters indeks diskte durur, sütun değerleri değil.
// 2) FTS5 GARANTİ DEĞİL — ÖLÇÜLDÜ (ADP-871 ile aynı tuzak): Electron 42'nin
//    node'unda (24.16) `ENABLE_FTS5` AÇIK, sistem Node 23.6'da "no such module:
//    fts5". Ama BURADA fark şu: indeks FTS5'İN KENDİSİDİR, eklenti değil. O yüzden
//    yetenek yoksa depo açılır (belge/parça yazılır, `stats` çalışır) ama arama boş
//    döner ve `hasFts()` bunu SÖYLER — sessiz bir yalan yerine görünür bir eksik.
// 3) `contentless_delete` de garanti değil (SQLite ≥ 3.43). Yoksa tablo klasik
//    biçimde kurulur (lex FTS'te saklanır, DB büyür) — özellik küçülür, ÇÖKMEZ.
//
// Saf değil (disk + sqlite) ama kilitsiz: tek yazar (indeksleyici süreç), çok okur.

'use strict';

const crypto = require('node:crypto');
const { analyze, ftsMatchQuery, LEX_VERSION } = require('./memoryLexical.cjs');

/** Şema sürümü — DEĞİŞİRSE indeks baştan kurulur (parmak izi). */
const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS docs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL,
  key         TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  path        TEXT NOT NULL,
  meta        TEXT NOT NULL,
  mtime       INTEGER NOT NULL,
  hash        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL,
  indexed_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS docs_type_idx ON docs(type);
CREATE TABLE IF NOT EXISTS chunks (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id INTEGER NOT NULL,
  ord    INTEGER NOT NULL,
  line   INTEGER NOT NULL,
  text   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chunks_doc_idx ON chunks(doc_id);
`;

// `title` 4×, `lex` 1× ağırlıklı bm25 — başlıkta geçen terim gövdede geçenden
// değerlidir (SEARCH-R1 §3.3-b, proto bench'inin `grouped` sorgusuyla aynı).
const FTS_CONTENTLESS = `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  title, lex, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 0');`;
const FTS_CLASSIC = `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  title, lex, tokenize='unicode61 remove_diacritics 0');`;

/** Bu veritabanında FTS5 çalışıyor mu? (WeakSet: DB başına, ADP-871 deseni) */
const FTS_OK = new WeakSet();
/** `content=''` kullanılabildi mi? (yalnız ölçüm/raporlama için) */
const CONTENTLESS = new WeakSet();

function hasFts(db) {
  return FTS_OK.has(db);
}
function isContentless(db) {
  return CONTENTLESS.has(db);
}

function contentHash(text) {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
}

/** İndeksin "aynı kurallarla üretildi mi" parmak izi. Saf. */
function fingerprintOf() {
  return JSON.stringify({ schema: SCHEMA_VERSION, lex: LEX_VERSION });
}

/**
 * İndeksi aç (yoksa kur). Parmak izi tutmuyorsa TABLOLAR SIFIRLANIR — analiz
 * kuralı değiştiğinde eski jetonlarla dolu bir indeks sessizce yanlış cevap verir
 * (ADP-871'de bir kez ödenmiş ders).
 */
function openIndex({ file, sqlite = require('node:sqlite'), readonly = false } = {}) {
  // ⚠️ `undefined` seçenek GEÇİLEMEZ: node:sqlite "options argument must be an object"
  // atar (ölçüldü). Salt-okunur açılış ayrı bir çağrıdır, ortak bir üçlü koşul değil.
  const db = readonly ? new sqlite.DatabaseSync(file, { readOnly: true }) : new sqlite.DatabaseSync(file);
  if (!readonly) {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
    db.exec(SCHEMA_SQL);
  }
  attachFts(db, { readonly });

  if (!readonly) {
    const want = fingerprintOf();
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('fingerprint');
    if (!row) {
      db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('fingerprint', want);
    } else if (row.value !== want) {
      resetIndex(db);
      db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('fingerprint', want);
    }
  }
  return db;
}

/**
 * FTS tablosunu kur; yetenek yoksa depo yine de kullanılabilir kalır.
 *
 * 🪤 SALT-OKUNUR BAĞLANTIDA `CREATE` ATAR — ve ilk yazımda tam bu oldu: okur
 * bağlantısı `CREATE VIRTUAL TABLE IF NOT EXISTS`te patlıyor, yetenek bayrağı
 * hiç kurulmuyor, `hasFts()` false dönüyor ve ARAMA HER ZAMAN BOŞ geliyordu —
 * hem de "fts_unavailable" diyerek, yani doğru sebebi göstererek yanlış yerde.
 * (e2e yakaladı: indekste 3.297 belge vardı, sorgu sıfır satır döndürüyordu.)
 * Okur için doğru soru "kurabiliyor muyum" değil "TABLO VAR MI" sorusudur.
 */
function attachFts(db, { readonly = false } = {}) {
  if (readonly) {
    try {
      db.prepare('SELECT rowid FROM chunks_fts LIMIT 1').get();
      FTS_OK.add(db);
      // Contentless olup olmadığı YAZAN tarafın kararı; okur için ölçüm dışı.
    } catch {
      /* tablo yok ya da FTS5 yok → arama kapalı, `hasFts()` bunu söyler */
    }
    return;
  }
  try {
    db.exec(FTS_CONTENTLESS);
    FTS_OK.add(db);
    CONTENTLESS.add(db);
    return;
  } catch {
    /* contentless_delete yok (SQLite < 3.43) ya da FTS5 hiç yok — sırayla dene */
  }
  try {
    db.exec(FTS_CLASSIC);
    FTS_OK.add(db);
  } catch {
    /* FTS5 yok: arama kapalı, depo açık (hasFts() bunu söyler) */
  }
}

function resetIndex(db) {
  db.exec('DELETE FROM chunks; DELETE FROM docs;');
  if (hasFts(db)) {
    try {
      db.exec('DROP TABLE chunks_fts;');
    } catch {
      /* yok sayılır */
    }
    FTS_OK.delete(db);
    CONTENTLESS.delete(db);
    attachFts(db);
  }
}

/** Bir belgenin bugünkü kaydı (artımlı planın "değişti mi" sorusu). */
function getDoc(db, key) {
  return db.prepare('SELECT id, hash, mtime, size, chunk_count FROM docs WHERE key = ?').get(key) || null;
}

/** Tip başına belge kimlikleri (silinenleri bulmak için). */
function listKeys(db, type) {
  return db.prepare('SELECT key, hash, mtime FROM docs WHERE type = ?').all(type);
}

function deleteDoc(db, key) {
  const row = db.prepare('SELECT id FROM docs WHERE key = ?').get(key);
  if (!row) return false;
  dropChunks(db, row.id);
  db.prepare('DELETE FROM docs WHERE id = ?').run(row.id);
  return true;
}

function dropChunks(db, docId) {
  if (hasFts(db)) {
    const ids = db.prepare('SELECT id FROM chunks WHERE doc_id = ?').all(docId);
    const del = db.prepare('DELETE FROM chunks_fts WHERE rowid = ?');
    for (const r of ids) {
      try {
        del.run(r.id);
      } catch {
        // Klasik (contentless olmayan) tabloda bu satır çalışır; contentless_delete
        // yoksa ve tablo contentless ise burada patlar — indeks şişer ama ÇÖKMEZ.
      }
    }
  }
  db.prepare('DELETE FROM chunks WHERE doc_id = ?').run(docId);
}

/**
 * Belge yaz (artımlı): `hash` aynıysa DOKUNMAZ ve 'unchanged' döner.
 * @param {object} doc {type,key,title,path,meta,mtime,size?,chunks:[{line,text}]}
 */
function upsertDoc(db, doc, now = Date.now()) {
  const chunks = doc.chunks || [];
  const hash = doc.hash || contentHash(`${doc.title}\n${chunks.map((c) => c.text).join('\n')}`);
  const old = getDoc(db, doc.key);
  if (old && old.hash === hash) return 'unchanged';
  if (old) {
    dropChunks(db, old.id);
    db.prepare('DELETE FROM docs WHERE id = ?').run(old.id);
  }
  const size = Number(doc.size || chunks.reduce((n, c) => n + c.text.length, 0));
  const info = db
    .prepare('INSERT INTO docs(type, key, title, path, meta, mtime, hash, size, chunk_count, indexed_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(doc.type, doc.key, String(doc.title || ''), String(doc.path || ''), JSON.stringify(doc.meta || {}), Math.round(doc.mtime || 0), hash, size, chunks.length, now);
  const docId = Number(info.lastInsertRowid);

  const insChunk = db.prepare('INSERT INTO chunks(doc_id, ord, line, text) VALUES (?,?,?,?)');
  const insFts = hasFts(db) ? db.prepare('INSERT INTO chunks_fts(rowid, title, lex) VALUES (?,?,?)') : null;
  const titleLex = analyze(String(doc.title || '')).join(' ');
  chunks.forEach((c, i) => {
    const r = insChunk.run(docId, i, Number(c.line || 0), String(c.text));
    if (insFts) insFts.run(Number(r.lastInsertRowid), titleLex, analyze(String(c.text)).join(' '));
  });
  return old ? 'updated' : 'inserted';
}

/**
 * GRUPLU SORGU — tek SQL turu, sonra JS'te tekilleştirme.
 *
 * Neden tek turda "belge başına en iyi parça" SQL'de yapılmıyor: pencere fonksiyonlu
 * sorgu FTS5 üstünde ölçülebilir biçimde yavaştı (proto bench). Bunun yerine geniş
 * bir LIMIT ile ham eşleşmeler alınır ve tekilleştirme bellekte yapılır — 8k belgede
 * fark gürültü seviyesinde, kod ise okunur kalıyor.
 */
function query(db, text, { types = null, agent = null, perType = 5, scan = 400 } = {}) {
  const t0 = Number(process.hrtime.bigint()) / 1e6;
  const out = { groups: {}, total: 0, ms: 0, fts: hasFts(db) };
  if (!hasFts(db)) return out;
  const match = ftsMatchQuery(String(text || ''));
  if (!match) return out;

  let sql = `
    SELECT c.id AS chunk_id, c.line, c.text, d.id AS doc_id, d.type, d.key, d.title, d.path, d.meta, d.mtime,
           bm25(chunks_fts, 4.0, 1.0) AS score
    FROM chunks_fts f
    JOIN chunks c ON c.id = f.rowid
    JOIN docs   d ON d.id = c.doc_id
    WHERE chunks_fts MATCH ?`;
  const args = [match];
  if (Array.isArray(types) && types.length) {
    sql += ` AND d.type IN (${types.map(() => '?').join(',')})`;
    args.push(...types);
  }
  sql += ' ORDER BY score LIMIT ?';
  args.push(Number(scan));

  let rows = [];
  try {
    rows = db.prepare(sql).all(...args);
  } catch {
    // Bozuk MATCH ifadesi kullanıcının yazdığı bir şeyden doğabilir: arama boş
    // döner, uygulama çökmez.
    return out;
  }

  const bestByDoc = new Map();
  for (const r of rows) {
    if (agent && !matchesAgent(r, agent)) continue;
    const prev = bestByDoc.get(r.doc_id);
    if (!prev || r.score < prev.score) bestByDoc.set(r.doc_id, r);
  }
  const byType = new Map();
  for (const r of bestByDoc.values()) {
    const list = byType.get(r.type) || [];
    list.push(r);
    byType.set(r.type, list);
  }
  for (const [type, list] of byType) {
    list.sort((a, b) => a.score - b.score);
    out.groups[type] = {
      total: list.length,
      hits: list.slice(0, perType).map((r) => ({
        type: r.type,
        key: r.key,
        title: r.title,
        path: r.path,
        line: r.line,
        snippet: snippetOf(r.text),
        meta: safeJson(r.meta),
        mtime: r.mtime,
        score: r.score,
      })),
    };
    out.total += list.length;
  }
  out.ms = Math.round((Number(process.hrtime.bigint()) / 1e6 - t0) * 100) / 100;
  return out;
}

/** `@ajan` daraltması: rapor dosya adı, hafıza kapsamı ya da oturumun cwd/ajanı. */
function matchesAgent(row, agent) {
  const a = String(agent).toLowerCase();
  const meta = safeJson(row.meta);
  const fields = [meta.agent, meta.scope, meta.agentId, meta.engine === 'codex' ? null : null, row.path];
  return fields.some((f) => String(f || '').toLowerCase().includes(a));
}

function safeJson(s) {
  try {
    return JSON.parse(s) || {};
  } catch {
    return {};
  }
}

/** Satırın okunur kısaltması (arama sonucu satırı 1 satırdır). */
function snippetOf(text, max = 180) {
  const one = String(text || '').replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

/**
 * Sayaçlar. `sourceBytes` ile `textBytes` BİLEREK ayrı:
 * oturumlarda kaynak 4,53 GB ham jsonl ama İNDEKSLENEN metin 20 MB (%0,44).
 * Tek bir "bytes" alanı bu farkı gizler ve raporu yalancı yapar.
 */
/** Son kurulumun damgası (`meta.lastBuild`) — "indeks VAR" ile "indeks TAZE" ayrı sorular. */
function lastBuild(db) {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('lastBuild');
    return row ? JSON.parse(row.value) : null;
  } catch {
    return null;
  }
}

function stats(db) {
  const total = db.prepare('SELECT COUNT(*) c FROM docs').get().c;
  const chunks = db.prepare('SELECT COUNT(*) c FROM chunks').get().c;
  const byType = {};
  for (const r of db.prepare('SELECT type, COUNT(*) d, COALESCE(SUM(chunk_count),0) c, COALESCE(SUM(size),0) b FROM docs GROUP BY type').all()) {
    byType[r.type] = { docs: r.d, chunks: r.c, sourceBytes: r.b, textBytes: 0 };
  }
  for (const r of db.prepare('SELECT d.type t, COALESCE(SUM(LENGTH(c.text)),0) b FROM chunks c JOIN docs d ON d.id = c.doc_id GROUP BY d.type').all()) {
    if (byType[r.t]) byType[r.t].textBytes = r.b;
  }
  return { docs: total, chunks, byType, fts: hasFts(db), contentless: isContentless(db) };
}

/**
 * Kurulum sonu bakımı (bir kez).
 * VACUUM ÖLÇÜLDÜ: 772 ms → 109,3 MB'tan 104,1 MB'a (serbest sayfaların iadesi).
 * `page_size` 8K/16K denendi, fark YOK; `detail=column` 86,7 MB veriyordu ama
 * bm25'in BAŞLIK AĞIRLIĞINI bozdu (birim testi kırmızıya döndü) → reddedildi.
 */
function optimize(db, { vacuum = true } = {}) {
  if (!hasFts(db)) return false;
  try {
    db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('optimize')");
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    if (vacuum) db.exec('VACUUM');
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  SCHEMA_VERSION,
  contentHash,
  fingerprintOf,
  openIndex,
  resetIndex,
  hasFts,
  isContentless,
  getDoc,
  lastBuild,
  listKeys,
  upsertDoc,
  deleteDoc,
  query,
  stats,
  optimize,
  snippetOf,
};
