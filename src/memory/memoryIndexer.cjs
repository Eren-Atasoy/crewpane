// CrewPane — ADP-870 (SPRINT-MEMORY-SEARCH · Faz 2) indeksleme boru hattı.
//
// Tarama → ARTIMLI fark → parçalama → gömme → SQLite. Faz 2 kapsamı YALNIZ hafıza
// (`.crewpane/memory/**` + global `~/.crewpane[-dev]/memory/**`); sonuç raporları
// Faz 4'te açılacak (ADP-872) — kapsam `SCOPES` sabitiyle tek yerden genişler.
//
// ARTIMLI OLMANIN İKİ KADEMESİ (ikisi de gerekli):
//   1. mtime + boyut AYNI → dosya HİÇ OKUNMAZ. Asıl hızı bu verir: 785 dosyanın
//      985 K jetonunu yeniden gömmek dakikalar, damgaya bakmak milisaniyeler.
//   2. damga kaymış ama sha1 AYNI → yalnız damga tazelenir, YENİDEN GÖMÜLMEZ.
//      (git checkout / rsync / dosyayı açıp kaydetmek mtime'ı kaydırır, içerik durur.)
// Yalnız (1) olsaydı her `git checkout` tüm indeksi çöpe atardı; yalnız (2) olsaydı
// her taramada 3 MB okunurdu. İkisi birlikte "değişmeyen dosya yeniden işlenmesin"
// gereğini KANITLANABİLİR biçimde karşılıyor (bkz. ADP-870 raporu, artımlı ölçümü).
//
// MEMORY.md DIŞLANMAZ: indeks dosyaları da hafızanın parçası. Faz 3 ölçerse ve
// gürültü yaptıkları çıkarsa `name = 'MEMORY.md'` süzgeci ORADA eklenir — burada
// sessizce dışlamak, sonraki fazın ölçümünü açıklanamaz kılardı.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const agentMemory = require('./agentMemory.cjs');
const chunker = require('./memoryChunker.cjs');
const store = require('./memoryIndexStore.cjs');

/** Bir dizindeki *.md dosyalarını (alt dizinler dahil) topla. Yoksa []. */
function walkMd(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkMd(p, out);
    else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

/**
 * Faz 2 korpusu: hafıza dosyaları (ajan + paylaşılan + global).
 * @returns {{path:string,scope:string,name:string,mtimeMs:number,size:number}[]} yola göre sıralı
 */
function scanMemoryFiles({ workspaceRoot, homedir = os.homedir(), statImpl = fs.statSync } = {}) {
  const found = [];
  const push = (file, scope) => {
    try {
      const st = statImpl(file);
      found.push({ path: file, scope, name: path.basename(file), mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      /* koşu sırasında silinmiş olabilir — yok say */
    }
  };

  const memRoot = agentMemory.workspaceMemoryRoot(workspaceRoot);
  if (memRoot) {
    const agentsDir = path.join(memRoot, 'agents');
    let agentDirs = [];
    try {
      agentDirs = fs.readdirSync(agentsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      /* henüz ajan hafızası yok */
    }
    for (const a of agentDirs) for (const f of walkMd(path.join(agentsDir, a))) push(f, a);
    for (const f of walkMd(agentMemory.sharedMemoryDir(workspaceRoot))) push(f, 'shared');
  }
  for (const f of walkMd(agentMemory.globalMemoryDir(homedir))) push(f, 'global');

  found.sort((a, b) => a.path.localeCompare(b.path));
  return found;
}

/**
 * ARTIMLI plan. SAF: dosya okuma `readImpl` ile enjekte edilir.
 * @param {Map<string,{hash,mtimeMs,size}>} existing indeksteki durum
 * @param {{path,scope,name,mtimeMs,size}[]} files diskteki durum
 * @returns {{toIndex:[],toTouch:[],toDelete:string[],unchanged:number,readCount:number}}
 */
function planWork(existing, files, { readImpl = (p) => fs.readFileSync(p, 'utf8'), hashImpl = store.contentHash, needVectors = false } = {}) {
  const toIndex = [];
  const toTouch = [];
  const seen = new Set();
  let unchanged = 0;
  let readCount = 0;
  let missingVectors = 0;

  for (const f of files) {
    seen.add(f.path);
    const prev = existing.get(f.path);
    // ADP-900 — VEKTÖR BORCU. Dosya değişmemiş olabilir ama modelsiz (yalnız kelime)
    // indekslenmişse anlam katmanı o dokümanı GÖREMEZ. Kullanıcı modeli sonradan
    // indirdiğinde damga eşleşmesi bu dosyaları sonsuza dek atlardı — bu yüzden
    // "vektörü yok" hâli değişiklikle AYNI ağırlıkta bir yeniden-işleme sebebidir.
    const vecDebt = needVectors && prev && !prev.vecDim;
    if (vecDebt) missingVectors++;
    // Kademe 1 — damga aynı: dosyayı HİÇ AÇMA.
    if (!vecDebt && prev && prev.mtimeMs === Math.round(f.mtimeMs) && prev.size === f.size) {
      unchanged++;
      continue;
    }
    let text;
    try {
      text = readImpl(f.path);
      readCount++;
    } catch {
      continue; // okunamıyorsa (silindi/izin) bu turda atla
    }
    const hash = hashImpl(text);
    // Kademe 2 — damga kaymış ama içerik aynı: yeniden GÖMME, damgayı tazele.
    // (Vektör borcu varsa bu kısayol KAPALI: tazelemek vektörü yazmaz.)
    if (!vecDebt && prev && prev.hash === hash) {
      toTouch.push({ ...f, hash });
      continue;
    }
    toIndex.push({ ...f, hash, text });
  }

  const toDelete = [...existing.keys()].filter((p) => !seen.has(p));
  return { toIndex, toTouch, toDelete, unchanged, readCount, missingVectors };
}

/**
 * İndekslemeyi koştur. `onProgress` her adımda çağrılır (çocuk süreç bunu ebeveyne
 * yollar). `embedder` = memoryEmbedder.createEmbedder çıktısı — ADP-900'den beri
 * **null olabilir**: model kurulu değilken indeks yalnız kelime katmanıyla kurulur.
 *
 * Toplu gömme: BATCH parça birlikte gömülür (ONNX toplu işte belirgin hızlı).
 * İptal: `shouldStop()` true dönerse döngü DOSYA SINIRINDA temiz durur — yarım
 * doküman yazılmaz, bir sonraki koşu kaldığı yerden devam eder (artımlı fark
 * zaten "hangi dosya eksik"i biliyor).
 */
async function runIndex({
  db,
  files,
  embedder,
  chunkOptions = {},
  batchSize = 16,
  onProgress = () => {},
  shouldStop = () => false,
  now = Date.now,
  // ONNX-CRASH-01 — zehirli belge defteri kancası. null olabilir (test/CLI):
  // koruma kapanır, indeksleme aynen koşar.
  poison = null,
}) {
  // ADP-900 — `embedder` NULL olabilir: model kurulu değilken indeks YİNE kurulur,
  // yalnız kelime katmanıyla. Faz 2'de bu yol yoktu ve sonuç şuydu: müşterinin
  // kurulumunda indeks HİÇ oluşmuyordu (ölçüldü, ADP-872 §5.2).
  const lexicalOnly = !embedder || typeof embedder.embed !== 'function';
  const existing = store.listDocs(db);
  const plan = planWork(existing, files, { needVectors: !lexicalOnly });

  const totals = {
    scanned: files.length,
    toIndex: plan.toIndex.length,
    toTouch: plan.toTouch.length,
    toDelete: plan.toDelete.length,
    unchanged: plan.unchanged,
    readCount: plan.readCount,
    missingVectors: plan.missingVectors || 0,
    lexicalOnly,
  };
  onProgress({ phase: 'planned', ...totals });

  for (const p of plan.toDelete) store.deleteDoc(db, p);
  for (const t of plan.toTouch) store.touchDoc(db, t.path, t.mtimeMs, t.size);

  let done = 0;
  let chunksWritten = 0;
  let failed = 0;
  const startedAt = now();
  for (const doc of plan.toIndex) {
    if (shouldStop()) {
      onProgress({ phase: 'stopped', done, total: plan.toIndex.length, chunks: chunksWritten });
      return { ...totals, indexed: done, chunks: chunksWritten, failed, stopped: true, elapsedMs: now() - startedAt };
    }
    // 🔴 ONNX-CRASH-01 — UÇUŞTAKİ BELGE ÖNCEDEN BİLDİRİLİR. Gömme çocuğu C++
    // tarafında (SIGTRAP/OOM) ölürse yakalanacak bir JS hatası YOKTUR; ebeveyn
    // "öldüğünde elinde ne vardı" sorusunu yalnız BU olayla cevaplayabilir ve
    // zehirli-belge çentiğini ona atar (memoryIndexPoison.cjs).
    onProgress({ phase: 'doc', path: doc.path, file: doc.name, scope: doc.scope, done, total: plan.toIndex.length });
    const chunks = chunker.chunkMarkdown(doc.text, chunkOptions);
    let vectors = null;
    try {
      if (!lexicalOnly) {
        vectors = [];
        for (let i = 0; i < chunks.length; i += batchSize) {
          const batch = chunks.slice(i, i + batchSize).map((c) => chunker.embedTextFor(c));
          vectors.push(...(await embedder.embed(batch)));
        }
      }
    } catch (err) {
      // Yakalanabilir gömme arızası TÜM KOŞUYU düşürmez: belge atlanır, çentik
      // atılır, sıradakine geçilir. (Yakalanamayan ölüm ebeveynin işi.)
      failed++;
      const reason = String((err && err.message) || err);
      try {
        poison?.recordStrike?.(doc.path, 'embed_failed', doc.hash);
      } catch {
        /* defter yazılamadı — koruma zayıflar, indeksleme sürer */
      }
      onProgress({ phase: 'docFailed', path: doc.path, file: doc.name, scope: doc.scope, reason });
      continue;
    }
    store.upsertDoc(db, doc, chunks, vectors, now());
    // Sağ salim indekslendi → eski çentikler silinsin (geçici arıza kalıcı olmasın).
    try {
      poison?.clearStrikes?.(doc.path);
    } catch {
      /* yok say */
    }
    done++;
    chunksWritten += chunks.length;
    onProgress({
      phase: 'indexing',
      done,
      total: plan.toIndex.length,
      chunks: chunksWritten,
      file: doc.name,
      scope: doc.scope,
      elapsedMs: now() - startedAt,
    });
  }

  const result = { ...totals, indexed: done, chunks: chunksWritten, failed, stopped: false, lexicalOnly, elapsedMs: now() - startedAt };
  onProgress({ phase: 'done', ...result, ...store.stats(db) });
  return result;
}

module.exports = { walkMd, scanMemoryFiles, planWork, runIndex };
