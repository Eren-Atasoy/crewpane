// RPT-SYNC-LIVE-01 — SAYFA → RAPORLAR EŞİTLEYİCİSİ ÜRÜNÜN İÇİNDE (elle komut yok).
//
// Kök neden (PLAN0110-R14 §2): RPT-INBOX-01'in eşitleyicisi doğru çalışıyordu ama tek tetiği elle
// `npm run reports:sync-artifacts` idi; 28.09'dan sonra kimse çağırmadı ve Murat'ın tarayıcıda açıp
// kapattığı sayfalar Raporlar sekmesine hiç girmedi ("Mutlaka raporlar sekmesinde görüntülenmeli").
//
// Dört tetik:
//   1. açılış        — pencere açıldıktan 60 sn sonra bir kez (yalnız ana ağaçlar)
//   2. izleyici      — ana ağaçların `docs/artifacts`, `docs/design`, `docs/plan-*` klasörlerine
//                      fs.watch (mac/Windows recursive; Linux'ta recursive yok → yalnız klasörün
//                      kendi düzeyi, alt klasörü periyodik yakalar). Olay → 5 sn birleştir → eşitle
//   3. periyodik     — 30 dk'da bir; worktree taraması YALNIZ burada (142 worktree'de ~19 sn)
//   4. rapor_yaz     — HTML raporu kendisi yazar (eşitleme gerekmez); ajan sayfayı docs/artifacts'a
//                      yazıp rapor açmazsa 2. tetik yakalar
// + "Şimdi eşitle" (Ayarlar): worktree'ler dahil tam koşum.
//
// Ana süreçte senkron disk taraması YOK: eşitleme işçide koşar (reportsPageSyncWorker.cjs,
// memoryTaskBlockClient — tokenUsage işçisiyle aynı istemci). Burada yalnız zamanlayıcılar,
// izleyiciler (fs.watch = işletim sisteminin olay mekanizması, boşta ~0 CPU) ve ASENKRON klasör
// keşfi var. Aynı anda tek koşum: uçuştayken gelen tetik bir sonrakine birleşir (+ betiğin O_EXCL
// kilidi elle koşulan CLI'a karşı).
//
// Arıza sessiz değil: koşum düşerse (git yok, kilit, işçi zaman aşımı) durum satırı "eşitlenemedi"
// der ve `reports.page_sync_failed` olayı gider (neden kodu; yol/ad/kişisel veri YOK). Aynı neden
// art arda düşerse tek olay (durum değişiminde bildirilir).

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const memoryTaskBlockClient = require('./memoryTaskBlockClient.cjs');

const STARTUP_DELAY_MS = 60_000;
const DEBOUNCE_MS = 5_000;
const PERIOD_MS = 30 * 60_000;
/** 142 worktree'de kuru koşum 19 sn ölçüldü; Windows (Defender) birkaç kat yavaş olabilir. Yalnız TAKILAN işçiyi keser. */
const TIMEOUT_MS = 10 * 60_000;
/** İzlenecek kapsam klasörü (`docs/<ad>`). */
const SCOPE_DIR = /^(?:artifacts|design|plan-.+)$/;
/** Olay üreten dosya: yalnız HTML sayfa (ya da adsız olay / klasör). */
const isPageEvent = (name) => name == null || /\.html?$/i.test(String(name)) || !/\.[a-z0-9]{1,8}$/i.test(String(name));

/** Neden kodu → kapalı küme (Sentry etiketi ve ayar satırı bundan beslenir). */
function failureCode(raw) {
  const s = String(raw || '');
  if (s === 'git-yok') return 'git-yok';
  if (s === 'kilit') return 'kilit';
  if (s === 'modul-yok') return 'modul-yok';
  if (s === 'worker-timeout') return 'zaman-asimi';
  if (/^worker-(?:construct|error|exit|post)/.test(s) || s === 'disposed') return 'isci';
  return 'diger';
}

function createReportsPageSync({
  workspaceRoot,
  target = null, // raporların yazılacağı proje kökü (null → işçi seçer)
  agentshotRoot = null,
  getPanes = () => [], // [{cwd, ajan}] — yazan ajanı bulmak için (işçiye veri olarak gider)
  log = () => {},
  onFailure = () => {}, // ({ reason }) → Sentry
  onStatus = () => {}, // (status) → renderer
  platform = process.platform,
  fs: fsMod = fs,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  setEvery = setInterval,
  clearEvery = clearInterval,
  now = Date.now,
  startupDelayMs = STARTUP_DELAY_MS,
  debounceMs = DEBOUNCE_MS,
  periodMs = PERIOD_MS,
  timeoutMs = TIMEOUT_MS,
  runJob = null, // test dikişi: async (req) → { ok, result } | { ok:false, reason }
  // false → KONTROL KOLU: izleyici yok, yalnız açılış + periyodik. (İç ad `watchEnabled`: gövdedeki
  // `function watch` bildirimi aynı adlı parametreyi EZER — kol hiç kapanmıyordu, testte yakalandı.)
  watch: watchEnabled = true,
  // RPT-SCRATCH-RULE-01 — periyodik tetikte çağrılır (günlük geçici klasör nöbeti kendi 24 sa kapısını tutar).
  onPeriodic = null,
} = {}) {
  const ws = workspaceRoot ? path.resolve(workspaceRoot) : null;
  let client = null;
  const job = runJob || ((req) => {
    if (!client) {
      client = memoryTaskBlockClient.createTaskBlockClient({
        workerPath: path.join(__dirname, 'reportsPageSyncWorker.cjs'),
        timeoutMs,
        label: 'reports:pageSync',
        log,
      });
    }
    return client.run(() => req, null, 'pageSync');
  });

  const status = {
    durum: ws ? 'bekliyor' : 'kapali', // bekliyor | kosuyor | tamam | hata | kapali
    sonKosum: null, // ms
    tetik: null,
    yeni: 0, // son koşumda yeni + güncellenen rapor
    yerel: 0,
    hata: null, // neden kodu
    ms: null,
    izleme: !watchEnabled ? 'kapali' : platform === 'linux' ? 'klasor' : 'tam', // tam | klasor (Linux: alt klasörü periyodik) | kapali
    izlenen: 0,
  };
  const watchers = new Map(); // dir → fs.FSWatcher
  let closed = false;
  let running = null; // Promise (uçuştaki koşum)
  let queued = null; // { tetik, worktree } — uçuştayken gelen istek(ler)
  let queuedP = null;
  let debounce = null;
  let startupT = null;
  let periodT = null;
  let lastFailure = null;
  const stats = { kosum: 0, olay: 0, birlesen: 0 };

  const snapshot = () => ({ ...status });
  const emit = () => { try { onStatus(snapshot()); } catch { /* best-effort */ } };

  function panes() {
    try {
      return (getPanes() || []).filter((p) => p && typeof p.cwd === 'string' && typeof p.ajan === 'string').map((p) => ({ cwd: p.cwd, ajan: p.ajan, ...(Number.isFinite(p.baslangic) ? { baslangic: p.baslangic } : {}) }));
    } catch { return []; }
  }

  async function runOnce(tetik, worktree) {
    stats.kosum += 1;
    status.durum = 'kosuyor';
    status.tetik = tetik;
    emit();
    const t0 = now();
    let r;
    try {
      r = await job({ ws, hedef: target, defterKoku: ws, agentshotRoot, worktree, paneler: panes() });
    } catch (err) {
      r = { ok: false, reason: (err && err.message) || String(err) };
    }
    if (closed) return snapshot();
    status.sonKosum = now();
    status.ms = r && r.ms != null ? Math.round(r.ms) : status.sonKosum - t0;
    const res = r && r.ok ? r.result : null;
    if (res && res.ok) {
      status.durum = 'tamam';
      status.hata = null;
      status.yeni = (res.yeni || 0) + (res.guncel || 0);
      status.yerel = res.yerel || 0;
      lastFailure = null;
      const ret = (res.ret || []).length;
      log(`reports:pageSync ${tetik}${worktree ? ' (worktree dahil)' : ''}: ${JSON.stringify(res.say || {})} · yeni ${res.yeni || 0} · güncel ${res.guncel || 0}${res.yerel ? ` · yerel ${res.yerel}` : ''}${ret ? ` · ret ${ret}` : ''} · ${status.ms} ms`);
    } else {
      const code = failureCode(res ? res.hata : r && r.reason);
      status.durum = 'hata';
      status.hata = code;
      log(`reports:pageSync ${tetik}: EŞİTLENEMEDİ (${code})`);
      if (lastFailure !== code) {
        lastFailure = code;
        try { onFailure({ reason: code }); } catch { /* best-effort */ }
      }
    }
    emit();
    return snapshot();
  }

  /**
   * Tek koşum kuralı: uçuştayken gelen istekler TEK bir sonraki koşuma birleşir (worktree isteği
   * baskın); bekleyenlerin hepsi o koşumun sonucunu alır.
   */
  function run(tetik, { worktree = false } = {}) {
    if (closed || !ws) return Promise.resolve(snapshot());
    if (running) {
      stats.birlesen += 1;
      if (queued) { queued.worktree = queued.worktree || worktree; return queuedP; }
      queued = { tetik, worktree };
      queuedP = running.then(() => {
        const q = queued;
        queued = null;
        queuedP = null;
        return closed ? snapshot() : begin(q.tetik, q.worktree);
      });
      return queuedP;
    }
    return begin(tetik, worktree);
  }

  function begin(tetik, worktree) {
    running = runOnce(tetik, worktree).finally(() => { running = null; });
    return running;
  }

  function schedule() {
    stats.olay += 1;
    if (debounce) clearTimer(debounce);
    debounce = setTimer(() => { debounce = null; void run('izleyici'); }, debounceMs);
    if (debounce && typeof debounce.unref === 'function') debounce.unref();
  }

  function watch(dir, { recursive, onEvent }) {
    if (watchers.has(dir) || closed) return;
    let w;
    try {
      w = fsMod.watch(dir, { recursive, persistent: false }, (evt, name) => onEvent(evt, name));
    } catch (err) {
      log(`reports:pageSync izleyici kurulamadı (${(err && err.code) || 'hata'}) — periyodik koşum yakalar`);
      return;
    }
    w.on('error', () => { try { w.close(); } catch { /* kapalı */ } watchers.delete(dir); status.izlenen = watchers.size; });
    watchers.set(dir, w);
  }

  /** ASENKRON keşif: ana ağaçların kapsam klasörleri + `docs` (yeni `plan-*` doğarsa yeniden kurulur). */
  async function arm() {
    if (closed || !ws || !watchEnabled) return;
    const p = fsMod.promises;
    const recursive = platform !== 'linux';
    const want = new Set();
    let ents = [];
    try { ents = await p.readdir(ws, { withFileTypes: true }); } catch { ents = []; }
    for (const e of ents) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      const proj = path.join(ws, e.name);
      try { if (!(await p.stat(path.join(proj, '.git'))).isDirectory()) continue; } catch { continue; }
      const docs = path.join(proj, 'docs');
      let kids = [];
      try { kids = await p.readdir(docs, { withFileTypes: true }); } catch { continue; }
      want.add(docs);
      for (const k of kids) if (k.isDirectory() && SCOPE_DIR.test(k.name)) want.add(path.join(docs, k.name));
    }
    if (closed) return;
    for (const [dir, w] of watchers) if (!want.has(dir)) { try { w.close(); } catch { /* kapalı */ } watchers.delete(dir); }
    for (const dir of want) {
      if (path.basename(dir) === 'docs') {
        watch(dir, { recursive: false, onEvent: (_e, name) => { if (name && SCOPE_DIR.test(String(name))) { void arm(); schedule(); } } });
      } else {
        watch(dir, { recursive, onEvent: (_e, name) => { if (isPageEvent(name)) schedule(); } });
      }
    }
    status.izlenen = watchers.size;
  }

  function start() {
    if (!ws || closed) return api;
    void arm();
    startupT = setTimer(() => { startupT = null; void run('acilis'); }, startupDelayMs);
    if (startupT && typeof startupT.unref === 'function') startupT.unref();
    periodT = setEvery(() => {
      void arm();
      void run('periyodik', { worktree: true });
      if (typeof onPeriodic === 'function') { try { onPeriodic(); } catch { /* nöbet eşitlemeyi etkileyemez */ } }
    }, periodMs);
    if (periodT && typeof periodT.unref === 'function') periodT.unref();
    emit();
    return api;
  }

  function close() {
    closed = true;
    if (debounce) clearTimer(debounce);
    if (startupT) clearTimer(startupT);
    if (periodT) clearEvery(periodT);
    for (const w of watchers.values()) { try { w.close(); } catch { /* kapalı */ } }
    watchers.clear();
    if (client) client.dispose();
    client = null;
  }

  const api = {
    start,
    close,
    /** "Şimdi eşitle": worktree'ler dahil tam koşum; bittiğinde durumu döndürür. */
    runNow: () => run('elle', { worktree: true }),
    run,
    status: snapshot,
    stats: () => ({ ...stats, izleyici: watchers.size }),
    arm,
  };
  return api;
}

/**
 * Toplu eşitleme bildirim fırtınası üretmesin. Eşitleyicinin raporları `okur: kullanıcı` yazılır
 * (RPT-INBOX-01), yani her biri "sana ait" sayılıp sağ üstte kart açar. Murat'ın makinesinde ilk
 * koşum ~180 rapor yazıyor (ölçüldü): 180 kart. Kural: koşum SÜRERKEN (+ izleyicinin geç olayı için
 * kısa bir pay) gelen `SAYFA-*` olayları tutulur; koşum bitince en çok `limit` tanesi ise aynen
 * gider (tek sayfa = tek kart, bugünkü davranış), fazlaysa hepsi SESSİZ gider (`audience: 'ekip'`
 * → zilde tek "N yeni rapor" satırı, kart yok). Rapor dosyası ve listesi DEĞİŞMEZ; yalnız bildirim.
 */
function createNotifyGate({ send, limit = 3, graceMs = 2000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let busy = false;
  let graceT = null;
  let held = [];
  const isSync = (p) => p && typeof p.filename === 'string' && /^SAYFA-/i.test(p.filename);
  function flush() {
    graceT = null;
    const out = held;
    held = [];
    const quiet = out.length > limit;
    for (const p of out) send(quiet ? { ...p, audience: 'ekip', hasOpenDecision: false } : p);
  }
  return {
    offer(p) {
      if (isSync(p) && (busy || graceT)) held.push(p);
      else send(p);
    },
    status(st) {
      const nowBusy = Boolean(st && st.durum === 'kosuyor');
      if (nowBusy && !busy) { if (graceT) { clearTimer(graceT); graceT = null; } }
      if (!nowBusy && busy) {
        graceT = setTimer(flush, graceMs);
        if (graceT && typeof graceT.unref === 'function') graceT.unref();
      }
      busy = nowBusy;
    },
    held: () => held.length,
  };
}

module.exports = { createReportsPageSync, createNotifyGate, failureCode, isPageEvent, STARTUP_DELAY_MS, DEBOUNCE_MS, PERIOD_MS, SCOPE_DIR };
