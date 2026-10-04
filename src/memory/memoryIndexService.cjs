// CrewPane — ADP-870 (SPRINT-MEMORY-SEARCH · Faz 2) main-taraflı indeksleme yöneticisi.
//
// Tek görevi: indeksleme ÇOCUĞUNU (memoryIndexWorker.cjs) yönetmek ve ilerlemesini
// main'e/renderer'a taşımak. Ağır işin hiçbiri BURADA koşmaz — main'in olay döngüsü
// boş kalır, pencere boyanır (donma şartı). Tekil: aynı anda tek indeksleme.
//
// `spawnImpl` seam'i sayesinde tüm durum makinesi gerçek çocuk süreç açmadan test
// edilir (agentRunner/whisperLocal deseni).

'use strict';

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { fork } = require('node:child_process');
const instancePaths = require('../config/instancePaths.cjs');
const poisonLedger = require('./memoryIndexPoison.cjs'); // ONNX-CRASH-01 — çocuk ölünce çentik atan taraf

/**
 * Bu çalışma alanının indeks dosyası.
 * Çalışma alanı BAŞINA ayrı dosya: Eren birden çok workspace açıyor, hepsinin
 * hafızası ayrı. Yol uzunluğu/karakter sorunu olmasın diye kökün sha1'i kullanılıyor
 * (Windows MAX_PATH payı — SPRINT-WINDOWS-IMPL).
 */
// SMOKE-ISO-01 — ⚠️ VARSAYILAN `os.homedir()` OLAMAZ. `instanceHome()` kendi
// önceliğini uygular (`CREWPANE_HOME` → ev dizini); buraya dolu bir değer
// vermek o önceliği GÖLGELER ve yalıtılmış bir kopya (duman testi, e2e) kendi
// indeksi yerine KULLANICININ indeksine yazar. ÖLÇÜLDÜ (16.09): CREWPANE_HOME
// yalıtılmış koşum `~/.crewpane-dev/memory-index/*.db`ye yazdı — canlı app ile
// AYNI SQLite dosyası. CREWPANE_HOME yokken davranış birebir aynı.
function indexDbPath({ workspaceRoot, homedir = undefined } = {}) {
  const key = crypto.createHash('sha1').update(String(workspaceRoot || 'no-workspace')).digest('hex').slice(0, 12);
  return path.join(instancePaths.instanceHome(homedir), 'memory-index', `${key}.db`);
}

// ── ONNX-CRASH-02 · YENİDEN BAŞLATMA FRENİ ──────────────────────────────────
// Arama servisinin aksine burada OTOMATİK bir yeniden doğurma döngüsü YOK: `start`
// açılışta bir kez (auto) ve kullanıcı istediğinde çağrılır. Ama çocuk her koşuda
// hemen çöküyorsa (05.09'da ölçülen imza: model yüklenirken SIGABRT / arena OOM)
// kullanıcının "Yeniden indeksle" düğmesine üst üste basması ya da art arda açılan
// pencereler aynı çökme dizisini üretir. Fren aynı: üstel geri çekilme + N'inci
// çöküşte durma. Zehir defteri (ONNX-CRASH-01) BELGE bazlıdır; bu fren SÜREÇ bazlı —
// ikisi farklı kusuru tutar, biri diğerinin yerine geçmez.
const START_BACKOFF_BASE_MS = 2000;
const START_BACKOFF_MAX_MS = 60000;
const MAX_CONSECUTIVE_CRASHES = 5;

/** Ardışık `n`. çöküşten sonra beklenecek süre (üstel, tavanlı). */
function startBackoffMs(n, { base = START_BACKOFF_BASE_MS, max = START_BACKOFF_MAX_MS } = {}) {
  if (n <= 0) return 0;
  return Math.min(max, base * 2 ** (n - 1));
}

/**
 * İndeksleme yöneticisi. Döner: { start, stop, status, on }
 * `onEvent(payload)` her ilerleme mesajında çağrılır (main bunu renderer'a köprüler).
 */
function createIndexService({
  homedir = undefined, // SMOKE-ISO-01 — CREWPANE_HOME'u gölgeleme
  repoRoot = null,
  workerPath = path.join(__dirname, 'memoryIndexWorker.cjs'),
  execPath = process.execPath,
  spawnImpl = null,
  onEvent = () => {},
  logLine = () => {},
  // WIN-W6A — indeksleme çocuğuna sır köprüsü: kasadaki API anahtarı (yerel gömme
  // modeli yokken kullanılan barındırılan motor için) çocuğun ortamına konur.
  //
  // 🪤 VARSAYILAN BİLEREK BOŞ — bu modül `requireCredential.cjs`i REQUIRE ETMEZ.
  // Ölçüldü (mcpPackaging.test.cjs): bu dosya `crewpaneCli.cjs`in require
  // kapanışındadır ve kapıyı buradan çağırmak agentSettings/i18n/integrationCatalog
  // dahil **9 dosyayı** MCP'siz motorun unpack listesine sürüklüyordu — kelime
  // katmanıyla koşan CLI köprüsünün gömmeye HİÇ ihtiyacı yokken. Anahtarı çözmek
  // ana sürecin işidir; main.js bu seam'i doldurur (memorySearchService ile aynı).
  hostedKeyEnv = () => ({}),
  // ONNX-CRASH-01 — zehir defteri dikişi (testte taklit edilir; üretimde gerçek dosya).
  poison = poisonLedger,
  // ONNX-CRASH-02 — fren ayarları (testte küçültülür).
  maxCrashes = MAX_CONSECUTIVE_CRASHES,
  backoffBaseMs = START_BACKOFF_BASE_MS,
  backoffMaxMs = START_BACKOFF_MAX_MS,
  now = () => Date.now(),
} = {}) {
  let child = null;
  let inFlightDoc = null; // ONNX-CRASH-01 — çocuk ölürse çentik bu yola atılır
  // ONNX-CRASH-02 — fren durumu
  let crashes = 0; // ardışık, İŞ BİTMEDEN ölen çocuk sayısı
  let nextStartAt = 0;
  let lastCrash = null;
  let state = {
    running: false,
    phase: 'idle',
    startedAt: null,
    finishedAt: null,
    lastEvent: null,
    lastResult: null,
    reason: null,
    workspaceRoot: null,
    dbFile: null,
  };

  function status() {
    return {
      ...state,
      // ONNX-CRASH-02 — fren görünür: "neden başlamıyor" sessiz kalmaz.
      crashes,
      crashLoop: crashes >= maxCrashes,
      lastCrash,
      retryInMs: nextStartAt > now() ? nextStartAt - now() : 0,
    };
  }

  function publish(payload) {
    state.lastEvent = payload;
    state.phase = payload.phase || state.phase;
    // Nedeni YALNIZ taşıyan mesaj yazar. Aksi halde kapanış olayı ("phase:error,
    // code:1" — reason alanı yok) az önce saptanan gerçek nedeni null'a EZİYORDU.
    if (payload.reason) state.reason = payload.reason;
    if (payload.phase === 'exit') state.lastResult = payload;
    try {
      onEvent(payload);
    } catch (err) {
      logLine(`memoryIndex onEvent failed: ${err.message}`);
    }
  }

  /**
   * @param {object} o
   * @param {boolean} [o.auto] ADP-900 — bunu KULLANICI değil uygulama başlattı
   *   (ilk açılış indeksi). Durum yüzeyinde ayırt edilir ve düşük öncelikle koşar.
   * @param {boolean} [o.lowPriority] işletim sistemi önceliğini düşür (varsayılan: auto)
   */
  function start({ workspaceRoot, auto = false, lowPriority = auto } = {}) {
    if (state.running) return { ok: false, reason: 'already_running' };
    // ONNX-CRASH-02 — art arda çöken çocuğu yeniden başlatma; sebebi SÖYLE.
    if (crashes >= maxCrashes) {
      const how = lastCrash ? `${lastCrash.signal || `çıkış ${lastCrash.code}`}` : 'bilinmiyor';
      logLine(`memoryIndex: DEVRE KESİCİ — indeksleme çocuğu ${crashes} kez üst üste çöktü (${how}); yeniden başlatılmıyor`);
      return { ok: false, reason: 'index_crash_loop', crashes, lastCrash };
    }
    const waitMs = nextStartAt - now();
    if (waitMs > 0) return { ok: false, reason: 'crash_backoff', retryInMs: waitMs, crashes, lastCrash };
    const dbFile = indexDbPath({ workspaceRoot, homedir });
    const args = ['--workspace', String(workspaceRoot || ''), '--db', dbFile];
    if (repoRoot) args.push('--repo', repoRoot);

    const spawn = spawnImpl || ((mod, argv, opts) => fork(mod, argv, opts));
    try {
      child = spawn(workerPath, args, {
        execPath,
        // Paketli app'te process.execPath = Electron ikilisi → Node modu ŞART.
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...hostedKeyEnv() },
        // stdout/stderr ebeveyne bağlı kalsın (log), IPC kanalı ilerleme için.
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
    } catch (err) {
      state = { ...state, running: false, phase: 'error', reason: err.message };
      return { ok: false, reason: err.message };
    }

    // ADP-900 — ARKA PLAN İNDEKSİ KULLANICININ ÖNÜNE GEÇMEZ. İlk açılışta kendiliğinden
    // koşan indeksleme, kullanıcının o an yaptığı işten (pane açma, derleme) CPU
    // çalmamalı. `setPriority` desteklenmeyen platformda sessizce atlanır — indeksleme
    // yine koşar, yalnız normal öncelikle.
    if (lowPriority && child && child.pid) {
      try {
        os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
      } catch (err) {
        logLine(`memoryIndex: öncelik düşürülemedi (${err.message}) — normal öncelikle koşuyor`);
      }
    }

    state = {
      running: true,
      phase: 'starting',
      startedAt: Date.now(),
      finishedAt: null,
      lastEvent: null,
      lastResult: null,
      reason: null,
      auto: Boolean(auto),
      workspaceRoot: workspaceRoot || null,
      dbFile,
    };

    // 🔴 ONNX-CRASH-01 — UÇUŞTAKİ BELGEYİ TAKİP ET. Çocuk ONNX'in C++ tarafında
    // (SIGTRAP / OOM) ölürse JS'te yakalanacak hata yoktur: elimizde yalnız "en son
    // hangi belgeye başlamıştı" bilgisi kalır. Çentik ona atılır.
    child.on('message', (payload) => {
      if (payload && payload.phase === 'doc' && payload.path) inFlightDoc = payload.path;
      if (payload && (payload.phase === 'indexing' || payload.phase === 'docFailed')) inFlightDoc = null;
      publish(payload);
    });
    child.stderr?.on('data', (b) => logLine(`memoryIndex[stderr] ${String(b).trim()}`));
    child.on('exit', (code, signal) => {
      state.running = false;
      state.finishedAt = Date.now();
      const abnormal = code !== 0 || Boolean(signal);
      if (abnormal && inFlightDoc) {
        try {
          const r = poison.recordStrike({
            file: poison.poisonPath(state.dbFile),
            docPath: inFlightDoc,
            reason: `child_${signal || `exit_${code}`}`,
          });
          logLine(
            `memoryIndex: çocuk ${signal || `exit ${code}`} ile öldü — "${inFlightDoc}" çentik ${r.strikes}${r.poisoned ? ' (ZEHİRLİ: bir daha denenmeyecek)' : ''}`,
          );
        } catch (err) {
          logLine(`memoryIndex: zehir defteri yazılamadı (${err.message})`);
        }
      }
      inFlightDoc = null;
      // ONNX-CRASH-02 — "çöküş" = iş bitmeden (phase:exit gelmeden) ölüm.
      if (abnormal && state.phase !== 'exit') {
        crashes += 1;
        lastCrash = { code, signal: signal || null, at: now() };
        nextStartAt = now() + startBackoffMs(crashes, { base: backoffBaseMs, max: backoffMaxMs });
        logLine(`memoryIndex: çocuk anormal öldü (${signal || `çıkış ${code}`}) — ${crashes}/${maxCrashes}`);
      } else if (!abnormal) {
        crashes = 0;
        nextStartAt = 0;
        lastCrash = null;
      }
      if (state.phase !== 'exit' && state.phase !== 'unavailable') {
        state.phase = code === 0 ? 'exit' : 'error';
        if (code !== 0 && !state.reason) state.reason = `exit_${code}${signal ? `_${signal}` : ''}`;
      }
      child = null;
      publish({ phase: state.phase, code, signal, reason: state.reason || undefined, ...(state.lastResult || {}) });
    });

    return { ok: true, dbFile };
  }

  /** Nazik durdurma: çocuk DOSYA SINIRINDA durur (yarım doküman yazılmaz). */
  function stop() {
    if (!child) return { ok: false, reason: 'not_running' };
    try {
      child.send({ cmd: 'stop' });
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {
        /* zaten ölmüş */
      }
    }
    return { ok: true };
  }

  /**
   * MEMIDX-LEAK-01 — ÇIKIŞ TEARDOWN'U (ana süreç `before-quit`'te çağırır).
   *
   * `stop()` bir IPC MESAJIDIR: çocuk onu ancak bir sonraki turda okur ve ana süreç
   * çoğu zaman o ana kadar ölmüş olur — ölçüldü: `app.close()` sonrası 5/5 açılışta
   * worker ppid 1'e düşüp saatlerce koştu. Burada SİNYAL yollanır (SIGTERM), çünkü
   * sinyal ebeveynin ölümünü BEKLEMEZ. SIGKILL değil: çocuk SQLite'a yazıyor olabilir
   * ve dosya sınırında durması gerekiyor — sert kapanış çocuğun KENDİ güvenlik ağıdır
   * (childIpcSafe · installOrphanGuard), o ağ ebeveyn öldükten SONRA da ayaktadır.
   *
   * İki katman bilerek: bu katman uygulamanın DÜZGÜN kapandığı yolları kapatır,
   * çocuk tarafı nöbetçi ise SIGKILL/Force Quit/çökme yollarını (ADP-727 A/B deseni).
   */
  function shutdown() {
    if (!child) return { ok: false, reason: 'not_running' };
    try {
      child.kill('SIGTERM');
    } catch {
      /* zaten ölmüş */
    }
    return { ok: true, pid: child.pid };
  }

  /** ONNX-CRASH-02 — freni aç (model yeniden kuruldu / kullanıcı açıkça istedi). */
  function resetBrake() {
    crashes = 0;
    nextStartAt = 0;
    lastCrash = null;
  }

  return { start, stop, shutdown, status, resetBrake };
}

module.exports = {
  indexDbPath,
  createIndexService,
  MAX_CONSECUTIVE_CRASHES,
  START_BACKOFF_BASE_MS,
  START_BACKOFF_MAX_MS,
  startBackoffMs,
};
