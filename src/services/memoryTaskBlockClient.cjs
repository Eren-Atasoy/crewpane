// PERF-MAIN-01 — hafıza işçisinin ANA SÜREÇ tarafı.
//
// Sözleşme (main.js `memory:taskBlock` ve `pty:spawn` bunu çağırır):
//   run(build, after, kind) → Promise<{ ok:true, result, ms } | { ok:false, reason, unavailable? }>
//   kind: 'taskBlock' (dağıtım seçkisi) · 'spawnPrep' (spawn'ın hafıza hazırlığı)
//         · 'graph' (PERF-MEMGRAPH-01 — Hafıza haritası, `memory:graph`)
//   ASLA reddetmez (reject yok) — hafıza bir dağıtımı/spawn'ı düşüremez.
//
// Üç arıza sınıfı, üç ayrı davranış:
//   • İŞÇİ HİÇ AÇILAMADI (kurucu attı / ilk cevaptan önce öldü) → `unavailable:true`.
//     Çağıran SATIR İÇİ yola düşer: seçki yine üretilir (özellik kaybı yok), yalnız
//     eski donma geri gelir ve bu bir kez loglanır.
//   • ZAMAN AŞIMI → `reason:'worker-timeout'`; işçi sonlandırılır (takılı bir işçi sıradaki
//     her isteği bekletirdi) ve bir sonraki çağrıda yeniden doğar. Çağıran bugünkü
//     "boş seçki" yoluna düşer (memoryGate bunu `failed` sayar, iş metni aynen gider).
//   • ÇALIŞIRKEN ÖLDÜ → `reason:'worker-exit…'`; bir sonraki çağrı yeni işçi açar.
//
// İstekler SIRAYLA koşar (aynı anda tek istek). Gerekçe EŞDEĞERLİK: satır içi yolda
// ana süreç tek iş parçacığıdır, yani iki dağıtım sırayla seçilir ve ikincisi
// birincinin defter kaydını (enjeksiyon sayacı → seçki cezası) GÖRÜR. Kuyruk bu sırayı
// korur: bir sonraki isteğin defter anlık görüntüsü, öncekinin kaydı yazıldıktan SONRA
// alınır (bkz. main.js — `build` geri-çağrısı sırası gelince çağrılır).

'use strict';

const path = require('node:path');

/** Varsayılan zaman aşımı. Gerekçe: rapor PERF-MAIN-01 §Riskler (3 sn değil, 10 sn). */
const DEFAULT_TIMEOUT_MS = 10000;

function timeoutFromEnv(env = process.env) {
  const n = Number(env.AGENTSPACE_MEMORY_WORKER_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

/** Kontrol kolu: `AGENTSPACE_MEMORY_INLINE=1` → eski senkron yol (A/B ölçümü için). Her çağrıda okunur. */
function inlineRequested(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env.AGENTSPACE_MEMORY_INLINE || '').trim());
}

function createTaskBlockClient({
  workerPath = path.join(__dirname, 'memoryTaskBlockWorker.cjs'),
  timeoutMs = null,
  onWarm = null,
  log = () => {},
  WorkerImpl = null,
  // PERF-TOKEN-SCAN-01 — aynı istemci jeton ölçümü işçisini de taşır; log satırı hangisi olduğunu söylesin.
  label = 'memory:taskBlock',
} = {}) {
  let worker = null;
  let everAnswered = false; // bu işçi örneği en az bir cevap verdi mi (açılış arızası ayrımı)
  let unavailable = null; // işçi açılamadı → kalıcı satır içi yedek (sebep)
  let seq = 0;
  const pending = new Map(); // id -> { settle, timer }
  let chain = Promise.resolve();

  function failAll(reason) {
    for (const [id, p] of pending) {
      pending.delete(id);
      clearTimeout(p.timer);
      p.settle({ ok: false, reason });
    }
  }

  function onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'warm') {
      try {
        if (typeof onWarm === 'function') onWarm({ workspaceRoot: msg.workspaceRoot, query: msg.query });
      } catch {
        /* ısıtma en iyi çabadır */
      }
      return;
    }
    if (msg.type !== 'result') return;
    const p = pending.get(msg.id);
    if (!p) return; // zaman aşımına uğramış isteğin geç cevabı — atılır
    pending.delete(msg.id);
    clearTimeout(p.timer);
    everAnswered = true;
    p.settle(msg.ok ? { ok: true, result: msg.result, ms: msg.ms } : { ok: false, reason: `worker-failed: ${msg.error}`, ms: msg.ms });
  }

  function retire(w, reason) {
    if (worker !== w) return;
    worker = null;
    // İlk cevaptan ÖNCE ölen işçi = açılış arızası (modül yüklenemedi, asar okunamadı…).
    // Her dağıtımda yeniden denemek her seferinde aynı arızayı üretir → kalıcı yedek.
    if (!everAnswered && !unavailable) {
      unavailable = reason;
      log(`${label} işçisi AÇILAMADI (${reason}) → satır içi yola düşüldü (sonuç aynen üretilir)`);
    }
    failAll(reason);
  }

  function ensureWorker() {
    if (worker) return worker;
    const { Worker, SHARE_ENV } = require('node:worker_threads');
    const W = WorkerImpl || Worker;
    everAnswered = false;
    // SHARE_ENV: hesap değişimi (AGENTDESK_ACCOUNT) ve izole kök (AGENTDESK_HOME) gibi
    // main'in çalışma anında değiştirdiği env, işçinin yol çözümünde de AYNI görünür.
    const w = new W(workerPath, { env: SHARE_ENV });
    if (typeof w.unref === 'function') w.unref(); // uygulamanın kapanmasını bekletmez
    w.on('message', onMessage);
    w.on('error', (err) => retire(w, `worker-error: ${(err && err.message) || err}`));
    w.on('exit', (code) => retire(w, `worker-exit: ${code}`));
    worker = w;
    return w;
  }

  function send(req, kind) {
    return new Promise((settle) => {
      let w;
      try {
        w = ensureWorker();
      } catch (err) {
        unavailable = unavailable || `worker-construct: ${(err && err.message) || err}`;
        log(`${label} işçisi AÇILAMADI (${unavailable}) → satır içi yola düşüldü (sonuç aynen üretilir)`);
        settle({ ok: false, reason: unavailable, unavailable: true });
        return;
      }
      const id = ++seq;
      const limit = timeoutMs || timeoutFromEnv();
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        settle({ ok: false, reason: 'worker-timeout' });
        // Takılı işçi sıradaki istekleri de bekletirdi: sonlandır, bir sonraki çağrı yenisini açar.
        if (worker === w) {
          worker = null;
          everAnswered = true; // zaman aşımı açılış arızası değildir — yedek yola KİLİTLEME
          try {
            w.terminate();
          } catch {
            /* zaten kapanıyor */
          }
        }
      }, limit);
      if (typeof timer.unref === 'function') timer.unref();
      pending.set(id, { settle, timer });
      try {
        w.postMessage({ type: 'job', kind, id, req });
      } catch (err) {
        pending.delete(id);
        clearTimeout(timer);
        settle({ ok: false, reason: `worker-post: ${(err && err.message) || err}` });
      }
    }).then((r) => (r.ok || !unavailable || r.unavailable ? r : { ...r, unavailable: true }));
  }

  /**
   * Sıraya gir. `build()` SIRA GELİNCE çağrılır ve isteği döndürür (defter anlık görüntüsü
   * o an alınır); `after(r)` cevapla birlikte, bir SONRAKİ istek başlamadan çağrılır
   * (defter kaydı burada yazılır). İkisi de main'de koşar.
   */
  function run(build, after = null, kind = 'taskBlock') {
    const job = chain.then(async () => {
      const req = build();
      const r = unavailable ? { ok: false, reason: unavailable, unavailable: true } : await send(req, kind);
      return typeof after === 'function' ? after(r, req) : r;
    });
    chain = job.catch(() => {});
    return job;
  }

  function dispose() {
    const w = worker;
    worker = null;
    failAll('disposed');
    if (w) {
      try {
        w.terminate();
      } catch {
        /* zaten kapalı */
      }
    }
  }

  return {
    run,
    dispose,
    /** Ölçüm/test: işçinin durumu. */
    status: () => ({ alive: Boolean(worker), unavailable, pending: pending.size }),
  };
}

/**
 * PERF-GATE-MAIN-01 — main.js'in YOL KARARI tek yerde. Performans kapısı
 * (perfGateMain.test.cjs) da bunu koşar: kontrol kolu AGENTSPACE_MEMORY_INLINE=1 kapıda
 * da ürünle AYNI yolu seçer, yani kapı kararı değil ürünün gerçek kararını ölçer.
 *   kontrol kolu            → { via:'satır-içi', result?, ms? }  (inline yoksa yalnız via)
 *   işçi cevap verdi        → { via:'işçi', result, ms }
 *   işçi açılamadı + inline → { via:'satır-içi-yedek', result, ms }
 *   aksi (zaman aşımı, ölüm, işçide hata) → { via:null, reason, unavailable }
 * `settle(outcome)` main'de ve işçi yolunda SIRA İÇİNDE çağrılır (defter kaydı oraya).
 */
function routeMemoryJob(getClient, { build, kind = 'taskBlock', inline = null, settle, env = process.env }) {
  const timed = (req) => {
    const t0 = process.hrtime.bigint();
    const result = inline(req);
    return { result, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
  };
  if (inlineRequested(env)) {
    return Promise.resolve().then(() => settle(inline ? { via: 'satır-içi', ...timed(build()) } : { via: 'satır-içi' }));
  }
  return getClient().run(
    build,
    (w, req) => {
      if (w.ok) return settle({ via: 'işçi', result: w.result, ms: w.ms });
      if (w.unavailable && inline) return settle({ via: 'satır-içi-yedek', ...timed(req) });
      return settle({ via: null, reason: w.reason, unavailable: Boolean(w.unavailable) });
    },
    kind,
  );
}

module.exports = { DEFAULT_TIMEOUT_MS, timeoutFromEnv, inlineRequested, createTaskBlockClient, routeMemoryJob };
