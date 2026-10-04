'use strict';

// ADP-813 (SPRINT-AGENTX-VOICE · Faz 1) — YEREL STT: whisper.cpp kalıcı sunucusu.
//
// NEDEN: ADP-804 ölçtü — bulut `whisper-1` 944–1472 ms, aynı klip yerel kalıcı
// `whisper-server` (large-v3-turbo) 446–592 ms (RTF ≈ 0.09) ve $0. Sunucu KALICI
// olmak zorunda: model yükleme (~1–2 s) her turda ödenirse yerel yol buluttan
// yavaş olur.
//
// SÖZLEŞME: `jarvis:transcribe` IPC'sinin imzası DEĞİŞMEZ. Bu modül yalnız
// `transcribeWhisper` ile AYNI şekilli bir sonuç döndürür ({ok,text} / {ok:false,reason})
// — bulut fallback'i jarvisVoice.transcribeSpeech kurar.
//
// ÇÖKME KISITI (Eren, bu makine): ağır iş yasağı →
//   • TEK süreç (singleton), aynı anda TEK istek (kuyruk yok, ikinci istek reddedilir)
//   • `nice -n 19` (en düşük öncelik) — arka planda kalır, UI'yı aç bırakır
//   • bellek tavanı: her turdan sonra RSS ölçülür, tavanı aşarsa süreç kapatılır
//   • boşta kapanma: 10 dk transkripsiyon yoksa sunucu kapanır (RAM geri verilir)
//   • model diskte VARSA asla yeniden indirilmez (bu modül hiç indirmez —
//     `scripts/fetch-whisper-model.sh` tek indirme yolu)
//
// SAF yardımcılar (resolve*/build*/normalize*) dışa açıktır ve `node --test` ile
// Electron'suz test edilir; durum tutan kısım enjekte edilebilir bağımlılıklarla
// (spawnImpl/fetchImpl/execFileImpl) test edilir.

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { augmentedPath } = require('../agents/agentRunner.js');
const instancePaths = require('../config/instancePaths.cjs');
// ADP-874 (ADR-W7 · ADR-W10 Kural 2) — İKİLİ ÇÖZÜMÜ TEK BOĞAZDAN. Bu dosyanın
// kendi `resolveBinary`'si ADP-833'ten ÖNCE yazıldı ve iki POSIX varsayımı
// taşıyordu: (1) uzantısız ad (`whisper-server`) — Windows'ta çalıştırılabilir
// dosya `whisper-server.exe`'dir, (2) `X_OK` — Windows'ta anlamsız. Yani ikili
// KURULU olsa bile "yok" denirdi. Çözüm yeniden yazmak değil, ADP-833'ün
// ölçülmüş/testli boğazını ÇAĞIRMAK.
const binResolve = require('../../platform/binResolve.cjs');
// ADP-909 — sessizlik/gürültü kapısı ve halüsinasyon süzgeci AYRI modüllerde:
// ikisi de bulut yolundan (jarvisVoice.transcribeWhisper) da çağrılıyor, ve
// eşikleri kullanıcı ayarından geliyor. Bu dosyadaki eski `pcmSpeechStats`/
// `hasSpeech` KORUNUYOR (dışa açık sözleşme + eski testler) ama artık tek
// gerçeğin — sttSilenceGate — üstüne oturuyor; ikinci bir kopya YOK.
const silenceGate = require('./sttSilenceGate.cjs');
const hallucinationGuard = require('./sttHallucinationGuard.cjs');

// ADP-814 (Faz 2) — AKIŞ STT: aynı ikili, İKİNCİ bir kalıcı sunucu `base` modeliyle
// ("taslak" katmanı). Kayıt SÜRERKEN kümülatif ses parçaları buraya gider ve kısmi
// hipotez döner; kayıt bitince FİNAL metni yine large-v3-turbo verir. Neden ayrı
// süreç: whisper-server süreç başına TEK model tutar ve `state.busy` kuralı gereği
// tek istek koşar — taslak turları finali BEKLETMEMELİ.
//
// ── sabitler ───────────────────────────────────────────────────────────────
const MODEL_FILE = 'ggml-large-v3-turbo-q5_0.bin'; // ADP-804 ölçümü: 446–592 ms sunucu
// ADP-814: taslak modeli. 60 MB / ~200 MB RSS — final modelin yanında ucuz.
// Doğruluğu final kadar değil; ZATEN öyle olması gerekiyor: ekranda "şimdilik böyle
// duydum" gösterir, cümle bitince final onun üstüne yazar.
const DRAFT_MODEL_FILE = 'ggml-base-q5_1.bin';
const SERVER_BIN = 'whisper-server';
const FFMPEG_BIN = 'ffmpeg';
const SERVER_READY_TIMEOUT_MS = 60000; // model yükleme (soğuk disk) + Metal init
const REQUEST_TIMEOUT_MS = 15000;
const IDLE_STOP_MS = 10 * 60 * 1000; // boşta sunucuyu kapat (RAM geri ver)
const MAX_RSS_MB = 3000; // bellek tavanı — aşılırsa süreç kapatılır
const RESTART_WINDOW_MS = 60000;
const MAX_RESTARTS_IN_WINDOW = 3; // bundan sonrası: soğuma (aşağıda)
const COOLDOWN_MS = 5 * 60 * 1000;
const THREADS = 4; // M-serisi performans çekirdeği payı; nice ile zaten geri planda
// ADP-814 — taslak katmanı: daha az çekirdek (final turunun önünü kesmesin), daha
// düşük RAM tavanı, daha kısa boşta-kapanma (kimse konuşmuyorsa RAM'i hemen geri ver).
const DRAFT_THREADS = 2;
const DRAFT_MAX_RSS_MB = 1200;
const DRAFT_IDLE_STOP_MS = 5 * 60 * 1000;
const DRAFT_REQUEST_TIMEOUT_MS = 6000; // kısmi hipotez GEÇ gelirse zaten değersiz

// ── SAF: ikili/model çözümleme ─────────────────────────────────────────────

/**
 * PATH içinde bir ikiliyi ara. GUI'den açılan Electron'da launchd PATH'i kırpılmış
 * gelir → agentRunner'ın augmentedPath'i (Homebrew/npm dizinleri) kullanılır.
 * Bulunamazsa '' döner (çağıran yerel yolu kapatır, bulut fallback'e düşer).
 *
 * ADP-874 — WINDOWS DALI. Üç POSIX varsayımı vardı ve üçü de Windows'ta yanlış:
 *   1. ayırıcı `:` (win32 `;`) → PATH tek parça sayılırdı, hiçbir dizin taranmazdı
 *   2. uzantısız ad (`whisper-server`) → Windows'ta çalıştırılabilir dosya
 *      `whisper-server.exe`; uzantısız dosya CreateProcess ile ÇALIŞTIRILAMAZ
 *   3. yol birleştirme `path.join` koşan makinenin ayırıcısını kullanırdı
 * Sonuç: ikili KURULU olsa bile `local-no-binary` denirdi. Uzantı listesi
 * ADP-833'ün ölçülmüş/testli `binResolve.candidatesFor`ından gelir (ikinci kopya
 * YOK); darwin dalı bugünkü satırların TA KENDİSİ (tek fark: platform seam'i).
 */
function resolveBinary(name, { pathValue, exists = fs.existsSync, platform, env } = {}) {
  const plat = platform || process.platform;
  const environ = env || process.env;
  const raw = typeof pathValue === 'string' ? pathValue : environ.PATH;
  const P = plat === 'win32' ? path.win32 : path.posix;
  const dirs = augmentedPath(raw || '', { platform: plat, env: environ })
    .split(P.delimiter)
    .filter(Boolean);
  const exts = plat === 'win32' ? binResolve.pathExtList(environ) : [];
  for (const dir of dirs) {
    for (const cand of binResolve.candidatesFor(name, exts, plat)) {
      const full = P.join(plat === 'win32' ? binResolve.stripQuotes(dir) : dir, cand);
      try {
        if (exists(full)) return full;
      } catch {
        /* erişilemeyen dizin → sıradaki */
      }
    }
  }
  return '';
}

/**
 * Model dosyasının yolu. Sıra:
 *   1. `CREWPANE_WHISPER_MODEL` (mutlak yol — ölçüm/test kaçış kapısı)
 *   2. Ayarlar `jarvis.whisperModelPath`
 *   3. `<instanceHome>/models/<MODEL_FILE>`  (bu kurulumun kendi kopyası)
 *   4. `~/.crewpane/models/<MODEL_FILE>`    (CİHAZ paylaşımlı kopya: dev/test
 *      instance'ı prod'un 574 MB'ını YENİDEN İNDİRMESİN — ADP-813 kısıtı)
 *   5. Homebrew paylaşım dizini (whisper-cpp formülü oraya koyarsa)
 * Hiçbiri yoksa '' → yerel yol kapalı.
 */
function resolveModelPath({
  env = process.env,
  settings = null,
  homedir = os.homedir(),
  exists = fs.existsSync,
  // ADP-814 — taslak katmanı AYNI arama sırasını kullanır, yalnız dosya adı ve
  // kaçış kapıları farklıdır (tek bir çözümleyici = tek bir davranış).
  modelFile = MODEL_FILE,
  envKey = 'CREWPANE_WHISPER_MODEL',
  settingsKey = 'whisperModelPath',
  platform = process.platform,
} = {}) {
  // AÇIKÇA verilen yol SESSİZCE BAŞKA BİR MODELE düşmez: "oraya koydum" diyen
  // kullanıcı/ölçüm, dosya yoksa yerel yolun KAPANDIĞINI görmeli (yoksa yanlış
  // modelle ölçer ve nedenini bulamaz). Otomatik adaylar aşağıda sırayla denenir.
  const explicit = (env && env[envKey])
    || (settings && settings.jarvis && settings.jarvis[settingsKey])
    || '';
  if (explicit) {
    try { return exists(String(explicit)) ? String(explicit) : ''; } catch { return ''; }
  }
  const cands = [];
  try {
    cands.push(path.join(instancePaths.instanceHome(homedir), 'models', modelFile));
  } catch {
    /* instancePaths env'e bakar; patlarsa sıradaki adaya geç */
  }
  cands.push(path.join(homedir, '.crewpane', 'models', modelFile));
  // ADP-874 — Homebrew paylaşım dizini POSIX'e özgü; win32'de böyle bir yol yok
  // (aday listesine koymak zararsız ama YANILTICI: teşhis çıktısında "aradım"
  // demiş oluruz). Aday üretimi platformdan türesin.
  if (platform !== 'win32') {
    cands.push(path.join('/opt/homebrew/share/whisper.cpp', modelFile));
  }
  for (const c of cands) {
    try {
      if (c && exists(c)) return c;
    } catch {
      /* yok say */
    }
  }
  return '';
}

/** ADP-814 — taslak (`base`) modelin yolu; final modelle AYNI arama sırası. */
function resolveDraftModelPath(opts = {}) {
  return resolveModelPath({
    ...opts,
    modelFile: DRAFT_MODEL_FILE,
    envKey: 'CREWPANE_WHISPER_DRAFT_MODEL',
    settingsKey: 'whisperDraftModelPath',
  });
}

/**
 * `nice -n 19 whisper-server …` argümanları. Dil BURADA sabitlenmez: istek başına
 * gönderilir (aynı sunucu ileride başka dille de kullanılabilsin).
 *
 * ADP-874 — WINDOWS'TA `nice` YOKTUR (`/usr/bin/nice` mutlak bir POSIX yolu):
 * `spawn` ENOENT verir → `local-spawn-failed`, yani model+ikili KURULU olsa bile
 * yerel yol hiç açılmaz. Windows'ta ikili DOĞRUDAN çalıştırılır; öncelik düşürme
 * `nice`in Windows karşılığı olmadığı için ATLANIR ve bu bir DAVRANIŞ FARKIDIR:
 * "ağır iş yasağı"nın öncelik ayağı orada YOK, kalan üç ayak (tek süreç/tek istek,
 * RSS tavanı, boşta kapanma) yerinde. Bunu sessizce yapmıyoruz — dönen kayıt
 * `niced` alanıyla söylüyor ve `status()` raporluyor.
 * darwin/linux BİT-BİT AYNI (varsayılan `nicePath` değişmedi).
 */
function buildServerArgs({ nicePath = '/usr/bin/nice', binary, modelPath, port, threads = THREADS, platform } = {}) {
  const plat = platform || process.platform;
  if (plat === 'win32') {
    return {
      cmd: binary,
      niced: false,
      args: [
        '-m', modelPath,
        '--host', '127.0.0.1',
        '--port', String(port),
        '-t', String(threads),
        '--convert',
        '--suppress-nst',
        '--no-timestamps',
        '-bo', '1',
        '-nf',
      ],
    };
  }
  return {
    cmd: nicePath,
    niced: true,
    args: [
      '-n', '19',
      binary,
      '-m', modelPath,
      '--host', '127.0.0.1',
      '--port', String(port),
      '-t', String(threads),
      '--convert',           // ffmpeg ile WAV'a çevirme (biz kendimiz çeviriyoruz; emniyet)
      '--suppress-nst',      // konuşma-dışı token'ları bastır ("[müzik]" gibi hayaletler)
      '--no-timestamps',
      // ÖLÇÜLDÜ (ADP-813, 20 gerçek Türkçe cümle): `-bo 1 -nf` p50 639 → 566 ms
      // (%11) ve 20 cümlenin 20'sinde METİN BİREBİR AYNI (WER/terim skoru değişmedi).
      // Yani bu iki bayrak burada bedava hız — ve daha az CPU (ağır iş yasağı).
      '-bo', '1',            // best-of 1 (varsayılan 2 = iki aday çözme)
      '-nf',                 // sıcaklık geri-düşüşü yok (düşük güvende yeniden çözmez)
    ],
  };
}

/** ffmpeg: her ne geldiyse → 16 kHz mono 16-bit WAV (whisper.cpp'nin istediği format). */
function ffmpegArgs(inPath, outPath) {
  return ['-nostdin', '-loglevel', 'error', '-y', '-i', inPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 'wav', outPath];
}

/**
 * whisper-server cevabı → {ok,text} | {ok:false,reason}.
 *
 * 🔴 ÖLÇÜLDÜ (ADP-813): buluttaki sessizlik nöbeti BURADA ÇALIŞMAZ. `whisper-1`
 * 2 sn sessizliğe `no_speech_prob ≈ 0.94` verir (ADP-312 kapısı buna dayanır);
 * whisper.cpp 1.9.1 AYNI sesli dosyada `1.9e-05`, pembe gürültüde `1.7e-10`
 * döndürüyor — yani yerel metrik ayırt EDİCİ DEĞİL (uydurma metnin `avg_logprob`'u
 * gerçek konuşmanınkiyle aynı: -0.04 / -0.01). Sessizlik nöbeti bu yüzden MODELDEN
 * değil SESTEN alınır: `pcmSpeechStats` (aşağıda). Segment kontrolü yine de duruyor
 * — zararsız ve whisper.cpp bir gün düzeltirse bedava çalışır.
 */
function normalizeLocalResult(json) {
  if (!json || typeof json !== 'object') return { ok: false, reason: 'bad-json' };
  const raw = typeof json.text === 'string' ? json.text : '';
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return { ok: false, reason: 'no-speech' };
  if (isBracketOnly(text)) return { ok: false, reason: 'no-speech', detail: text.slice(0, 80) };
  const segs = Array.isArray(json.segments) ? json.segments : [];
  if (segs.length && segs.every((s) => Number(s && s.no_speech_prob) >= 0.6)) {
    return { ok: false, reason: 'no-speech', detail: text.slice(0, 80) };
  }
  return { ok: true, text };
}

// ── SESSİZLİK NÖBETİ (ses tarafı) ──────────────────────────────────────────
// Eşik `src/app/lib/jarvisVoice.ts` içindeki tarayıcı VAD'ıyla AYNI (0.009 RMS):
// kaydı bitiren mantıkla transkripti reddeden mantık aynı fikirde olsun.
//
// ADP-909 — KARAR ARTIK BU DOSYADA DEĞİL: `sttSilenceGate.cjs`. Sebep ölçüm:
// tek başına RMS eşiği, Eren'in gerçek oda tonu bir miktar yükseldiğinde
// (fan/uğultu) konuşma-dışı sesi GEÇİRİYOR ve model YouTube outro cümleleri
// üretiyor. Aşağıdaki üç dışa-açık isim (FRAME_RMS_THRESHOLD / MIN_SPEECH_MS /
// pcmSpeechStats / hasSpeech) SÖZLEŞME olarak korunuyor — mevcut testler ve
// çağıranlar bozulmasın diye — ama hepsi tek gerçeğe delege ediyor.
const FRAME_MS = silenceGate.FRAME_MS;
const FRAME_RMS_THRESHOLD = silenceGate.DEFAULTS.rmsThreshold;
const MIN_SPEECH_MS = silenceGate.DEFAULTS.minSpeechMs; // 5 kare — bundan azı "kimse konuşmadı"

/**
 * 16-bit PCM WAV → { rms, peak, speechMs, frames, p10, p50, p90, dynamicDb }. SAF.
 * ÖLÇÜM (ADP-813, 16 kHz mono): dijital sessizlik speechMs=0 · pembe gürültü
 * (a=0.02, tepe 0.016) speechMs=0 · gerçek cümle speechMs≈1900 (kare oranı 0.84).
 * ADP-909: dört alan EKLENDİ (yüzdelikler + dinamik); eskiler birebir aynı.
 */
function pcmSpeechStats(wav) {
  return silenceGate.frameStats(wav);
}

/** WAV `data` chunk'ının başlangıcı (44 bayt SABİT DEĞİL — ffmpeg LIST chunk'ı ekler). */
function findWavDataOffset(buf) {
  return silenceGate.findWavDataOffset(buf);
}

/** Ses gerçekten konuşma içeriyor mu? (STT'ye GİTMEDEN önce sorulur — para+gecikme yok) */
function hasSpeech(stats, minSpeechMs = MIN_SPEECH_MS) {
  return !!stats && stats.speechMs >= minSpeechMs;
}

/** "[BLANK_AUDIO]" / "(müzik)" gibi TAMAMEN etiketten ibaret çıktı = konuşma yok. */
function isBracketOnly(text) {
  const stripped = text.replace(/[[(][^\])]*[\])]/g, '').replace(/[\s.…,-]+/g, '');
  return stripped.length === 0;
}

/**
 * Bu sebeple buluta düşmeli miyiz? `no-speech` DÜŞMEZ: kullanıcı hiç konuşmadıysa
 * bulut da konuşma bulamaz — para harcamanın anlamı yok (ve eski davranış da
 * kullanıcıya "duyamadım" diyordu). Diğer her şey (ikili yok, çökme, timeout,
 * http hatası) buluta düşer.
 */
function shouldFallbackToCloud(reason) {
  return reason !== 'no-speech';
}

// ── DURUM: katman başına tek sunucu, tek istek ─────────────────────────────
// ADP-814: iki KATMAN (slot) var — 'final' (large-v3-turbo, kayıt bitince) ve
// 'draft' (base, kayıt sürerken). Aynı yaşam-döngüsü kodu ikisini de yönetir;
// tek fark model dosyası, iş parçacığı sayısı ve tavanlar. Katman başına hâlâ
// TEK süreç + TEK eşzamanlı istek kuralı geçerli (bu makinede ağır iş yasağı).

function makeSlot(tier, opts = {}) {
  return {
    tier,
    modelFile: opts.modelFile || MODEL_FILE,
    threads: opts.threads || THREADS,
    maxRssMb: opts.maxRssMb || MAX_RSS_MB,
    idleStopMs: opts.idleStopMs || IDLE_STOP_MS,
    resolveModel: opts.resolveModel || resolveModelPath,
    proc: null,
    pid: null,
    port: 0,
    ready: false,
    starting: null, // Promise
    busy: false,
    restarts: [], // zaman damgaları
    cooldownUntil: 0,
    lastError: '',
    idleTimer: null,
    stderrTail: [],
  };
}

const state = makeSlot('final');
const draftSlot = makeSlot('draft', {
  modelFile: DRAFT_MODEL_FILE,
  threads: DRAFT_THREADS,
  maxRssMb: DRAFT_MAX_RSS_MB,
  idleStopMs: DRAFT_IDLE_STOP_MS,
  resolveModel: resolveDraftModelPath,
});
const slots = [state, draftSlot];

function now() {
  return Date.now();
}

function log(deps, msg, slot = state) {
  try {
    if (deps && typeof deps.log === 'function') deps.log(`[whisper:${slot.tier}] ${msg}`);
  } catch {
    /* log asla akışı bozmasın */
  }
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const sock = net.createServer();
    sock.listen(0, '127.0.0.1', () => {
      const port = sock.address().port;
      sock.close(() => resolve(port));
    });
    sock.on('error', reject);
  });
}

/** TCP bağlanabiliyor muyuz? whisper-server modeli YÜKLEDİKTEN SONRA dinlemeye başlar. */
function probePort(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* yok say */ }
      resolve(v);
    };
    sock.setTimeout(timeoutMs, () => finish(false));
    sock.on('connect', () => finish(true));
    sock.on('error', () => finish(false));
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Boşta kapanma zamanlayıcısını tazele (her transkripsiyon sonrası çağrılır). */
function touchIdle(deps, slot = state) {
  if (slot.idleTimer) clearTimeout(slot.idleTimer);
  slot.idleTimer = setTimeout(() => {
    log(deps, `boşta ${Math.round(slot.idleStopMs / 60000)} dk → sunucu kapatılıyor (RAM geri veriliyor)`, slot);
    stopServer(slot);
  }, slot.idleStopMs);
  if (slot.idleTimer.unref) slot.idleTimer.unref();
}

/** Yeniden başlatma fırtınası koruması: pencerede N'den fazla ölüm → soğuma. */
function noteRestart(deps, slot = state) {
  const t = now();
  slot.restarts = slot.restarts.filter((x) => t - x < RESTART_WINDOW_MS);
  slot.restarts.push(t);
  if (slot.restarts.length > MAX_RESTARTS_IN_WINDOW) {
    slot.cooldownUntil = t + COOLDOWN_MS;
    log(deps, `${slot.restarts.length} yeniden başlatma / ${RESTART_WINDOW_MS / 1000}s → ${COOLDOWN_MS / 60000} dk soğuma, bulut kullanılacak`, slot);
  }
}

/**
 * Sunucuyu kapat (uygulama çıkışı, bellek tavanı, boşta kalma).
 * ADP-814: argümansız çağrı HER KATMANI kapatır — `before-quit`'teki tek çağrı
 * (main.js) taslak sunucuyu da öldürsün, yetim RAM kalmasın.
 */
function stopServer(slot) {
  if (!slot) {
    for (const s of slots) stopServer(s);
    return;
  }
  const p = slot.proc;
  slot.proc = null;
  slot.pid = null;
  slot.ready = false;
  slot.port = 0;
  slot.starting = null;
  if (slot.idleTimer) {
    clearTimeout(slot.idleTimer);
    slot.idleTimer = null;
  }
  if (p && !p.killed) {
    try { p.kill('SIGTERM'); } catch { /* zaten ölmüş */ }
  }
}

/**
 * Kalıcı sunucunun ayakta olduğundan emin ol.
 * → { ok:true, port } | { ok:false, reason }
 */
async function ensureServer(deps = {}, slot = state) {
  const spawnImpl = deps.spawnImpl || spawn;
  const existsSync = deps.existsSync || fs.existsSync;
  if (slot.ready && slot.proc) return { ok: true, port: slot.port };
  if (slot.starting) return slot.starting;
  if (now() < slot.cooldownUntil) return { ok: false, reason: 'local-cooldown', detail: slot.lastError };

  const binary = deps.binaryPath !== undefined ? deps.binaryPath : resolveBinary(SERVER_BIN, { exists: existsSync });
  if (!binary) return { ok: false, reason: 'local-no-binary' };
  const modelPath = deps.modelPath !== undefined ? deps.modelPath : slot.resolveModel({ settings: deps.settings, exists: existsSync });
  if (!modelPath) return { ok: false, reason: 'local-no-model' };

  const startPromise = (async () => {
    const port = deps.port || (await pickFreePort());
    const { cmd, args, niced } = buildServerArgs({ binary, modelPath, port, threads: deps.threads || slot.threads, platform: deps.platform });
    log(deps, `sunucu başlatılıyor: ${path.basename(binary)} · ${path.basename(modelPath)} · port ${port} · ${niced ? 'nice 19' : 'öncelik düşürme YOK (win32)'}`, slot);
    let proc;
    try {
      proc = spawnImpl(cmd, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PATH: augmentedPath(process.env.PATH) },
        // 🔴 ADP-908 — YAZILABİLİR ÇALIŞMA DİZİNİ ŞART (ölçüldü, varsayılmadı).
        // `whisper-server --convert` yüklenen sesi ffmpeg ile GEÇİCİ BİR DOSYAYA
        // çevirir ve o dosyayı **çalışma dizinine** yazar. Finder/Dock'tan açılan
        // bir macOS uygulamasının cwd'si `/`dir (ölçüldü: kurulu iki CrewPane
        // süreci de `cwd=/`) — orası yazılamaz, dolayısıyla HER istek
        // `500 {"error":"FFmpeg conversion failed."}` döner:
        //   cwd=/               → 500 FFmpeg conversion failed
        //   cwd=/System/Library → 500 FFmpeg conversion failed
        //   cwd=$HOME           → 200 (metin döndü)
        // Sonucu: FİNAL katman sessizce buluta düşer (para + gecikme), TASLAK
        // katmanın bulut fallback'i YOKTUR → canlı transkript ekranda hiç
        // görünmez. Terminalden koşan e2e'de cwd repo kökü (yazılabilir) olduğu
        // için kapılar yeşil kalıyordu — kör nokta buydu.
        cwd: deps.cwd || os.tmpdir(),
      });
    } catch (e) {
      slot.lastError = String((e && e.message) || e);
      return { ok: false, reason: 'local-spawn-failed', detail: slot.lastError };
    }
    slot.proc = proc;
    slot.pid = proc.pid;
    slot.port = port;
    slot.ready = false;
    slot.stderrTail = [];
    if (proc.stderr && proc.stderr.on) {
      proc.stderr.on('data', (b) => {
        const s = String(b);
        slot.stderrTail.push(s);
        if (slot.stderrTail.length > 40) slot.stderrTail.shift();
      });
    }
    if (proc.stdout && proc.stdout.on) proc.stdout.on('data', () => {});
    proc.on('exit', (code, signal) => {
      const wasReady = slot.ready;
      if (slot.proc === proc) {
        slot.proc = null;
        slot.ready = false;
        slot.port = 0;
        slot.pid = null;
      }
      slot.lastError = `exit code=${code} signal=${signal || '-'} ${slot.stderrTail.slice(-3).join('').slice(-200)}`;
      log(deps, `sunucu öldü (code=${code} signal=${signal || '-'})${wasReady ? ' — hazırken' : ''}`, slot);
      noteRestart(deps, slot);
    });
    proc.on('error', (e) => {
      slot.lastError = String((e && e.message) || e);
    });

    const deadline = now() + (deps.readyTimeoutMs || SERVER_READY_TIMEOUT_MS);
    const probe = deps.probeImpl || probePort;
    while (now() < deadline) {
      if (!slot.proc) {
        return { ok: false, reason: 'local-died-on-start', detail: slot.lastError.slice(0, 200) };
      }
      if (await probe(port)) {
        slot.ready = true;
        touchIdle(deps, slot);
        log(deps, `hazır (port ${port})`, slot);
        return { ok: true, port };
      }
      await sleep(deps.pollMs || 200);
    }
    stopServer(slot);
    return { ok: false, reason: 'local-start-timeout' };
  })();

  slot.starting = startPromise;
  try {
    return await startPromise;
  } finally {
    slot.starting = null;
  }
}

// WIN-FIX-01 — ADP-874'ün SAF ölçüm kararı `platform/procRss.cjs`e taşındı:
// `claudeBrainSession` aynı ölçümü win32 dalı OLMADAN ikinci kez yazmıştı ve
// Windows'ta bellek tavanı hiç tetiklenmiyordu. Kod BURADAN değil, oradan gelir;
// bu dosyanın dışa aktardığı adlar (rssCommand/parseRssKb) ve testleri AYNEN durur.
const { rssCommand, parseRssKb } = require('../../platform/procRss.cjs');

/** Sunucunun RSS'i (MB). Ölçemezsek 0 döner (tavan kapısı sessizce atlanır). */
function readRssMb(pid, execFileImpl = execFile, deps = {}) {
  return new Promise((resolve) => {
    if (!pid) return resolve(0);
    const plat = deps.platform || process.platform;
    const cmd = rssCommand(pid, deps);
    execFileImpl(cmd.file, cmd.argv, (err, stdout) => {
      if (err) return resolve(0);
      const kb = parseRssKb(stdout, plat);
      resolve(kb > 0 ? Math.round(kb / 1024) : 0);
    });
  });
}

/** Bellek tavanı kapısı — aşıldıysa süreci kapat (bir sonraki tur taze başlatır). */
async function enforceMemoryCeiling(deps = {}, slot = state) {
  const pid = slot.pid;
  if (!pid) return 0;
  const rss = await readRssMb(pid, deps.execFileImpl || execFile, { platform: deps.platform, env: deps.env });
  const ceiling = deps.maxRssMb || slot.maxRssMb;
  if (rss > ceiling) {
    log(deps, `RSS ${rss} MB > tavan ${ceiling} MB → sunucu kapatılıyor`, slot);
    stopServer(slot);
  }
  return rss;
}

/** webm/mp4/ogg → 16 kHz mono WAV. ffmpeg yoksa {ok:false,reason:'local-no-ffmpeg'}. */
async function toWav(buf, mimeType, deps = {}) {
  const execFileImpl = deps.execFileImpl || execFile;
  const ffmpeg = deps.ffmpegPath !== undefined ? deps.ffmpegPath : resolveBinary(FFMPEG_BIN, { exists: deps.existsSync || fs.existsSync });
  if (!ffmpeg) return { ok: false, reason: 'local-no-ffmpeg' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewpane-stt-'));
  const ext = extFromMime(mimeType);
  const inPath = path.join(dir, `in.${ext}`);
  const outPath = path.join(dir, 'out.wav');
  fs.writeFileSync(inPath, buf);
  return new Promise((resolve) => {
    execFileImpl(ffmpeg, ffmpegArgs(inPath, outPath), { timeout: 15000 }, (err) => {
      if (err) {
        cleanupDir(dir);
        return resolve({ ok: false, reason: 'local-convert-failed', detail: String((err && err.message) || err).slice(0, 200) });
      }
      let wav;
      try {
        wav = fs.readFileSync(outPath);
      } catch (e) {
        cleanupDir(dir);
        return resolve({ ok: false, reason: 'local-convert-failed', detail: String((e && e.message) || e).slice(0, 200) });
      }
      cleanupDir(dir);
      resolve({ ok: true, wav });
    });
  });
}

function cleanupDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* yok say */ }
}

/** MediaRecorder mime'ı → ffmpeg'in tanıyacağı uzantı (ADP-312: uzantı ÖNEMLİ). */
function extFromMime(mimeType) {
  const t = String(mimeType || '').toLowerCase();
  if (t.includes('webm')) return 'webm';
  if (t.includes('ogg')) return 'ogg';
  if (t.includes('mp4') || t.includes('m4a') || t.includes('aac')) return 'm4a';
  if (t.includes('wav')) return 'wav';
  if (t.includes('mpeg') || t.includes('mp3')) return 'mp3';
  return 'webm';
}

/**
 * YEREL transkripsiyon — `transcribeWhisper` ile AYNI şekilli sonuç.
 * { ok:true, text, engine:'local', ms } | { ok:false, reason, detail? }
 */
async function transcribeLocal(payload = {}, deps = {}, slot = state) {
  const t0 = now();
  const { audioBase64, mimeType, language = 'tr', prompt } = payload;
  const engine = slot.tier === 'draft' ? 'local-draft' : 'local';
  if (!audioBase64) return { ok: false, reason: 'no-audio' };
  let buf;
  try {
    buf = Buffer.from(audioBase64, 'base64');
  } catch {
    return { ok: false, reason: 'bad-audio' };
  }
  if (!buf.length) return { ok: false, reason: 'empty-audio' };

  // Tek istek kuralı (ağır iş yasağı): ikinci eşzamanlı tur beklemez, buluta düşer.
  // ADP-814: taslak katmanında "buluta düşme" YOK — kısmi hipotez atılabilir bir
  // üründür, meşgulse tur DÜŞÜRÜLÜR (kuyruk büyütmek gecikmeyi artırır, azaltmaz).
  if (slot.busy) return { ok: false, reason: slot.tier === 'draft' ? 'draft-busy' : 'local-busy' };

  const ready = await ensureServer(deps, slot);
  if (!ready.ok) return ready;

  const conv = await toWav(buf, mimeType, deps);
  if (!conv.ok) return conv;
  const convMs = now() - t0;

  // Sessizlik/gürültü nöbeti SUNUCUYA GİTMEDEN: uydurma metin (ADP-312
  // "Altyazı M.K.", ADP-909 "abone olmayı unutmayın") hayalet komut çalıştırıyordu
  // ve yerel modelin kendi metriği bunu YAKALAMIYOR (ADP-813 ölçümü).
  //
  // ADP-909 (a) — HER TURDA TEK SATIR LOG. Şikâyetin kanıtı ancak "STT'ye NE
  // gitti / NE döndü" kayıtlıysa üretilebilir; bu satır olmadan sessizlikte ne
  // olduğu ancak tahmin edilebiliyordu. Sır içermez, yalnız sayı.
  // ADP-912 (a) — KATMAN KAPIYA SÖYLENİR: taslak (canlı altyazı) katmanı daha
  // sıkı bir dinamik eşiğiyle çalışır. Gerekçe + ölçüm sttSilenceGate DEFAULTS'ta;
  // burada ikinci bir karar YOK, yalnız hangi katmanda olduğumuz bildiriliyor.
  const gate = silenceGate.evaluateWav(conv.wav, {
    settings: deps.settings,
    overrides: { minSpeechMs: deps.minSpeechMs, minDynamicDb: deps.minDynamicDb },
    tier: slot.tier === 'draft' ? 'draft' : 'final',
  });
  log(deps, `kapı: ${silenceGate.describe(gate)}`, slot);
  if (!gate.speech) {
    return {
      ok: false,
      reason: 'no-speech',
      engine,
      ms: now() - t0,
      speechMs: gate.stats.speechMs,
      gate: gate.verdict,
      gateWhy: gate.why,
    };
  }

  slot.busy = true;
  try {
    const fetchImpl = deps.fetchImpl || fetch;
    const form = new FormData();
    form.append('file', new Blob([conv.wav], { type: 'audio/wav' }), 'audio.wav');
    form.append('temperature', '0.0');
    // 🔑 ÖLÇÜLDÜ (ADP-813, aynı klip, aynı sunucu): `verbose_json` 879–890 ms,
    // `json` 478–640 ms — fark kelime-başı olasılık/zaman damgası hesabı. Buluttaki
    // `verbose_json` gerekçesi `no_speech_prob`'du (ADP-312 sessizlik nöbeti); yerel
    // metrik ayırt EDİCİ DEĞİL (yukarıdaki not) ve sessizlik nöbeti zaten SESTEN
    // alınıyor → burada 400 ms'yi hiçbir şey karşılığında ödemiyoruz.
    form.append('response_format', 'json');
    if (language) form.append('language', String(language));
    if (prompt) form.append('prompt', String(prompt).slice(0, 400));
    let res;
    const ctrl = new AbortController();
    const budget = deps.requestTimeoutMs
      || (slot.tier === 'draft' ? DRAFT_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
    const timer = setTimeout(() => ctrl.abort(), budget);
    try {
      res = await fetchImpl(`http://127.0.0.1:${ready.port}/inference`, {
        method: 'POST',
        body: form,
        signal: ctrl.signal,
      });
    } catch (e) {
      const msg = String((e && e.message) || e);
      // Sunucu bu istekte öldüyse bir sonraki tur onu yeniden başlatır.
      return { ok: false, reason: msg.includes('abort') ? 'local-timeout' : 'local-network', detail: msg.slice(0, 200) };
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 200); } catch { /* yok say */ }
      return { ok: false, reason: `local-http-${res.status}`, detail };
    }
    let json;
    try {
      json = await res.json();
    } catch {
      return { ok: false, reason: 'bad-json' };
    }
    const raw = normalizeLocalResult(json);
    // ADP-909 (c) — ÇIKTI SÜZGECİ: kapı sesi geçirse bile metin BİLİNEN bir
    // halüsinasyon kalıbının tamamıysa reddet. Kalıplar veri dosyasında
    // (sttHallucinations.json); alt-dize DEĞİL tam-metin eşleşmesi, yani gerçek
    // "abone …" cümleleri etkilenmez.
    const out = hallucinationGuard.filterResult(raw);
    if (raw.ok && !out.ok) {
      log(deps, `halüsinasyon süzgeci: "${String(raw.text).slice(0, 60)}" ≡ bilinen kalıp "${out.hallucination}" → reddedildi`, slot);
    } else {
      log(deps, `sonuç: ${raw.ok ? `"${String(raw.text).slice(0, 60)}"` : `∅ ${raw.reason}`}`, slot);
    }
    const ms = now() - t0;
    return { ...out, engine, ms, convMs };
  } finally {
    slot.busy = false;
    touchIdle(deps, slot);
    // Tavan kontrolü turu BLOKLAMAZ (sonuç zaten döndü).
    enforceMemoryCeiling(deps, slot).catch(() => {});
  }
}

/**
 * ADP-814 — KISMİ (taslak) transkripsiyon: kayıt SÜRERKEN, kümülatif ses.
 * `transcribeLocal` ile aynı gövde, farklı katman → { ok, text, engine:'local-draft', ms }.
 *
 * SÖZLEŞME: bu sonuç **hiçbir zaman komut olarak çalıştırılmaz** — yalnız ekranda
 * "şimdilik böyle duyuyorum" gösterir. Karar/eylem zinciri kayıt bitince gelen
 * FİNAL metne bağlıdır (ADP-312 sessizlik nöbeti + ADP-314 onay akışı değişmedi).
 */
function transcribePartial(payload = {}, deps = {}) {
  return transcribeLocal(payload, deps, draftSlot);
}

/** ADP-814 — taslak sunucuyu ısıt (kayıt başlarken; ilk kısmi tur soğuk gelmesin). */
function warmupDraft(deps = {}) {
  return ensureServer(deps, draftSlot);
}

/** Ayarlar/teşhis için durum fotoğrafı (SIR İÇERMEZ). */
function status(opts = {}) {
  const existsSync = opts.existsSync || fs.existsSync;
  // ADP-874 — platform seam'i BURADAN da geçer: teşhis ekranı "aradım ve bulamadım"
  // derken hangi adları/dizinleri aradığını gerçekten platforma göre aramalı.
  const platform = opts.platform || process.platform;
  const binary = resolveBinary(SERVER_BIN, { exists: existsSync, platform });
  const modelPath = resolveModelPath({ settings: opts.settings, exists: existsSync, platform });
  const ffmpeg = resolveBinary(FFMPEG_BIN, { exists: existsSync, platform });
  // ADP-814 — taslak katmanı AYRI raporlanır: "canlı transkript neden akmıyor?"
  // sorusu ekrandan cevaplanabilsin (final model var ama base yok olabilir).
  const draftModelPath = resolveDraftModelPath({ settings: opts.settings, exists: existsSync, platform });
  return {
    available: !!(binary && modelPath && ffmpeg),
    binary,
    modelPath,
    ffmpeg,
    // ADP-874 — "ağır iş yasağı"nın öncelik ayağı win32'de YOK; sessizce eksik
    // bırakmak yerine durum fotoğrafı bunu söyler (teşhis ekranı okur).
    niced: platform !== 'win32',
    running: !!state.proc,
    ready: state.ready,
    port: state.port,
    pid: state.pid,
    busy: state.busy,
    cooldownMs: Math.max(0, state.cooldownUntil - now()),
    lastError: String(state.lastError || '').slice(0, 200),
    draft: {
      available: !!(binary && draftModelPath && ffmpeg),
      modelPath: draftModelPath,
      modelFile: DRAFT_MODEL_FILE,
      running: !!draftSlot.proc,
      ready: draftSlot.ready,
      port: draftSlot.port,
      pid: draftSlot.pid,
      busy: draftSlot.busy,
      cooldownMs: Math.max(0, draftSlot.cooldownUntil - now()),
      lastError: String(draftSlot.lastError || '').slice(0, 200),
    },
  };
}

/** Testler için: durumu sıfırla (süreç varsa öldür). */
function _resetForTest() {
  stopServer();
  for (const s of slots) {
    s.busy = false;
    s.restarts = [];
    s.cooldownUntil = 0;
    s.lastError = '';
  }
}

module.exports = {
  // saf
  MODEL_FILE,
  DRAFT_MODEL_FILE,
  SERVER_BIN,
  resolveBinary,
  resolveModelPath,
  resolveDraftModelPath,
  buildServerArgs,
  rssCommand,
  parseRssKb,
  readRssMb,
  ffmpegArgs,
  extFromMime,
  normalizeLocalResult,
  isBracketOnly,
  shouldFallbackToCloud,
  pcmSpeechStats,
  findWavDataOffset,
  hasSpeech,
  FRAME_RMS_THRESHOLD,
  MIN_SPEECH_MS,
  // ADP-909 — kapı + süzgeç tek gerçek; çağıranlar (jarvisVoice bulut yolu,
  // ölçüm scriptleri, e2e) buradan ULAŞSIN, ikinci bir require zinciri kurmasın.
  silenceGate,
  hallucinationGuard,
  // durum
  ensureServer,
  transcribeLocal,
  transcribePartial,
  warmupDraft,
  enforceMemoryCeiling,
  stopServer,
  status,
  _resetForTest,
  _state: state,
  _draftState: draftSlot,
};
