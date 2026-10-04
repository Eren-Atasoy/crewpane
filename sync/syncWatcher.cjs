// SYNC-F1-3 (Wheeljack) — İZLEYİCİ: dosya olayı -> (debounce) -> motorun push turu.
//                         Tasarım: SYNC-F1-TASARIM.md §2.2 · §2.3 · KURAL S-1
//
// ═══════════════════════════════════════════════════════════════════════════════
// NEDEN chokidar (§2.2'nin kararı, burada UYGULANIYOR)
// ═══════════════════════════════════════════════════════════════════════════════
// Hafıza ağacı iç içedir (`memory/agents/<ajan>/`), `fs.watch(recursive:true)`
// Linux'ta DESTEKLENMEZ ve yeni bir ajan dizini açıldığında elle yeniden bağlanmak
// gerekir. chokidar üçünü de kendi içinde çözer ve `package.json`'da ZATEN doğrudan
// bağımlılıktır (4.0.3) — yeni bir bağımlılık girmiyor.
//
// ─────────────────────────────────────────────────────────────────────────────
// KURAL S-1 BURADA DA GEÇERLİ (reportsWatcher.cjs:91-95'in ölçülmüş dersi)
// ─────────────────────────────────────────────────────────────────────────────
// "Bir dizin SİLİNİP YENİDEN YARATILIRSA `fs.watch` sessizce ölür ve BİR DAHA GERİ
// GELMEZ." Motor bu yüzden dizin SİLMEZ; izleyici tarafındaki karşılığı ise şudur:
// bir kök izlemeye alınamadıysa ya da izleyici hata verdiyse SESSİZ KALINMAZ —
// `onError` çağrılır, motor yedek poll'a güvenmeye devam eder ve durum IPC'ye düşer.
// "İzliyorum" demek ile izlemek arasındaki farkı ürün ölçemezse kullanıcı ölçer.
//
// ─────────────────────────────────────────────────────────────────────────────
// DEBOUNCE 2000 ms — YOL BAŞINA (§2.3)
// ─────────────────────────────────────────────────────────────────────────────
// ADP-874'ün atomik yazımı (tmp yaz + rename) tek bir mantıksal yazım için
// birden çok olay üretir; bir ajan da tek turda aynı dosyaya onlarca kez yazar.
// Yol başına debounce, bunları TEK bir push turuna indirger. Küresel bir debounce
// yetmezdi: sürekli yazılan tek bir dosya, hiç değişmeyen diğerlerinin turunu
// sonsuza dek erteleyebilirdi (açlık).
//
// Saf değil ama TAM DI: `chokidar`/`classify`/`setTimer` enjekte edilebilir ->
// `node --test` gerçek dosya sistemi olmadan koşar.

'use strict';

const nodePath = require('node:path');
const C = require('./syncClasses.cjs');

const DEBOUNCE_MS = 2000;

/** Tek turda bildirilecek yol tavanı — kaçak nöbeti (bir `git checkout` fırtınası). */
const MAX_BATCH = 2000;

/**
 * Olay üretmemesi gereken adlar. `classify()` de bunları eler; burada ELEMEK
 * ölçülebilir bir tasarruftur: `.git/` içindeki her nesne için bir olay + bir
 * `classify()` çağrısı yapmamak.
 */
function ignoredName(name) {
  return typeof name === 'string'
    && (name.startsWith('.') || name.startsWith('.tmp-') || name.startsWith('~$'));
}

/**
 * @param {{roots:object, chokidar?:object, path?:object, platform?:string,
 *          debounceMs?:number, onChange:Function, onError?:Function, log?:Function,
 *          setTimer?:Function, clearTimer?:Function, maxBatch?:number}} deps
 */
function createSyncWatcher(deps = {}) {
  const roots = deps.roots || {};
  const path = deps.path || nodePath;
  const platform = deps.platform || process.platform;
  const debounceMs = Number.isFinite(deps.debounceMs) ? deps.debounceMs : DEBOUNCE_MS;
  const maxBatch = Number.isFinite(deps.maxBatch) ? deps.maxBatch : MAX_BATCH;
  const onChange = typeof deps.onChange === 'function' ? deps.onChange : () => {};
  const onError = typeof deps.onError === 'function' ? deps.onError : () => {};
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const setTimer = typeof deps.setTimer === 'function' ? deps.setTimer : setTimeout;
  const clearTimer = typeof deps.clearTimer === 'function' ? deps.clearTimer : clearTimeout;
  const chokidarMod = deps.chokidar || null;

  /** @type {Map<string, {key:string, class:string, relPath:string, abs:string, op:string}>} */
  const pending = new Map();
  let timer = null;
  let watcher = null;
  let closed = false;
  const stats = { events: 0, accepted: 0, ignored: 0, batches: 0, errors: 0 };

  function flush() {
    timer = null;
    if (closed || pending.size === 0) return;
    const batch = [...pending.values()];
    pending.clear();
    stats.batches += 1;
    try { onChange(batch); } catch (err) { onError(err); }
  }

  function schedule() {
    if (timer) clearTimer(timer);
    timer = setTimer(flush, debounceMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  /**
   * Tek olayı sınıflandır ve kuyruğa koy.
   *
   * SINIF KAPISI BURADA DA VAR: izleyici yalnız sınıf köklerini izlese bile
   * `classify()` ikinci kez sorulur. Tek kapı, tek kural (§0.5.3) — izleyicinin
   * "izlediğim dizinde ne varsa sınıftandır" varsayımı, `.crewpane/memory/`
   * altına düşen bir `.DS_Store`da hemen yanlış olurdu.
   */
  function ingest(op, abs) {
    if (closed) return { ok: false, reason: 'closed' };
    stats.events += 1;
    const name = path.basename(String(abs || ''));
    if (ignoredName(name)) { stats.ignored += 1; return { ok: false, reason: 'ignored-name' }; }
    const hit = C.classify(abs, roots, { platform });
    if (!hit) { stats.ignored += 1; return { ok: false, reason: 'not-in-registry' }; }

    if (pending.size >= maxBatch) {
      // Tavan: yeni yol EKLENMEZ ama tur ZORLANIR — sonraki turda kalanı
      // tarayıcı zaten görür (karar hash'e bağlıdır, olaya değil).
      log(`[sync-watch] olay tavanı (${maxBatch}) — tur zorlandı`);
      flush();
    }
    const key = `${hit.class}|${hit.relPath}`;
    pending.set(key, { key, class: hit.class, relPath: hit.relPath, abs, op });
    stats.accepted += 1;
    schedule();
    return { ok: true, key, class: hit.class, relPath: hit.relPath };
  }

  /** İzlenecek kökler: yalnız DOSYA-DAYANAKLI sınıfların gerçek alt ağaçları. */
  function watchDirs() {
    const dirs = [];
    for (const classId of C.fileBackedClasses()) {
      for (const { dir } of C.classRoots(classId, roots, { platform })) {
        if (!dirs.includes(dir)) dirs.push(dir);
      }
    }
    return dirs;
  }

  function start() {
    if (watcher) return { ok: true, already: true, dirs: [] };
    const dirs = watchDirs();
    if (!dirs.length) {
      log('[sync-watch] izlenecek kök yok (workspaceRoot/accountRoot verilmedi)');
      return { ok: false, reason: 'no-roots', dirs: [] };
    }
    if (!chokidarMod || typeof chokidarMod.watch !== 'function') {
      return { ok: false, reason: 'no-chokidar', dirs };
    }
    try {
      watcher = chokidarMod.watch(dirs, {
        // Var olmayan kök HATA DEĞİLDİR: hiç skill yazılmamış bir workspace normaldir,
        // chokidar dizin yaratıldığında kendiliğinden yakalar.
        ignoreInitial: true,
        // İlk taramayı motor yapar (`scan()`); izleyicinin açılışta 1.500 olay
        // üretmesi aynı işi iki kez yapmak olurdu.
        ignored: (p) => ignoredName(path.basename(String(p || ''))),
        awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
      });
      watcher.on('add', (p) => ingest('add', p));
      watcher.on('change', (p) => ingest('change', p));
      watcher.on('unlink', (p) => ingest('unlink', p));
      watcher.on('error', (err) => {
        stats.errors += 1;
        log(`[sync-watch] izleyici hatası: ${err && err.message}`);
        onError(err);
      });
    } catch (err) {
      stats.errors += 1;
      onError(err);
      return { ok: false, reason: 'watch-failed', error: String(err && err.message), dirs };
    }
    return { ok: true, dirs };
  }

  async function close() {
    closed = true;
    if (timer) { clearTimer(timer); timer = null; }
    pending.clear();
    if (watcher && typeof watcher.close === 'function') {
      try { await watcher.close(); } catch { /* kapanışta hata sessiz — süreç zaten gidiyor */ }
    }
    watcher = null;
  }

  return {
    start,
    close,
    ingest,          // test + motor "elle tetikle" yolu
    flush,
    watchDirs,
    pendingSize: () => pending.size,
    stats: () => ({ ...stats }),
  };
}

module.exports = { createSyncWatcher, ignoredName, DEBOUNCE_MS, MAX_BATCH };
