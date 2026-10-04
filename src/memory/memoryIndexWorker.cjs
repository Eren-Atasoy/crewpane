// CrewPane — ADP-870 (SPRINT-MEMORY-SEARCH · Faz 2) indeksleme ÇOCUK süreci.
//
// NEDEN AYRI SÜREÇ (uygulamanın donmama şartı): ONNX çıkarımı CPU'da SENKRON koşar.
// Bunu main'de çalıştırmak Electron'un olay döngüsünü her partide bloklar → pencere
// boyanmaz, tıklamalar birikir, "uygulama dondu". Ayrı süreç ayrıca ADP-869'da
// ölçülen ~2.5 GB tepe belleği İZOLE eder: iş bitince süreç ölür, RAM tam geri döner
// (whisperLocal'ın "boşta kapan, RAM'i geri ver" disiplininin aynısı).
//
// Ebeveyn `fork` ile başlatır (ELECTRON_RUN_AS_NODE=1 → paketli app sistem Node'una
// muhtaç olmaz — main.js startNextServer deseninin aynısı). İlerleme `process.send`
// ile gider; IPC kanalı yoksa (elle koşturma/ölçüm) stdout'a JSONL basar.
//
// Elle koşturma (ölçüm):
//   CREWPANE_EMBED_RUNTIME_DIR=... CREWPANE_EMBED_MODELS_DIR=... \
//   node electron/memoryIndexWorker.cjs --workspace <kök> --db <dosya>

'use strict';

const os = require('node:os');
const embedder = require('./memoryEmbedder.cjs');
const indexer = require('./memoryIndexer.cjs');
const store = require('./memoryIndexStore.cjs');
const chunker = require('./memoryChunker.cjs');
const poisonLedger = require('./memoryIndexPoison.cjs'); // ONNX-CRASH-01 — zehirli belge defteri
const childIpc = require('../core/childIpcSafe.cjs'); // ONNX-CRASH-02 — kapalı kanala send

function argOf(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// 🪤 ADP-870'te ÖLÇÜLDÜ: model yüklendikten sonra `process.exit()` çağırmak süreci
// **SIGABRT (134)** ile düşürüyor —
//   `libc++abi: … std::__1::system_error: mutex lock failed: Invalid argument`
// Sebep dispose DEĞİL (izole edildi: dispose'lu/dispose'suz fark etmiyor); sebep
// `process.exit`in onnxruntime'ın iş parçacığı havuzu HÂLÂ AYAKTAYKEN C++ statik
// yıkıcılarını koşturması. Ölçüm (abort-isolate: 4 varyant):
//   dispose + exit()      → 134      nodispose + exit()      → 134
//   dispose + doğal çıkış → 0        nodispose + doğal çıkış → 0
// Veri kaybı YOKTU (her şey commit'liydi) ama çıkış kodu yalan söylüyordu.
// Çözüm: HİÇ `process.exit` çağırma — `exitCode` ata, IPC kanalını kapat, olay
// döngüsünün boşalmasını bekle. Havuz bir nedenle kapanmazsa güvenlik ağı devreye
// girer (aşağıda) — o noktada bütün veri zaten diskte.
const EXIT_GRACE_MS = Number(process.env.CREWPANE_INDEX_EXIT_GRACE_MS || 8000);
function finish(code) {
  process.exitCode = code;
  try {
    if (typeof process.disconnect === 'function' && process.connected) process.disconnect();
  } catch {
    /* kanal zaten kapalı */
  }
  // Güvenlik ağı: yerli iş parçacığı takılırsa süreci SIGKILL ile bitir. SIGKILL
  // yıkıcı koşturmaz → abort mesajı da basılmaz. Ebeveyn `phase:exit`i çoktan aldı.
  const t = setTimeout(() => process.kill(process.pid, 'SIGKILL'), EXIT_GRACE_MS);
  if (typeof t.unref === 'function') t.unref();
}

// 🔴 ONNX-CRASH-02 — çıplak `process.send` BURADA da vardı. Ebeveyn giderse (uygulama
// kapanır, e2e koşusu biter, komşu `pkill` atar) bir sonraki ilerleme satırı süreci
// SIGABRT ile düşürüyordu: kapalı kanal → dinleyicisiz 'error' olayı → uncaughtException
// → exit → onnxruntime statik yıkıcıları. `safeSend` kanal kapalıysa sessizce false
// döner; IPC hiç yoksa (elle ölçüm) satır stdout'a JSONL olarak düşer — eski davranış.
function emit(msg) {
  const payload = { ...msg, rssMb: Math.round(process.memoryUsage().rss / 1048576) };
  childIpc.safeSend(payload);
}

// Yakalanmamış istisna artık ebeveyne taşınır ve süreç SIGKILL güvenlik ağıyla biter
// (SIGKILL yıkıcı koşturmaz → .ips YOK, kullanıcıya çökme diyaloğu YOK).
childIpc.installChildGuards({ label: 'memoryIndexWorker', send: emit, graceMs: EXIT_GRACE_MS });

// MEMIDX-LEAK-01 — DURDURMA BAYRAĞI ARTIK MODÜL SEVİYESİNDE. Eskiden `main()`in
// yerelindeydi; ebeveynin gidişini duyan nöbetçi ona ULAŞAMAZDI. Üç durdurucu (stop
// mesajı, SIGTERM, IPC disconnect) tek bayrağa yazar, `runIndex` her DOSYA sınırında
// onu okur → yarım doküman yazılmaz.
let stopRequested = false;

// 🔴 MEMIDX-LEAK-01 — YETİM NÖBETÇİSİ. Ebeveyn gidince (uygulama kapanır, e2e koşusu
// biter, Force Quit) bu süreç 1968 dosyalık indekslemeye SAATLERCE devam ediyordu:
// 07.09 gecesi 48 yetim, loadavg 229. Gerekçe ve "bunu ONNX-CRASH-02 açtı" ölçümü:
// childIpcSafe.cjs · installOrphanGuard başlığı.
childIpc.installOrphanGuard({
  label: 'memoryIndexWorker',
  onOrphan: () => { stopRequested = true; },
});

/**
 * Bu koşunun parmak izi — model/dtype/boyut/parçalama parametreleri.
 *
 * 🔴 WIN-W6A — PARMAK İZİ SABİTLERDEN DEĞİL, ÇALIŞAN MOTORDAN TÜRER. Eskiden burada
 * `embedder.MODEL_ID/DTYPE/DIM` sabitleri yazılıydı; barındırılan motor devreye
 * girdiği anda bu bir YALAN olurdu: OpenAI'nin 1536 boyutlu vektörleri indekse
 * "bge-m3 q8 1024" damgasıyla girer, `openIndex` hiçbir uyuşmazlık göremez ve
 * indeks İKİ AYRI VEKTÖR UZAYINI sessizce karıştırırdı — arama gürültü döndürür,
 * hiçbir hata basılmazdı. Motorun kendi beyanını kullanmak, uzay değişince indeksin
 * BAŞTAN kurulmasını (`reset`) garanti eder: pahalı ama doğru.
 *
 * Motor hiç yoksa (lexicalOnly) sabitler kullanılır — bugünkü davranışın aynısı:
 * kelime katmanı kurulur, vektörler "borç" kalır, model sonradan gelince artımlı
 * plan yalnız eksikleri tamamlar.
 */
function fingerprint(eng) {
  const live = eng && eng.ok === true;
  return store.fingerprintOf({
    model: live ? eng.model : embedder.MODEL_ID,
    dtype: live ? eng.dtype : embedder.DTYPE,
    dim: live ? eng.dim : embedder.DIM,
    chunk: chunker.DEFAULTS,
  });
}

async function main() {
  const workspaceRoot = argOf('workspace', process.env.CREWPANE_WORKSPACE_ROOT || '');
  const dbFile = argOf('db', process.env.CREWPANE_MEMORY_INDEX_DB || '');
  const repoRoot = argOf('repo', process.env.CREWPANE_REPO_ROOT || '');
  const batchSize = Number(argOf('batch', process.env.CREWPANE_EMBED_BATCH || '16')) || 16;
  if (!dbFile) {
    emit({ phase: 'error', reason: 'no_db_path' });
    finish(2);
    return;
  }

  // ADP-900 — MODEL YOKSA İŞ DURMAZ, KÜÇÜLÜR.
  //
  // Eskiden burada `unavailable` deyip çıkılıyordu; sonucu ölçülmüştü (ADP-872 §5.2):
  // müşterinin kurulumunda gömme modeli hiç inmediği için İNDEKS DE HİÇ OLUŞMUYORDU —
  // yani anlam katmanıyla birlikte KELİME katmanı da ölüydü. Oysa kelime katmanı
  // (FTS5/BM25) modele hiç ihtiyaç duymaz. Artık indeks her hâlükârda kurulur ve
  // vektörler "borç" olarak kalır: model sonradan indiğinde artımlı plan yalnız
  // eksik vektörleri tamamlar (memoryIndexer.planWork · needVectors).
  const eng = await embedder.createEmbedder({ homedir: os.homedir(), repoRoot: repoRoot || null });
  const lexicalOnly = !eng.ok;
  // WIN-W6A — "neden kelime-katmanı" artık İKİ nedeni birden taşır: yerel motor niye
  // yok (`reason`) VE barındırılan basamak niye devreye girmedi (`hostedReason` —
  // tipik olarak anahtar yok). `message` doğrudan kullanıcıya gösterilebilir cümledir.
  if (lexicalOnly) {
    emit({
      phase: 'lexicalOnly',
      reason: eng.reason,
      hostedReason: eng.hostedReason || null,
      message: eng.message || null,
      tried: eng.tried || [],
    });
  } else {
    emit({
      phase: 'ready',
      kind: eng.kind || 'local',
      model: eng.model,
      dtype: eng.dtype,
      dim: eng.dim,
      maxTokens: eng.maxTokens || null, // ONNX-CRASH-01 — girdi tavanı beyan edilir
      // Barındırılan dalda yerel yol alanları YOKTUR; `provider` onların yerine geçer.
      provider: eng.provider || null,
      modelsDir: eng.modelsDir || null,
      runtimeDir: eng.runtimeDir || null,
    });
  }

  const { db, reset } = store.openIndex({ file: dbFile, fingerprint: fingerprint(eng) });
  if (reset) emit({ phase: 'reset', reason: 'fingerprint_changed' });

  process.on('message', (m) => {
    if (m && m.cmd === 'stop') stopRequested = true;
  });
  process.on('SIGTERM', () => { stopRequested = true; });

  const allFiles = indexer.scanMemoryFiles({ workspaceRoot, homedir: os.homedir() });

  // ONNX-CRASH-01 — CRASH-LOOP KIRICI. Daha önce bu koşuyu ÜST ÜSTE düşürmüş
  // belgeler hiç açılmaz. Kalıcı ölüm değil: içerik değişince çentikler sıfırlanır
  // (memoryIndexPoison.recordStrike · hash karşılaştırması).
  const poisonFile = poisonLedger.poisonPath(dbFile);
  let poisoned = new Set();
  try {
    poisoned = poisonLedger.poisonedPaths({ file: poisonFile });
  } catch {
    /* defter okunamadı — koruma kapalı, indeksleme sürer */
  }
  const files = poisoned.size ? allFiles.filter((f) => !poisoned.has(f.path)) : allFiles;
  emit({ phase: 'scanned', files: files.length });
  if (poisoned.size) {
    emit({ phase: 'poisonSkipped', skipped: allFiles.length - files.length, paths: [...poisoned].slice(0, 20) });
  }

  const result = await indexer.runIndex({
    db,
    files,
    embedder: lexicalOnly ? null : eng,
    batchSize,
    onProgress: emit,
    shouldStop: () => stopRequested,
    poison: {
      recordStrike: (docPath, reason, hash) => poisonLedger.recordStrike({ file: poisonFile, docPath, reason, hash }),
      clearStrikes: (docPath) => poisonLedger.clearStrikes({ file: poisonFile, docPath }),
    },
  });

  if (!lexicalOnly) await eng.close();
  // Kapanış sayıları AYRI adlarla gider: `result.chunks` BU KOŞUDA yazılan parça,
  // `totalChunks` indeksin tamamı. Aynı ada yazsalardı UI "1 parça indeksli" derdi.
  const finalStats = store.stats(db);
  db.close();
  emit({
    phase: 'exit',
    ...result,
    totalDocs: finalStats.docs,
    totalChunks: finalStats.chunks,
    vectorChunks: finalStats.vectorChunks,
  });
  finish(0);
}

main().catch((err) => {
  emit({ phase: 'error', reason: String((err && err.message) || err) });
  finish(1);
});
