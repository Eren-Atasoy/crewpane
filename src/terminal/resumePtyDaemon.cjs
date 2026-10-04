// CrewPane — ADP-limit (ADR-007 Faz 4) pty resume adapter.
//
// The MISSING half of the resume-core / two-adapter split (ADR §6): the tmux
// adapter (resumeTmux + scripts/resume-daemon.mjs) has covered the autopilot
// workers since ADP-088/180, but the app-içi node-pty panes had NO daemon at all
// — a limited in-app agent sat on its limit screen forever (ADP-limit root cause
// RC1-RC3). This module runs ResumeDaemonCore INSIDE the Electron main process,
// with every io injected from main's own `ptys` Map:
//
//   capturePane  → ptyTail(entry.buffer)      (the rolling 256KB replay buffer)
//   sendResume   → child.write continue nudge (live) / spawnPty --resume (exited)
//   selectOption → child.write digit          (Format-A graceful stop)
//
// Raw pty stream vs tmux's rendered screen: tmux capture-pane returns the drawn
// grid, but the pty buffer is the RAW byte stream where spinner redraws pile up
// on `\r` without newlines — the tail gates of limitDetect (TAIL_LINES/ANCHOR)
// would see one giant glued line. ptyTail() normalizes every `\r` to `\n` so each
// redraw frame becomes its own line and the LAST frame lands at the tail bottom.
//
// Keystroke submit follows the proven ADP-048/266 two-step: a single text+CR
// chunk can drop the CR before the claude TUI registers the text, so the text is
// written first and the CR follows after a short gap (same pattern as
// softResetPane in main.js). tmux send-keys does this split natively — parity.
//
// Runtime scoping (spec §3.3): the queue file is SHARED with the tmux daemon, so
// this side only ever re-arms `runtime === 'pty'` entries (rescheduleOnBoot
// filter) and the tmux script re-arms the complement — neither daemon fires the
// other's records.
//
// Every external effect is injectable (getPanes/writePane/respawnPane/scheduler/
// now/timers) so the whole state machine runs under a fake clock + fake ptys Map
// in resumePtyDaemon.test.cjs — the resumeDaemonCore.cjs testing pattern.

'use strict';

const { ResumeDaemonCore } = require('./resumeDaemonCore.cjs');
const resumeQueue = require('./resumeQueue.cjs');
const resumeTmux = require('./resumeTmux.cjs');
const resumeNotify = require('./resumeNotify.cjs');
const engineSwitch = require('../agents/engineSwitch.cjs'); // ADP-938 — limitte otomatik hesap geçişi
const resumeTelemetry = require('./resumeTelemetry.cjs'); // RES-08 — ölçülebilir başarı oranı
const fs = require('node:fs');
const path = require('node:path');

// ADP-180 decision: 5s poll — Claude's /rate-limit-options prompt is transient,
// 15s missed it. Buffer slicing is RAM-only, far cheaper than even capture-pane.
const DEFAULT_POLL_MS = 5_000;
// Heartbeat (ADP-098: a silent miss must be impossible): log every verdict CHANGE
// plus every Nth poll, so crewpane.log shows liveness without flooding (~1/min).
const HEARTBEAT_EVERY = 12;
// ADP-048/266 — gap between the typed text and its submitting CR.
const SUBMIT_GAP_MS = 400;
// RES-05 — SIFIR-TOKEN yoklama tuşu. ESC, claude/codex TUI'sinde giriş kutusunu
// temizler ve ekranı YENİDEN BOYAR; hiçbir metin ve hiçbir CR yazılmadığı için motora
// TEK BİR İSTEK bile gitmez. Bilerek `writeLine` DEĞİL ham `writePane` kullanılır:
// writeLine 400 ms sonra bir CR gönderir — yani "yoklama" bir GÖNDERİM olurdu.
const PROBE_KEY = '\x1b';

// Only AGENT panes are observed; plain login-shell panes have no session to
// resume and no agentId to dedupe on (resumeQueue dedupes per agentId).
const AGENT_COMMANDS = Object.freeze(['claude', 'codex']);

// ─── LIMIT-RESUME-02 — motorun KENDİ otomatik-devamı olan en düşük claude sürümü ──
// ÖLÇÜLEN: 2.1.274 ve 2.1.276 (18.09 transcript'leri + ikili dizgeleri). Daha eski bir
// 2.1.2xx'te özelliğin var olduğuna kanıt yok; taban düşük tutulursa "native" sayılan
// bir pane'de motor hiç uyanmaz ve nöbetçi de bandı göremez → hiç dokunulmayan pane.
// Taban yükseltmek eskiyi bugünkü (ESC'siz) yolda bırakır — ölçülü risk.
const NATIVE_CONTINUE_MIN_VERSION = '2.1.270';
// Transcript'in ilk bayrağı: her kayıt `"version":"2.1.276"` taşır (ölçüldü).
const TRANSCRIPT_VERSION_RE = /"version":"(\d+\.\d+\.\d+)"/;
const TRANSCRIPT_HEAD_BYTES = 16 * 1024;
// Transcript henüz yoksa (pane yeni açıldı) sürüm bu aralıkla yeniden aranır.
const VERSION_RETRY_MS = 60_000;

/** `a >= b` for dotted versions ("2.1.276" ≥ "2.1.270"). Non-numeric → false. */
function versionAtLeast(a, b) {
  const pa = String(a || '').match(/\d+/g);
  const pb = String(b || '').match(/\d+/g);
  if (!pa || !pb) return false;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = parseInt(pa[i] || '0', 10);
    const y = parseInt(pb[i] || '0', 10);
    if (x !== y) return x > y;
  }
  return true;
}

/**
 * LIMIT-RESUME-02 — the CLI version that WROTE this pane's transcript (the pane's own
 * binary, not whatever `claude` on PATH is today). Reads the first 16 KB of
 * `~/.claude/projects/<cwd>/<sessionId>.jsonl`; null when absent/unreadable.
 */
function transcriptVersion(pane, homedir) {
  if (!pane || !pane.cwd || !resumeTmux.isUuid(pane.sessionId)) return null;
  try {
    const file = path.join(resumeTmux.claudeProjectsDir(pane.cwd, homedir), `${pane.sessionId}.jsonl`);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(TRANSCRIPT_HEAD_BYTES);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const m = buf.toString('utf8', 0, n).match(TRANSCRIPT_VERSION_RE);
      return m ? m[1] : null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Tail of a raw pty stream, normalized for limitDetect's line-based gates:
 * `\r`-overwritten redraw frames each become their own line, so the latest
 * frame is the bottom of the tail (spec §3.5). Pure — unit tested with real
 * claude limit fixtures.
 */
function ptyTail(buffer, max = 8192) {
  const t = String(buffer || '').slice(-max);
  return dedupeFrames(t.replace(/\r+\n/g, '\n').replace(/\r/g, '\n'));
}

// RES-03 — largest repeated block we will collapse (a full boxed menu redraw).
const MAX_FRAME_LINES = 60;

/**
 * RES-03 (D2) — collapse CONSECUTIVE IDENTICAL redraw frames to one.
 *
 * `\r` → `\n` turns every repaint into its own set of lines, so a TUI that
 * redraws its menu four times contributes 4× the lines a human sees. MEASURED:
 * one second of spinner produced 42 normalized lines, which pushes the limit
 * ANNOUNCEMENT out of the 14-line detection tail — the reset clock is then never
 * read (9 of 9 real events logged "~5dk fallback"). Collapsing byte-identical
 * repeats brings the normalized tail back toward what the pane actually shows.
 *
 * Only EXACT, ADJACENT repeats are removed, SMALLEST repeating block first, so
 * nothing a user could confuse with content is lost: two different spinner frames
 * differ by their glyph and both survive. Smallest-first is what makes N repeats
 * collapse to ONE — a larger window would greedily match a multiple of the true
 * frame (3 lines repeated 6× read as one 9-line block repeated twice) and leave
 * copies behind.
 */
function dedupeFrames(text) {
  const lines = String(text).split('\n');
  if (lines.length < 4) return text;
  const out = [];
  let i = 0;
  while (i < lines.length) {
    let collapsed = false;
    const maxBlock = Math.min(MAX_FRAME_LINES, (lines.length - i) >> 1);
    for (let b = 1; b <= maxBlock; b++) {
      let reps = 1;
      for (;;) {
        const from = i + reps * b;
        if (from + b > lines.length) break;
        let same = true;
        for (let k = 0; k < b; k++) {
          if (lines[i + k] !== lines[from + k]) { same = false; break; }
        }
        if (!same) break;
        reps++;
      }
      if (reps === 1) continue;
      for (let k = 0; k < b; k++) out.push(lines[i + k]);
      i += reps * b;
      collapsed = true;
      break;
    }
    if (!collapsed) out.push(lines[i++]);
  }
  return out.join('\n');
}

/** True for a pane entry the daemon should watch (agent CLI + dedupe identity). */
function isAgentPane(entry) {
  return (
    !!entry &&
    AGENT_COMMANDS.includes(entry.command) &&
    typeof entry.agentId === 'string' &&
    entry.agentId !== ''
  );
}

/**
 * One compact per-pane verdict for the heartbeat line (mirrors resume-daemon.mjs).
 *
 * RES-07 §3 — YENİ VERDICT `SUSPECT`: limit şüphesi VAR ama reset saati okunamadı.
 * Bugüne kadar bu iki hâl tek `PLAIN`/`PROMPT` etiketinin içinde eriyordu; oysa
 * ölçülen arızanın tamamı (9/9 olay "~5dk fallback") tam olarak İKİNCİ hâldi. Kalp
 * atışına bakan biri "saat okunamıyor" salgınını ancak ayrı bir etiketle görebilir.
 */
function verdictFor(paneId, text, result) {
  if (!text) return `${paneId}=nocap`;
  if (!result) return `${paneId}=clean`;
  // ADP-938 — hesap geçişi kalp atışında GÖRÜNÜR olsun (sessiz geçiş yasak).
  if (result.kind === 'switch') return `${paneId}=SWITCH/${result.from || '?'}→${result.to || '?'}`;
  const known = Number.isFinite(result.resetAt);
  // LIMIT-RESUME-02 — native mod kalp atışında GÖRÜNÜR: motor kendi devam edecek /
  // nöbetçi ne yaptı. Saat okunamadıysa yine SUSPECT ayrımı.
  if (result.kind === 'native') {
    return `${paneId}=${known ? 'NATIVE' : 'NATIVE-SUSPECT'}/${result.engine || '?'}/${result.action}`;
  }
  if (result.kind === 'prompt') {
    return `${paneId}=${known ? 'PROMPT' : 'SUSPECT'}/${result.engine || '?'}/${result.action}`;
  }
  return `${paneId}=${known ? 'PLAIN' : 'SUSPECT'}/${result.engine || '?'}/${result.status}`;
}

/**
 * Start the in-app pty resume daemon.
 *
 * @param {object} cfg
 * @param {Function} cfg.getPanes      () => Map<paneId, {child?, buffer, agentId, command, cwd, sessionId}>
 * @param {Function} cfg.writePane     (paneId, data) => boolean — write into the pane's pty stdin
 * @param {Function} [cfg.respawnPane] (queueEntry, opts?) => {paneId}|null — relaunch an EXITED
 *                                     agent on its prior session (the ADP-192 spawnPty resume
 *                                     path). ADP-938 passes {engineProfileId} to relaunch it on
 *                                     ANOTHER account; omitted → today's behavior, unchanged.
 * @param {Function} [cfg.closePane]   (paneId) => boolean — ADP-938: close the pane sitting on
 *                                     its limit before relaunching under another account
 *                                     (one agent = one pane; spawnPty dedupes otherwise)
 * @param {object}   [cfg.engineAccounts] ADP-938 auto-switch seams (ADP-936 store, CALLED not
 *                                     re-implemented): {enabled, listProfiles, activeProfile,
 *                                     setActive}. Absent → no auto-switch (today's behavior).
 * @param {string}   [cfg.homedir]     queue/jsonl root seam (tmp dir in tests)
 * @param {string}   [cfg.notifyLog]   notification log path (docs/.agent-notifications in dev)
 * @param {boolean}  [cfg.dryRun]      observe + DRYRUN lines only, never touch a pane
 * @param {number}   [cfg.pollMs]
 * @param {number}   [cfg.verifyWindowMs]
 * @param {number}   [cfg.resetBufferMs]       ADP-428 — resetAt safety margin (default 90s)
 * @param {number[]} [cfg.verifyRetryDelaysMs] ADP-428 — verify-fail re-send waits (default 5m,15m)
 * @param {number}   [cfg.verifyMaxAttempts]   ADP-428 — send budget before FAIL alert (default 3)
 * @param {Function} [cfg.log]
 * @param {Function} [cfg.onEvent]     ({kind, paneId, agentId, detail, …}) → renderer toast/rozet
 *                                     hook. RES-07: `schedule|probe|retry|resumed` de gelir ve
 *                                     `nextAttemptAt/resetAt/resetKnown/attempt/verdict` taşır.
 * @param {number}   [cfg.probeSettleMs]   RES-05 — ESC ile ekranın okunması arası
 * @param {number}   [cfg.probeRetryMs]    RES-05 — sonuçsuz yoklamanın tekrar aralığı
 * @param {number}   [cfg.probeMaxUnknown] RES-05 — kaç sonuçsuz yoklamadan sonra kör gönderim
 * @param {Function|false} [cfg.telemetry] RES-08 — JSONL yazıcı; false → kapalı
 * @param {object}   [cfg.scheduler]   fake-clock ResumeScheduler (tests)
 * @param {Function} [cfg.now]         fake clock (tests)
 * @param {object}   [cfg.timers]      {setInterval, clearInterval} (tests inject no-ops)
 * @param {number}   [cfg.submitGapMs]
 * @returns {{ stop:Function, pollOnce:Function, core:ResumeDaemonCore }}
 */
function startPtyResumeDaemon(cfg = {}) {
  const {
    getPanes,
    writePane,
    respawnPane = null,
    closePane = null,
    engineAccounts = null,
    homedir = undefined,
    notifyLog = null,
    dryRun = false,
    pollMs = DEFAULT_POLL_MS,
    verifyWindowMs = undefined,
    resetBufferMs = undefined,
    verifyRetryDelaysMs = undefined,
    verifyMaxAttempts = undefined,
    log = () => {},
    onEvent = null,
    scheduler = undefined,
    now = undefined,
    timers = { setInterval, clearInterval },
    submitGapMs = SUBMIT_GAP_MS,
    // RES-05 — ön-yoklama ayarları (çekirdek varsayılanları; testler kısaltır).
    probeSettleMs = undefined,
    probeRetryMs = undefined,
    probeMaxUnknown = undefined,
    // RES-08 — telemetri yazıcısı. `false` → kapalı; fonksiyon → o kullanılır;
    // verilmezse hesap kapsamlı `resume-events.jsonl`.
    telemetry = undefined,
    /* TOK-C (D-02 v2) — HARCAMA KAPISI: `(paneId) => {allow, reason}`.
       Verilmezse fren YOKTUR (bugünkü davranış). Yalnız `writeLine` sorar. */
    budgetGate = undefined,
    /* LIMIT-RESUME-02 — ANA BAYRAK (K13 kontrol kolu). true (varsayılan): claude ≥
       2.1.270 pane'leri native-continue moduna girer (tuş/ESC/kör gönderim YOK,
       nöbetçi) ve ESC yoklaması (RES-05 probePane) HİÇBİR pane'e enjekte edilmez —
       eski CLI da bugünkü yolu ESC'siz koşar (§6.3/5). false: bugünkü davranış
       bit-bit (ESC + kör gönderim) — harness bunu kırmızıya döndürerek kanıtlar. */
    limitResume02 = true,
    /* LIMIT-RESUME-02 — `() => string|null`: makinedeki claude ikilisinin sürümü
       (main.js `claude --version`ı bir kez asenkron koşup önbellekler). Transcript
       sürümü BULUNAMADIĞINDA yedek; verilmezse yedek yok. */
    claudeVersion = undefined,
    /* LIMIT-RESUME-02 — test dikişi: `(pane, homedir) => string|null`. */
    paneVersion = transcriptVersion,
  } = cfg;
  if (typeof getPanes !== 'function') throw new Error('startPtyResumeDaemon: getPanes required');
  if (typeof writePane !== 'function') throw new Error('startPtyResumeDaemon: writePane required');

  // RES-07 — `extra` rozetin VERİSİNİ taşır (nextAttemptAt/resetAt/resetKnown/…);
  // metin üretilmez, biçimlendirme arayüzün (ve i18n'in) işidir.
  const emit = (kind, entryLike, detail, extra) => {
    if (!onEvent) return;
    try {
      onEvent({
        kind,
        paneId: (entryLike && entryLike.paneRef) || null,
        agentId: (entryLike && entryLike.agentId) || null,
        detail: detail || null,
        ...(extra && typeof extra === 'object' ? extra : null),
      });
    } catch { /* renderer hook is best-effort */ }
  };

  /** The live pane (if any) currently bound to this agentId. */
  function findLivePaneByAgent(agentId) {
    if (typeof agentId !== 'string' || !agentId) return null;
    for (const [paneId, e] of getPanes()) {
      if (isAgentPane(e) && e.agentId === agentId) return { paneId, entry: e };
    }
    return null;
  }

  /** ADP-048/266 two-step submit: text now, CR after a beat (tmux send-keys parity). */
  function writeLine(paneId, text) {
    const ok = writePane(paneId, text);
    if (!ok) return false;
    if (submitGapMs > 0) {
      const t = setTimeout(() => writePane(paneId, '\r'), submitGapMs);
      if (typeof t.unref === 'function') t.unref();
    } else {
      writePane(paneId, '\r'); // tests: submit synchronously
    }
    return true;
  }

  const io = {
    // capture — the rolling buffer IS the pane content; normalize the raw stream.
    capturePane: (paneRef) => {
      const e = getPanes().get(paneRef);
      return e ? ptyTail(e.buffer) : '';
    },

    // liveness — the pty child is process-authoritative: a pane still in the Map
    // has a live child (onExit deletes it). Content is consulted first (ADP-180),
    // but 'other' means the TUI is attached (a live pty ≠ tmux's version-renamed
    // process problem). Absent from the Map → engine exited → `--resume` path.
    liveness: (entry, text) => {
      const pane = getPanes().get(entry && entry.paneRef);
      if (!pane) return 'shell';
      return resumeTmux.livenessFromText(text) === 'shell' ? 'shell' : 'live';
    },

    // identity — the ptys Map holds the spawn-time truth (engine/agentId/minted
    // sessionId/cwd), MORE authoritative than any registry file (spec §3.1).
    lookupPane: (paneRef) => {
      const e = getPanes().get(paneRef);
      if (!e) return null;
      return {
        engine: e.command,
        agentId: e.agentId || null,
        sessionId: e.sessionId || null,
        cwd: e.cwd || null,
        // ACCT-FIX-01 — pane HANGİ hesap profiliyle koşuyor (spawn anında çözüldü,
        // main.js ptys.set). Limit defteri bunu yazar, defterdeki "aktif"i değil.
        engineProfileId: typeof e.engineProfileId === 'string' ? e.engineProfileId : null,
      };
    },

    // RES-05 — SIFIR-TOKEN ÖN-YOKLAMA: TUI'yi tazele, SUBMIT ETME. Tek bir ESC baytı
    // gider; metin de CR de YOKTUR, dolayısıyla motor hiçbir istek üretmez ve jeton
    // sayacı kıpırdamaz. Dönüş `true` ise çekirdek tazelenmiş ekranı okumaya geçer.
    // LIMIT-RESUME-02 — bayrak AÇIKKEN yoklama yeteneği hiç verilmez: ESC çalışan
    // isteği keser ve motorun kendi devamını iptal eder (ölçüldü). Çekirdek
    // `probePane` yoksa fire() bugünkü ESC'siz yolunu koşar (RES-05 sözleşmesi).
    ...(limitResume02
      ? null
      : {
          probePane: (paneRef) => {
            if (typeof paneRef !== 'string' || !paneRef) return false;
            if (!getPanes().get(paneRef)) return false; // pane kapanmış → yoklanacak TUI yok
            return writePane(paneRef, PROBE_KEY) === true;
          },
        }),

    // LIMIT-RESUME-02 — nöbetçinin TEK Enter'ı ("Your usage limit has reset · press
    // enter to continue" fazı). Ajanı yeniden ÇALIŞTIRIR = harcar → bütçe kapısı sorulur.
    pressEnter: (paneRef) => {
      if (typeof paneRef !== 'string' || !paneRef) return false;
      if (!getPanes().get(paneRef)) return false;
      if (typeof budgetGate === 'function') {
        let verdict = null;
        try {
          verdict = budgetGate(paneRef);
        } catch {
          verdict = null;
        }
        if (verdict && verdict.allow === false) {
          log(`[resume] bütçe duraklattı — nöbetçi Enter YAZILMADI paneRef=${paneRef} sebep=${verdict.reason || 'budget-paused'}`);
          emit('budget-paused', { paneRef }, verdict.reason || 'budget-paused');
          return false;
        }
      }
      const ok = writePane(paneRef, '\r') === true;
      if (ok) emit('continue', { paneRef }, 'nöbetçi: motorun beklediği tek Enter gönderildi');
      return ok;
    },

    // Format-A graceful stop: press the digit at the live prompt.
    selectOption: (paneRef, n) => {
      if (typeof paneRef !== 'string' || !paneRef) return false;
      if (!Number.isInteger(n) || n < 1 || n > 9) return false;
      const ok = writeLine(paneRef, String(n));
      if (ok) emit('select', { paneRef }, `limit prompt'unda seçenek ${n} basıldı`);
      return ok;
    },

    // fire — continue-vs-resume (ADR §5.2):
    //   live pane            → type the "devam et" nudge at its prompt
    //   pane gone, agent live under ANOTHER pane (R5 double-spawn guard: user or
    //   restore reopened it) → remap the entry and nudge THAT pane
    //   agent gone entirely  → respawnPane (ADP-192 spawnPty --resume path; core
    //   already gated the uuid before taking this branch)
    sendResume: (entry, opts = {}) => {
      /* ── TOK-C (D-02 v2) — BÜTÇE FRENİ ──────────────────────────────────────
         Kapı `sendResume`in BAŞINDA sorulur, `writeLine`da değil: bu daemon'ın
         yazımlarının hepsi para harcatmaz ve ayrım İŞLEVDEDİR, baytta değil.
           • sendResume  → "devam et" / --resume: ajanı yeniden ÇALIŞTIRIR = HARCAR
           • selectOption→ limit prompt'unda "1. bekle": iş DURDURUR = harcamaz
           • probePane   → tek ESC (RES-05): jeton üretmez
         İlk yazımda (writeLine) frenlemek `selectOption`ı da kapatıyordu; ölçüldü
         (bu dosyanın "SIFIR-JETONLU yoklama" testi KIRMIZI yandı) → fren, TUI'yi
         limit prompt'unda asılı bırakacaktı. Bir freni yanlış katmana koymak,
         durdurması gerekeni değil YARDIM EDENİ durdurur.
         Kapı verilmemişse (testler, eski çağıranlar) davranış BUGÜNKÜ hâlidir. */
      if (typeof budgetGate === 'function') {
        let verdict = null;
        try {
          verdict = budgetGate(entry && entry.paneRef);
        } catch {
          verdict = null; // kapı patladıysa DURDURMA (ölçemediğimiz şey için fren yok)
        }
        if (verdict && verdict.allow === false) {
          // 🔴 Sessiz düşürme yok: log + olay (renderer rozet/balon yolu) + kuyruk
          // kaydı DURUR (silinmez) → bütçe açılınca aynı iş yeniden denenir.
          log(`[resume] bütçe duraklattı — otomatik devam YAZILMADI paneRef=${entry && entry.paneRef} sebep=${verdict.reason || 'budget-paused'}`);
          emit('budget-paused', entry, verdict.reason || 'budget-paused');
          return { ok: false, command: null, mode: 'budget-paused' };
        }
      }
      const liveness = opts.liveness || 'shell';
      if (liveness === 'live') {
        const text = resumeTmux.buildContinueText();
        const ok = writeLine(entry.paneRef, text);
        if (ok) emit('continue', entry, 'limit sonrası "devam et" gönderildi');
        return { ok, command: text, mode: 'continue' };
      }
      const alreadyLive = findLivePaneByAgent(entry.agentId);
      if (alreadyLive) {
        resumeQueue.updateEntry(entry.id, { paneRef: alreadyLive.paneId }, homedir);
        const text = resumeTmux.buildContinueText();
        const ok = writeLine(alreadyLive.paneId, text);
        if (ok) emit('continue', { ...entry, paneRef: alreadyLive.paneId }, 'ajan yeni pane\'de canlı — oraya "devam et" gönderildi');
        return { ok, command: text, mode: 'continue' };
      }
      if (!respawnPane) return { ok: false, command: null, mode: 'resume' };
      let res = null;
      try {
        res = respawnPane(entry);
      } catch { res = null; }
      if (!res || !res.paneId) return { ok: false, command: null, mode: 'resume' };
      // Point the entry at the NEW pane so verify() captures the right buffer.
      // HATA-12-B — ajanın motoru pane düştükten SONRA değiştiyse pane YENİ motorla
      // ve TEMİZ açıldı (`--resume` kullanılmadı). İki sonucu var ve ikisi de
      // ÖLÇÜLDÜ (e2e PART 3):
      //   1) KAYIT BAYATLAR — kuyruktaki `engine` hâlâ eski motoru söylerse
      //      `verify()` YANLIŞ motorun TUI işaretlerini arar ve çalışan bir pane'i
      //      "devam doğrulanamadı" diye başarısız sayar (ölçüldü: ilk koşuda tam
      //      bu oldu). Bu yüzden kayıt yeni motora çevrilir, oturum kimliği düşer.
      //   2) BİLDİRİM YANILTIR — "--resume (engine=claude)" yazan satır kullanıcıya
      //      OLMAYAN bir şeyi rapor eder (HATA-12 §C dersi).
      const sw = res.engineSwitched;
      resumeQueue.updateEntry(
        entry.id,
        sw ? { paneRef: res.paneId, engine: sw.to, sessionId: null } : { paneRef: res.paneId },
        homedir,
      );
      const text = sw
        ? `motor değişti (${sw.from}→${sw.to}) — TEMİZ yeniden açıldı (--resume kullanılmadı)`
        : `--resume ${entry.sessionId || '?'} ile yeniden açıldı`;
      emit('respawn', { ...entry, paneRef: res.paneId, engine: sw ? sw.to : entry.engine }, text);
      return {
        ok: true,
        command: sw ? `respawn ${sw.to} (motor değişti, temiz)` : `respawn --resume ${entry.sessionId || '?'}`,
        mode: 'resume',
        engineSwitched: sw || null,
        // Bildirim YENİ pane'i söylesin: kayıt zaten buraya çevrildi, metin de öyle
        // olmalı (eski paneRef'i yazan satır kullanıcıyı ölü bir pane'e bakmaya yollar).
        paneRef: res.paneId,
      };
    },
  };
  if (now) io.now = now;

  // ───────────────────────────────────────────────────────────────────────────
  // ADP-938 — LİMİTTE OTOMATİK HESAP GEÇİŞİ (ADR Faz 3).
  //
  // Geçiş bir RE-SPAWN'dır (ADR §6.3: canlı süreç hesap değiştiremez, env başlangıçta
  // okunur). Sıra ZORUNLU:
  //   1. limitli pane KAPATILIR — "bir ajan = bir pane" (ADP-761) kuralı yüzünden
  //      spawnPty aynı agentId için ikinci pane'i zaten reddederdi
  //   2. AYNI oturum id'siyle, HEDEF profilin env'iyle yeniden açılır (`--resume`)
  //      → konuşma kaybolmaz (transkript profiller arası PAYLAŞIMLI, ADR §5-A)
  //   3. kural yeniden enjekte edilir — bunu agentRunner'ın resume yolu ZATEN yapıyor
  //      (ADP-276 `resumeMemoryPrompt`); `--append-system-prompt` per-launch olduğu
  //      için resume onu geri getirmez. KİMLİK bilerek TEKRAR ENJEKTE EDİLMEZ:
  //      restore edilen konuşma onu zaten taşır ve tekrarı ADP-192 invariant'ını
  //      bozar (ölçüldü: ajan kendini yeniden tanıtıyor).
  // ───────────────────────────────────────────────────────────────────────────
  const autoSwitch =
    engineAccounts && typeof engineAccounts.enabled === 'function' && respawnPane
      ? new engineSwitch.AutoAccountSwitcher({
          // 🪤 profil deposunun home'u kuyruk kökünden FARKLIDIR (main: $HOME vs
          // ~/.crewpane) — verilmezse defter yetim kalır, o yüzden açıkça istenir.
          home: engineAccounts.home || homedir,
          enabled: engineAccounts.enabled,
          listProfiles: engineAccounts.listProfiles,
          activeProfile: engineAccounts.activeProfile,
          setActive: engineAccounts.setActive,
          log,
          switchPane: (entry, profileId) => {
            // Hedef pane: kaydın işaret ettiği pane, yoksa ajanın canlı pane'i
            // (kullanıcı/restore yeniden açmış olabilir — R5 çift-spawn koruması).
            const live = getPanes().get(entry.paneRef)
              ? { paneId: entry.paneRef }
              : findLivePaneByAgent(entry.agentId);
            if (live && live.paneId && typeof closePane === 'function') {
              try {
                closePane(live.paneId);
              } catch {
                return { ok: false }; // pane kapanmadıysa yeni pane zaten açılamaz
              }
            }
            let res = null;
            try {
              res = respawnPane(entry, { engineProfileId: profileId });
            } catch {
              res = null;
            }
            if (!res || !res.paneId) return { ok: false };
            // Eski pane'e ait kayıt ARTIK GEÇERSİZ: ölü bir paneRef'e resume
            // göndermek ADP-089'un olay sınıfıdır.
            for (const e of resumeQueue.activeEntries(homedir)) {
              if (e.runtime !== 'pty' || e.agentId !== entry.agentId) continue;
              core.scheduler.cancel(e.id);
              core.scheduler.cancel(e.id + core._verifySuffix);
              resumeQueue.removeEntry(e.id, homedir);
            }
            emit('switch', { ...entry, paneRef: res.paneId }, `hesap değişti → ${profileId}`);
            return { ok: true, paneId: res.paneId };
          },
        })
      : null;

  // LIMIT-RESUME-02 — pane BAŞINA "motor kendi devam eder mi?" kararı. Sürüm önce
  // pane'in transcript'inden (o pane'in ikilisi), yoksa makinenin ikilisinden okunur;
  // ikisi de yoksa (ya da codex) → bugünkü yol. Sonuç pane+oturum başına önbelleklenir;
  // transcript henüz yazılmamışsa VERSION_RETRY_MS sonra yeniden bakılır.
  const versionCache = new Map(); // paneRef → {sessionId, version, at}
  function paneClaudeVersion(id) {
    const pane = getPanes().get(id && id.paneRef);
    if (!pane) return null;
    const hit = versionCache.get(id.paneRef);
    const nowMs = io.now ? io.now() : Date.now();
    if (hit && hit.sessionId === (pane.sessionId || null) && (hit.version || nowMs - hit.at < VERSION_RETRY_MS)) {
      return hit.version;
    }
    let v = null;
    try {
      v = paneVersion(pane, homedir) || null;
    } catch {
      v = null;
    }
    if (!v && typeof claudeVersion === 'function') {
      try {
        v = claudeVersion() || null;
      } catch {
        v = null;
      }
    }
    versionCache.set(id.paneRef, { sessionId: pane.sessionId || null, version: v, at: nowMs });
    return v;
  }
  const nativeContinue = limitResume02
    ? (id) => {
        if (!id || (id.engine || 'claude') !== 'claude') return false;
        const pane = getPanes().get(id.paneRef);
        if (!pane || pane.command !== 'claude') return false;
        const v = paneClaudeVersion(id);
        return !!v && versionAtLeast(v, NATIVE_CONTINUE_MIN_VERSION);
      }
    : undefined;

  const core = new ResumeDaemonCore({
    nativeContinue, // LIMIT-RESUME-02
    autoSwitch,
    homedir,
    notifyLog,
    dryRun,
    verifyWindowMs,
    resetBufferMs,
    verifyRetryDelaysMs,
    verifyMaxAttempts,
    probeSettleMs,
    probeRetryMs,
    probeMaxUnknown,
    scheduler,
    io,
    // RES-07 §2 — çekirdeğin ürettiği `schedule`/`probe`/`retry`/`resumed` olayları da
    // renderer'a AYNI köprüden gider (bugün yalnız select/continue/respawn/switch/fail
    // gidiyordu, yani bekleyişin kendisi görünmezdi).
    onEvent: (evt) => {
      if (!onEvent) return;
      try {
        onEvent({ ...evt, paneId: evt.paneId || null, agentId: evt.agentId || null });
      } catch { /* renderer hook is best-effort */ }
    },
    // RES-08 — yapılandırılmış olay günlüğü. Enjekte edilirse o kullanılır (testler),
    // `telemetry:false` ile kapatılabilir, aksi hâlde hesap kapsamlı varsayılan dosya.
    telemetry:
      telemetry === false
        ? null
        : typeof telemetry === 'function'
          ? telemetry
          : resumeTelemetry.createWriter({ homedir }),
    // ADP-428 — terminal failure must be VISIBLE: the emit reaches main's onEvent,
    // which toasts the renderer; the FAIL line is also appended to the notify log.
    // (ADP-844 — there is no off-screen messaging arm; the mobile app is the only one.)
    onFail: (entry, reason) => {
      emit('fail', entry, `limit sonrası devam ettirilemedi: ${reason}`);
      log(`pty-resume FAIL agent=${entry.agentId ?? '-'} pane=${entry.paneRef ?? '-'}: ${reason}`);
    },
  });

  // -------------------------------------------------------------------------
  // Boot remap (spec §3.4): an entry left over from the previous app run names a
  // DEAD paneId. restoreLivePanes ran FIRST, so if that agent is live again its
  // pane is in the Map under a NEW id → remap. No live pane → the record is
  // dropped (restore already `--resume`d the session, or the pane was closed on
  // purpose) — never fire blind at a stale paneRef (ADP-089 incident class).
  // -------------------------------------------------------------------------
  for (const entry of resumeQueue.activeEntries(homedir).filter((e) => e.runtime === 'pty')) {
    const live = findLivePaneByAgent(entry.agentId);
    if (live) {
      if (live.paneId !== entry.paneRef) {
        resumeQueue.updateEntry(entry.id, { paneRef: live.paneId }, homedir);
        log(`pty-resume boot remap: agent=${entry.agentId} paneRef ${entry.paneRef} → ${live.paneId}`);
      }
    } else {
      resumeQueue.removeEntry(entry.id, homedir);
      if (notifyLog) {
        resumeNotify.notify(
          notifyLog,
          'resume',
          entry.taskId || entry.agentId || entry.paneRef,
          `boot: pty kaydı düşüldü (canlı pane yok — restore --resume ile açtı ya da pane kapatıldı)`,
          io.now ? io.now() : Date.now(),
        );
      }
      log(`pty-resume boot: dropped stale entry agent=${entry.agentId} paneRef=${entry.paneRef}`);
    }
  }
  // Re-arm ONLY this runtime's records (the tmux script re-arms the complement).
  const rearmed = core.rescheduleOnBoot((e) => e.runtime === 'pty');
  if (rearmed) log(`pty-resume reschedule-on-boot: ${rearmed} entry re-armed`);

  // -------------------------------------------------------------------------
  // Poll loop — observe every AGENT pane's normalized tail through the core's
  // detect → schedule → fire → verify → backoff machine.
  // -------------------------------------------------------------------------
  let pollCount = 0;
  const lastVerdicts = new Map();
  function pollOnce() {
    pollCount++;
    const verdicts = [];
    const seen = new Set();
    let changed = false;
    for (const [paneId, e] of getPanes()) {
      if (!isAgentPane(e)) continue;
      seen.add(paneId);
      const text = ptyTail(e.buffer);
      // ADP-938 — ONE pane must never blind the tick. The Windows P0 chain ended in a
      // RangeError thrown out of observe() (a ConPTY-truncated "(Europe/Istan)" zone →
      // Intl throws, MEASURED), which killed the whole loop: every pane AFTER it went
      // unobserved that tick. The throw itself is fixed in limitDetect; this keeps a
      // future one local and VISIBLE (verdict says err, so the heartbeat shows it).
      let result = null;
      try {
        result = core.observe(text, {
          runtime: 'pty',
          paneRef: paneId,
          agentId: e.agentId,
          engine: e.command,
          sessionId: e.sessionId || null,
          cwd: e.cwd || null,
          engineProfileId: typeof e.engineProfileId === 'string' ? e.engineProfileId : null,
        });
      } catch (err) {
        log(`pty-resume observe HATA pane=${paneId}: ${(err && err.message) || err}`);
        verdicts.push(`${paneId}=ERR`);
        if (lastVerdicts.get(paneId) !== `${paneId}=ERR`) {
          changed = true;
          lastVerdicts.set(paneId, `${paneId}=ERR`);
        }
        continue;
      }
      const v = verdictFor(paneId, text, result);
      verdicts.push(v);
      if (lastVerdicts.get(paneId) !== v) {
        changed = true;
        lastVerdicts.set(paneId, v);
      }
    }
    for (const paneId of lastVerdicts.keys()) {
      if (!seen.has(paneId)) {
        lastVerdicts.delete(paneId);
        changed = true;
      }
    }
    if (changed || pollCount % HEARTBEAT_EVERY === 1) {
      log(`pty-resume poll ${verdicts.length ? verdicts.join(' ') : '(no agent panes)'}`);
    }
  }

  const interval = timers.setInterval(pollOnce, pollMs);
  if (interval && typeof interval.unref === 'function') interval.unref();
  log(
    `pty-resume daemon MODE=${dryRun ? 'DRY-RUN (no pane writes)' : 'LIVE'} — ` +
      `watching in-app agent panes every ${pollMs}ms → ${notifyLog || '(no notify log)'}` +
      ` · LIMIT-RESUME-02 ${limitResume02 ? `AÇIK (claude ≥ ${NATIVE_CONTINUE_MIN_VERSION} native-continue, ESC yoklaması yok)` : 'KAPALI (kontrol kolu: ESC + kör gönderim)'}`,
  );

  return {
    pollOnce,
    core,
    /**
     * A pane the user DELIBERATELY closed (pty:kill / worker recycling) must not
     * be resumed later — parity with ADP-192's forget-on-close. Drops this
     * pane's active pty entries and cancels their timers. Returns the count.
     */
    forgetPane(paneId) {
      let n = 0;
      for (const e of resumeQueue.activeEntries(homedir)) {
        if (e.runtime !== 'pty' || e.paneRef !== paneId) continue;
        core.scheduler.cancel(e.id);
        core.scheduler.cancel(e.id + core._verifySuffix);
        resumeQueue.removeEntry(e.id, homedir);
        n++;
      }
      if (n) log(`pty-resume forget: pane ${paneId} kapatıldı → ${n} kayıt düşüldü`);
      return n;
    },
    stop() {
      timers.clearInterval(interval);
      core.stop();
      log('pty-resume daemon stopped');
    },
  };
}

module.exports = {
  DEFAULT_POLL_MS,
  HEARTBEAT_EVERY,
  SUBMIT_GAP_MS,
  PROBE_KEY, // RES-05 — sıfır-token yoklama tuşu (ESC)
  AGENT_COMMANDS,
  verdictFor, // RES-07 — SUSPECT ayrımının birim kanıtı için
  NATIVE_CONTINUE_MIN_VERSION, // LIMIT-RESUME-02
  versionAtLeast, // LIMIT-RESUME-02
  transcriptVersion, // LIMIT-RESUME-02

  MAX_FRAME_LINES, // RES-03
  ptyTail,
  dedupeFrames, // RES-03 — exported for the unit proof
  isAgentPane,
  startPtyResumeDaemon,
};
