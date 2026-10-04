// CrewPane — SEARCH-2 (bumblebee) İNDEKSLEME ÇOCUK SÜRECİ.
//
// NEDEN AYRI SÜREÇ: tam kurulum prototipte 18,8 s sürdü ve bunun büyük kısmı SENKRON
// disk okuma + FTS5 yazma. main'de koşsaydı Electron'un olay döngüsü o süre boyunca
// bloklanır, pencere boyanmaz — "uygulama dondu". Desen ADP-870'in
// `memoryIndexWorker.cjs`inden alındı (fork + ELECTRON_RUN_AS_NODE + process.send).
//
// 🔴 FTS5 ŞARTI: bu süreç Electron'un node'uyla koşar (24.16, ENABLE_FTS5 açık).
// Sistem Node 23.6'da FTS5 YOK — depo yine açılır ama arama boş döner; `ready`
// mesajı bunu `fts:false` ile SÖYLER (sessiz bir yarım-kurulum yerine görünür eksik).
//
// Elle koşturma (ölçüm):
//   ELECTRON_RUN_AS_NODE=1 <Electron> electron/searchIndexWorker.cjs \
//     --db /tmp/search.db --repo <crewpane> --workspace <CrewPane Apps> [--sessions 0]

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('./searchIndexStore.cjs');
const sources = require('./searchIndexSources.cjs');
const transcripts = require('../services/transcriptReader.cjs');
const childIpc = require('../core/childIpcSafe.cjs'); // ONNX-CRASH-02 — kapalı kanala send

function argOf(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// ONNX-CRASH-02 — aynı çıplak `process.send` deseni burada da vardı. Bu çocuk ONNX
// yüklemediği için SIGABRT yerine "Unhandled 'error' event" ile ölürdü; kusur ve
// düzeltme aynı (gerekçe: childIpcSafe.cjs başlığı).
function emit(msg) {
  const payload = { ...msg, rssMb: Math.round(process.memoryUsage().rss / 1048576) };
  childIpc.safeSend(payload);
}

childIpc.installChildGuards({ label: 'searchIndexWorker', send: emit });

// MEMIDX-LEAK-01 — YETİM NÖBETÇİSİ (memoryIndexWorker ile AYNI kural; gerekçe:
// childIpcSafe.cjs · installOrphanGuard). Bu çocuk 4,5 GB oturum geçmişini tarayabilir;
// ebeveynsiz kaldığında sürdürmesinin hiçbir alıcısı yoktur.
let stopRequested = false;
childIpc.installOrphanGuard({
  label: 'searchIndexWorker',
  onOrphan: () => { stopRequested = true; },
});

const nowMs = () => Number(process.hrtime.bigint()) / 1e6;

/**
 * Dosya-tabanlı kaynakları senkronla: yeni/değişen yazılır, KAYBOLAN silinir.
 * Silme adımı şart — silinmiş bir rapor aramada durmaya devam ederse kullanıcı
 * olmayan bir dosyaya tıklar (arama sonucunun en kötü yalanı).
 */
function syncDocs(db, type, docs) {
  const t0 = nowMs();
  const counts = { inserted: 0, updated: 0, unchanged: 0, removed: 0 };
  const seen = new Set();
  db.exec('BEGIN');
  try {
    for (const d of docs) {
      seen.add(d.key);
      counts[store.upsertDoc(db, d)]++;
    }
    for (const row of store.listKeys(db, type)) {
      if (!seen.has(row.key)) {
        store.deleteDoc(db, row.key);
        counts.removed++;
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { ...counts, docs: docs.length, ms: Math.round(nowMs() - t0) };
}

/**
 * OTURUMLAR — artımlı ve MTIME SÜZGEÇLİ.
 *
 * Prototipte artımlı koşu bile 4,3 GB okudu (~16 s), çünkü "değişti mi" sorusu ancak
 * dosya açılınca cevaplanıyordu. Burada cevap `stat`tan gelir: mtime+boyut aynıysa
 * dosya AÇILMAZ. Ölçüm raporda: okunan GB vs indekslenen MB.
 */
async function syncSessions(db, { home, enabled, budgetMs = 0 }) {
  const t0 = nowMs();
  const counts = { inserted: 0, updated: 0, unchanged: 0, removed: 0, skippedByMtime: 0, filesRead: 0, bytesRead: 0, textBytes: 0, masked: 0, empty: 0 };

  if (!enabled) {
    // OPT-OUT: kapalıyken oturum belgeleri indekste DURMAZ (kapatmak "gizle" değil "sil").
    db.exec('BEGIN');
    for (const row of store.listKeys(db, 'session')) {
      store.deleteDoc(db, row.key);
      counts.removed++;
    }
    db.exec('COMMIT');
    return { ...counts, disabled: true, ms: Math.round(nowMs() - t0) };
  }

  const files = transcripts.listTranscriptFiles({ home });
  const seen = new Set();
  const stats = transcripts.emptyStats();

  for (const f of files) {
    seen.add(f.file);
    const old = store.getDoc(db, f.file);
    if (old && old.mtime === Math.round(f.mtimeMs) && old.size === f.size) {
      counts.unchanged++;
      counts.skippedByMtime++;
      continue;
    }
    if (stopRequested) break; // MEMIDX-LEAK-01 — ebeveyn gitti: dosya sınırında dur
    if (budgetMs && nowMs() - t0 > budgetMs) break; // sonraki turda devam eder
    let doc = null;
    try {
      counts.filesRead++;
      doc = await transcripts.readTranscript(f.file, f.engine, { stats, home });
    } catch {
      continue; // okunamayan defter turu bozmaz
    }
    if (!doc) {
      counts.empty++;
      // Boş oturumu da DEFTERE yaz: yoksa her turda yeniden okunur (4,3 GB'ın
      // asıl bedeli budur). Parçasız belge aramada görünmez.
      db.exec('BEGIN');
      store.upsertDoc(db, { type: 'session', key: f.file, title: '', path: transcripts.tildify(f.file, home), meta: { engine: f.engine, empty: true }, mtime: Math.round(f.mtimeMs), size: f.size, chunks: [] });
      db.exec('COMMIT');
      continue;
    }
    doc.mtime = Math.round(f.mtimeMs);
    doc.size = f.size;
    db.exec('BEGIN');
    counts[store.upsertDoc(db, doc)]++;
    db.exec('COMMIT');
  }

  db.exec('BEGIN');
  for (const row of store.listKeys(db, 'session')) {
    if (!seen.has(row.key)) {
      store.deleteDoc(db, row.key);
      counts.removed++;
    }
  }
  db.exec('COMMIT');

  counts.bytesRead = stats.bytes;
  counts.textBytes = stats.textBytes;
  counts.masked = stats.masked;
  return { ...counts, files: files.length, ms: Math.round(nowMs() - t0) };
}

function readTasks(file) {
  if (!file) return [];
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function main() {
  const dbFile = argOf('db');
  const repoRoot = argOf('repo', process.cwd());
  const workspaceRoot = argOf('workspace', path.resolve(repoRoot, '..'));
  const home = argOf('home', os.homedir());
  const tasksFile = argOf('tasks', '');
  const sessionsEnabled = argOf('sessions', '1') !== '0';
  const budgetMs = Number(argOf('budget', '0')) || 0;

  if (!dbFile) {
    emit({ phase: 'error', reason: '--db şart' });
    process.exitCode = 2;
    return;
  }
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });

  const t0 = nowMs();
  const db = store.openIndex({ file: dbFile });
  const report = { phase: 'done', fts: store.hasFts(db), contentless: store.isContentless(db), sources: {} };
  emit({ phase: 'start', fts: report.fts });

  try {
    report.sources.report = syncDocs(db, 'report', sources.collectReports({ repoRoot }));
    emit({ phase: 'progress', source: 'report', ...report.sources.report });

    report.sources.memory = syncDocs(db, 'memory', sources.collectMemory({ workspaceRoot }));
    emit({ phase: 'progress', source: 'memory', ...report.sources.memory });

    const taskRows = readTasks(tasksFile);
    if (taskRows.length) {
      report.sources.task = syncDocs(db, 'task', sources.collectTasks(taskRows));
      emit({ phase: 'progress', source: 'task', ...report.sources.task });
    }

    report.sources.session = await syncSessions(db, { home, enabled: sessionsEnabled, budgetMs });
    emit({ phase: 'progress', source: 'session', ...report.sources.session });

    // VACUUM ÖLÇÜLDÜ: 772 ms ve tam kurulumda 5 MB kazandırıyor — ama ARTIMLI turda
    // hiçbir şey kazandırmadan turun dörtte birini yiyor (3.186 ms'nin 772'si).
    // O yüzden yalnız ağaç GERÇEKTEN değiştiyse koşar.
    const changed = Object.values(report.sources).reduce(
      (n, r) => n + (r.inserted || 0) + (r.updated || 0) + (r.removed || 0),
      0,
    );
    store.optimize(db, { vacuum: changed > 200 });
    report.changed = changed;
    report.stats = store.stats(db);
    report.ms = Math.round(nowMs() - t0);
    try {
      report.dbBytes = fs.statSync(dbFile).size;
    } catch {
      report.dbBytes = 0;
    }
    db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('lastBuild', JSON.stringify({ at: Date.now(), ms: report.ms, sources: report.sources }));
  } catch (err) {
    emit({ phase: 'error', reason: err && err.message ? err.message : String(err) });
    process.exitCode = 1;
    try {
      db.close();
    } catch {
      /* kapanmadıysa süreç zaten ölüyor */
    }
    return;
  }
  try {
    db.close();
  } catch {
    /* yok sayılır */
  }
  emit(report);
}

if (require.main === module) {
  main().catch((err) => {
    emit({ phase: 'error', reason: err && err.message ? err.message : String(err) });
    process.exitCode = 1;
  });
}

module.exports = { syncDocs, syncSessions, readTasks };
