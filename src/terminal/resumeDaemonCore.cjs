// CrewPane — ADP-089 (ADR-007 v2) resume daemon orchestration core.
//
// Wires the primitives into the detect → (prompt-stop) → schedule → resume →
// verify → backoff state machine, with EVERY external effect injected so it runs
// under a fake clock + fake tmux in unit tests AND under real tmux + real claude
// in the e2e (resumeDaemonCore.test.cjs / e2e/resume-e2e.spec.cjs).
//
//   detect  : limitDetect.detectLimitState  (ROBUST — tail-only, not-working,
//             standalone, anchored; the incident root-cause guard)
//   identity: resumePaneRegistry.lookupPane (authoritative engine/agent/session
//             per pane — no cross-pane session leak; ADP-089 req #4/#5)
//   store   : resumeQueue (captureLimit / updateEntry / removeEntry / activeEntries)
//   when    : resumeScheduler.ResumeScheduler (setTimeout + backoff + reschedule)
//   how     : resumeTmux.selectOption / sendResume (continue-vs-resume) / capture
//   tell    : resumeNotify (SESSİZ — RESUME/FAIL/DRYRUN line, no approval)
//
// ADP-089 SAFETY: `dryRun` (default the DAEMON turns ON) makes fire/select LOG
// what they WOULD do (DRYRUN: …) and touch NO pane — Optimus reviews those lines
// against real fixtures before flipping the daemon live. The unit suite drives the
// LIVE state machine (dryRun=false) so the control flow is asserted directly.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const limitDetect = require('./limitDetect.cjs');
const resumeQueue = require('./resumeQueue.cjs');
const resumeTmux = require('./resumeTmux.cjs');
const resumeNotify = require('./resumeNotify.cjs');
const resumePaneRegistry = require('./resumePaneRegistry.cjs');
const { ResumeScheduler, isExhausted } = require('./resumeScheduler.cjs');

// ADP-428: watch the pane 3min post-send (was 90s). The incident proved 90s is
// inside claude's own retry chatter; 3min gives the agent time to produce REAL
// assistant output (or re-print the limit) before we judge the attempt.
const DEFAULT_VERIFY_WINDOW_MS = 180_000;
// ADP-428 — a verify FAILURE (still limited / no assistant output) re-sends with
// this escalating wait chain; after VERIFY_MAX_ATTEMPTS total sends → failed +
// onFail (visible alert). Distinct from the pre-send backoff (1,2,4… ×8): here
// the send LANDED but did not take, so we wait longer and give up sooner+louder.
//
// RES-04 — 5m,15m ×3 → 2m,5m,15m,30m ×6. Two measured facts drove both numbers:
// a nudge that lands 60s after the reset can still be refused (stark, +62s), so
// the FIRST retry has to be short; and a retry is no longer a blind poke — every
// failure now carries the reset time the engine printed in its refusal, so the
// chain below is only the fallback for a refusal with no clock in it. A wider
// budget costs nothing when the attempts are aimed, and 3 was measured to be
// exhausted before a 5-hour window ever renews.
const VERIFY_RETRY_DELAYS_MS = Object.freeze([2 * 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000]);
const VERIFY_MAX_ATTEMPTS = 6;
// ADP-938 — early-fire guard (see _deferWhileLimited). While a pane still shows its
// limit and the reset instant is UNKNOWN we re-look this often instead of sending…
const DEFER_PROBE_MS = 5 * 60_000;
// …but never longer than this after detection: an unknown reset must not turn into a
// permanently parked agent. Past this, the send goes out and verify/retry judges it.
const UNKNOWN_MAX_DEFER_MS = 60 * 60_000;
// Hard ceiling on ANY unknown-reset deferral chain, measured from detection. Claude's
// session window is 5h; past 6h a still-limited screen is far likelier to be stale
// output than a live limit, so we stop holding the agent back.
const MAX_TOTAL_DEFER_MS = 6 * 60 * 60_000;
// ADP-947 — a printed wall clock that passed within this window means the reset
// ALREADY HAPPENED, not that it is due tomorrow (see _resetInstant). Same 6h as
// above and for the same reason: claude's session window is 5h, so a reset clock
// more than 6h behind us belongs to a screen we should no longer be waiting on.
const STALE_CLOCK_GRACE_MS = MAX_TOTAL_DEFER_MS;
// ADP-947 — poll-driven watchdog: how often an entry whose reset is already due may
// be re-fired from the poll loop when its own setTimeout never came due.
const WATCHDOG_MIN_GAP_MS = DEFER_PROBE_MS;

// ─── RES-05 — SIFIR-TOKEN ÖN-YOKLAMA ────────────────────────────────────────
// D8: doğrulama 180 sn sonra TEK ATIŞ ve öncesinde ucuz bir kontrol YOK. Yani her
// "acaba limit geçti mi?" sorusu bir PROMPT harcayarak soruluyor: gönderim limite
// çarpar, `attempts` artar, bütçe erir ve kullanıcı 5 pane'e elle "devam et" yazar.
//
// Yoklama, gönderimden ÖNCE TUI'yi SUBMIT ETMEDEN tazeler (yalnız ESC) ve tazelenen
// ekranda limit satırı/menüsü hâlâ duruyor mu diye bakar. Token harcamaz: pane'e
// hiçbir metin ve hiçbir CR yazılmaz (bkz. resumePtyDaemon `probePane`).
//
// İki fazlı, çünkü çekirdek SENKRON: faz 1 ESC'i yazar ve `PROBE_SETTLE_MS` sonrasına
// yeniden kurar; faz 2 tazelenmiş tamponu okur. Böylece sahte saat altında da aynen
// koşar (uyku/await yok).
const PROBE_SETTLE_MS = 1_500;
// Sonuçsuz (`unknown`) yoklama bu aralıkla TEKRARLANIR — yoklama bedava, gönderim değil.
const PROBE_RETRY_MS = 60_000;
// …ama sonsuza kadar değil. TUI hiç yanıt vermiyorsa (ESC'e boyama yapmayan bir
// adaptör, donmuş bir pane) yoklama HİÇBİR ZAMAN karar veremez; o hâlde ısrar etmek
// "park edilmiş ajan" sınıfını geri getirir — bu depo o sınıfı defalarca ölçtü. Üst
// üste bu kadar sonuçsuz yoklamadan sonra gönderim yapılır ve hükmü verify verir.
// (İkinci ve daha sert tavan MAX_TOTAL_DEFER_MS; hangisi önce dolarsa.)
const PROBE_MAX_UNKNOWN = 3;

// ─── LIMIT-RESUME-02 — MOTORUN OTOMATİK-DEVAMI ANA YOL, DAEMON YALNIZ NÖBETÇİ ───
// RESEARCH-ACCT-01 §4.3/§6.3: Claude Code ≥ 2.1.27x limitte KENDİ devam eder (saati
// sunucudan bilir). Bu daemon'ın üç yazımı da o mekanizmayı İPTAL EDİYORDU (ikiliden:
// ESC → `escape`, "devam et"+CR → `manual_submit`, menü tuşu → `dialog`), üstelik
// ESC çalışan ajanı kesiyordu (18.09 06:13:57, iki transcript `[Request interrupted
// by user]`). Native pane'de kayıt `mode:'native'`dir: zamanlayıcı KURULMAZ, fire()
// KOŞMAZ; poll yalnız (a) motorun kendi devam edip etmediğini ölçer ve (b) motor
// devam ETMEDİYSE tek bir dokunuşla uyandırır.
//
// Nöbetçi kuralı (hepsi birden): resetAt + SENTINEL_GRACE_MS geçti VE pane
// SENTINEL_QUIET_MS boyunca hiç çıktı üretmedi VE ekranda motorun "Enter bekliyorum /
// vazgeçtim" bandı (ya da yalnız bayat limit satırı) var → TEK Enter ya da TEK
// "devam et". Saat okunamadıysa: gönderim yok, FAIL yok, "bekliyor" satırı.
const SENTINEL_GRACE_MS = 10 * 60_000;
const SENTINEL_QUIET_MS = 10 * 60_000;
// Aynı kayıt için nöbetçi en fazla bu kadar dokunur (Enter + "devam et"); kör zincir yok.
const SENTINEL_MAX_NUDGES = 2;
// Dış-devam kanıtı için transcript ne sıklıkla okunur (stat ucuz, tail 256 KB değil).
const EXTERNAL_CHECK_MIN_GAP_MS = 30_000;

/**
 * Wall-clock HH:MM:SS for the notification log. Bare `toLocaleTimeString()` follows the
 * process locale, so the SAME reset printed as `05:50:00` on one machine and `5:50:00 AM`
 * on another — the log format drifted per-environment and the assertion on it was brittle.
 * Pin the locale + 24h so the daemon log is byte-identical everywhere.
 */
function formatClock(ms) {
  return new Date(ms).toLocaleTimeString('tr-TR', { hour12: false });
}

/**
 * LIMIT-RESUME-02 — bir reset anı 24 saatten uzaksa (haftalık limit) saat tek başına
 * yanıltır ("19:00" — hangi gün?); tarih de yazılır: "20.09 19:00".
 */
function formatWhen(ms, now) {
  if (Number.isFinite(now) && Math.abs(ms - now) > 24 * 60 * 60_000) {
    const d = new Date(ms);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${dd}.${mm} ${hh}:${mi}`;
  }
  return formatClock(ms);
}

// ADP-428 — how much of the transcript tail to scan for a post-send assistant line.
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

/** Flatten a transcript record's assistant content to plain text (tool/thinking blocks → ''). */
function assistantText(obj) {
  const c = obj && obj.message && obj.message.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c
    .map((part) => (part && part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .join('\n');
}

/**
 * RES-02 — every `"type":"assistant"` record in the transcript TAIL stamped after
 * `sinceMs`, oldest first, as `{ts, text, kind}`. `kind` is 'limit' when the text
 * is the engine's own limit announcement (the answer our nudge got, not output it
 * produced) and 'content' otherwise.
 *
 * WHY the text and not just a count (D1): `hasAssistantLineAfter` returned TRUE on
 * the real 972b4650 / 7bf61167 transcripts, and the one assistant line it found
 * was `"You've hit your session limit · resets 7:30am (Europe/Istanbul)"` — the
 * REFUSAL of the very nudge we had just sent. Counting it as output is what made
 * verify() declare success, delete the record, and leave the pane idle for hours.
 * A tool_use/thinking block flattens to '' and stays 'content': it is real work.
 */
function assistantLinesAfter(file, sinceMs) {
  const { size } = fs.statSync(file);
  const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
  const fd = fs.openSync(file, 'r');
  let tail;
  try {
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    tail = buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
  const out = [];
  for (const line of tail.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // the first line may be cut by the tail window
    }
    if (!obj || obj.type !== 'assistant') continue;
    const ts = Date.parse(obj.timestamp);
    // A line with no parseable timestamp counts (mtime already gated the file).
    if (Number.isFinite(ts) && ts <= sinceMs) continue;
    const text = assistantText(obj);
    out.push({
      ts: Number.isFinite(ts) ? ts : null,
      text,
      kind: limitDetect.looksLikeLimitText(text) ? 'limit' : 'content',
    });
  }
  return out;
}

/**
 * True when the transcript's TAIL contains an assistant line after `sinceMs`.
 * ADP-428 shape, kept for callers/tests that only need the boolean. Note this
 * ALONE is not success evidence any more — see assistantLinesAfter's `kind`.
 */
function hasAssistantLineAfter(file, sinceMs) {
  return assistantLinesAfter(file, sinceMs).length > 0;
}

/**
 * LIMIT-RESUME-02 §6.3/4 — did the transcript record a USER interrupt after `sinceMs`?
 * Claude Code writes `[Request interrupted by user]` as a user-role line when ESC
 * (ours or a human's) cuts a running request. A "resumed" verdict is only honest
 * without one: on 18.09 the daemon's own ESC produced this line and the re-prompt it
 * forced was then counted as success.
 */
function transcriptInterruptedAfter(file, sinceMs) {
  let tail;
  try {
    const { size } = fs.statSync(file);
    const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      tail = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
  for (const line of tail.split('\n')) {
    if (!line.includes('[Request interrupted by user')) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || obj.type !== 'user') continue;
    const ts = Date.parse(obj.timestamp);
    if (!Number.isFinite(ts) || ts > sinceMs) return true;
  }
  return false;
}

/**
 * RES-02 (D7) — cheap content signature of a pane capture, so verification can ask
 * "did anything happen since the send?" without keeping the whole buffer.
 */
function paneSignature(text) {
  const t = typeof text === 'string' ? text : '';
  return `${t.length}:${crypto.createHash('sha1').update(t).digest('hex').slice(0, 16)}`;
}

class ResumeDaemonCore {
  /**
   * @param {object} cfg
   * @param {string}   cfg.homedir         queue + registry + claude-projects root (tmp in tests)
   * @param {string}   cfg.notifyLog       docs/.agent-notifications path
   * @param {boolean}  [cfg.dryRun]        true → observe + LOG only, never touch a pane (ADP-089)
   * @param {number}   [cfg.verifyWindowMs]
   * @param {number}   [cfg.resetBufferMs]      ADP-428 — resetAt safety margin (default 90s)
   * @param {number[]} [cfg.verifyRetryDelaysMs] ADP-428 — waits between re-sends (default 5m,15m)
   * @param {number}   [cfg.verifyMaxAttempts]  ADP-428 — total send budget before FAIL (default 3)
   * @param {Function} [cfg.onFail]             ADP-428 — (entry, reason) when giving up → visible alert
   * @param {object}   [cfg.scheduler]     a ResumeScheduler (inject fake-clock one in tests)
   * @param {object}   [cfg.io]            { capturePane, sendResume, selectOption, resolveSessionId,
   *                                         lookupPane, activityEvidence, probePane, now } — each
   *                                         defaults to the real impl (probePane: none → RES-05 off)
   * @param {number}   [cfg.probeSettleMs]     RES-05 — ESC ile gönderim-öncesi yoklama arası
   * @param {number}   [cfg.probeRetryMs]      RES-05 — sonuçsuz yoklamanın tekrar aralığı
   * @param {number}   [cfg.probeMaxUnknown]   RES-05 — üst üste kaç sonuçsuz yoklamadan sonra kör gönderim
   * @param {Function} [cfg.onEvent]           RES-07 — ({kind, paneId, agentId, detail, …}) renderer köprüsü
   * @param {Function} [cfg.telemetry]         RES-08 — (record) => void JSONL yazıcısı
   */
  constructor(cfg = {}) {
    this.homedir = cfg.homedir || undefined;
    this.notifyLog = cfg.notifyLog || null;
    this.dryRun = cfg.dryRun === true;
    this.verifyWindowMs = Number.isFinite(cfg.verifyWindowMs)
      ? cfg.verifyWindowMs
      : DEFAULT_VERIFY_WINDOW_MS;
    this.verifyRetryDelaysMs =
      Array.isArray(cfg.verifyRetryDelaysMs) && cfg.verifyRetryDelaysMs.length
        ? cfg.verifyRetryDelaysMs.filter((d) => Number.isFinite(d) && d >= 0)
        : VERIFY_RETRY_DELAYS_MS;
    this.verifyMaxAttempts =
      Number.isInteger(cfg.verifyMaxAttempts) && cfg.verifyMaxAttempts >= 1
        ? cfg.verifyMaxAttempts
        : VERIFY_MAX_ATTEMPTS;
    this.onFail = typeof cfg.onFail === 'function' ? cfg.onFail : null;
    // ADP-938 (ADR Faz 3) — LİMİTTE OTOMATİK HESAP GEÇİŞİ. Enjekte edilmezse
    // (bugünkü tmux daemon'ı, testlerin çoğu) bu çekirdek bit-bit eskisi gibi
    // davranır: karar da, ayar da, defter de engineSwitch.cjs'te.
    this.autoSwitch = cfg.autoSwitch && typeof cfg.autoSwitch.trySwitch === 'function' ? cfg.autoSwitch : null;
    this.scheduler =
      cfg.scheduler || new ResumeScheduler(undefined, { resetBufferMs: cfg.resetBufferMs });
    const io = cfg.io || {};
    this.capturePane = io.capturePane || ((ref) => resumeTmux.capturePane(ref));
    // ADP-180 — forward opts (so fire() can pass the resolved {liveness}).
    this.sendResume = io.sendResume || ((entry, opts) => resumeTmux.sendResume(entry, opts));
    this.selectOption = io.selectOption || ((ref, n) => resumeTmux.selectOption(ref, n));
    // ADP-180 — liveness decider (continue-vs-resume). CONTENT-first (the captured
    // pane showing the engine TUI), with the process-name check as fallback — robust
    // to claude renaming its process to its version (the proven prod root-cause).
    // Only 'live' (engine TUI still attached) takes the no-session "devam et" nudge;
    // 'shell'/'other' keep the uuid `--resume` path (engine exited → relaunch).
    this.liveness =
      io.liveness || ((entry, text) => resumeTmux.paneLiveness(entry && entry.paneRef, text));
    this.resolveSessionId =
      io.resolveSessionId ||
      ((entry, now) => resumeTmux.resolveSessionIdFromJsonl(entry.cwd, this.homedir, { now }));
    this.lookupPane = io.lookupPane || ((ref) => resumePaneRegistry.lookupPane(ref, this.homedir));
    // ADP-428 — post-send SUCCESS evidence (pozitif kanıt): did the assistant
    // actually produce output after our send? Injectable for tests/adapters.
    this.activityEvidence =
      io.activityEvidence || ((entry, sinceMs, text) => this._activityEvidence(entry, sinceMs, text));
    this.now = io.now || (() => Date.now());
    /** verify timers are keyed off the entry id with this suffix (separate from the fire timer). */
    this._verifySuffix = ':verify';
    /** ADP-098: paneRef → last handled prompt signature, so a still-on-screen
     * Format-A menu is selected ONCE, not re-pressed every poll. Cleared when the
     * pane no longer shows that prompt. */
    this._promptSelected = new Map();
    /** ADP-947: entryId → last poll-driven watchdog fire (throttle, see _watchdogDue). */
    this._watchdog = new Map();

    // ── RES-05 — sıfır-token ön-yoklama ───────────────────────────────────
    /**
     * `(paneRef) => boolean` — pane'in TUI'sini SUBMIT ETMEDEN tazele (ESC). Enjekte
     * EDİLMEZSE yoklama tamamen kapalıdır ve fire() bugünküyle bit-bit aynı davranır
     * (tmux adaptörü, mevcut testler). Bir yetenek, ön koşul değil.
     */
    this.probePane = typeof io.probePane === 'function' ? io.probePane : null;
    this.probeSettleMs = Number.isFinite(cfg.probeSettleMs) ? cfg.probeSettleMs : PROBE_SETTLE_MS;
    this.probeRetryMs = Number.isFinite(cfg.probeRetryMs) ? cfg.probeRetryMs : PROBE_RETRY_MS;
    this.probeMaxUnknown =
      Number.isInteger(cfg.probeMaxUnknown) && cfg.probeMaxUnknown >= 0
        ? cfg.probeMaxUnknown
        : PROBE_MAX_UNKNOWN;
    /** @type {Map<string,{at:number, sig:string, pending:boolean, unknowns:number}>} */
    this._probe = new Map();

    // ── LIMIT-RESUME-02 — native-continue (nöbetçi) modu ─────────────────────
    /**
     * `(id) => boolean` — bu pane'in motoru limitte KENDİ devam eder mi (claude ≥
     * 2.1.270). Enjekte EDİLMEZSE mod tamamen kapalıdır ve çekirdek bugünküyle bit-bit
     * aynı davranır (K13 kontrol kolu, mevcut testler). Karar pane BAŞINA verilir:
     * sürüm pane'in transcript'inden okunur (adaptör), makinenin PATH'inden değil.
     */
    this.nativeContinue = typeof cfg.nativeContinue === 'function' ? cfg.nativeContinue : null;
    /** `(paneRef) => boolean` — nöbetçinin TEK Enter'ı (stale fazı). Yoksa "devam et" yolu. */
    this.pressEnter = typeof io.pressEnter === 'function' ? io.pressEnter : null;
    this.sentinelGraceMs = Number.isFinite(cfg.sentinelGraceMs) ? cfg.sentinelGraceMs : SENTINEL_GRACE_MS;
    this.sentinelQuietMs = Number.isFinite(cfg.sentinelQuietMs) ? cfg.sentinelQuietMs : SENTINEL_QUIET_MS;
    /** paneRef → {sig, changedAt}: "pane son N dk çıktı üretti mi?" ölçümü. */
    this._pane = new Map();
    /** entryId → son transcript bakışı (stat ucuz ama her 5 sn değil). */
    this._external = new Map();
    /** paneRef → son bildirilen native durum imzası (aynı satırı her poll yazma). */
    this._nativeSaid = new Map();
    /** agentId'ler: aktif native kaydı olanlar — temiz ekranda kuyruk dosyası ancak
     * bunlar için okunur (her 5 sn her pane için JSON okumamak). Yeniden başlatmada
     * kalıcı kuyruktan doldurulur. */
    this._nativeWatch = new Set();
    if (this.nativeContinue) {
      try {
        for (const e of resumeQueue.activeEntries(this.homedir)) if (e.mode === 'native' && e.agentId) this._nativeWatch.add(e.agentId);
      } catch { /* kuyruk yoksa boş */ }
    }

    // ── RES-07 — GÖRÜNÜRLÜK: yaşam döngüsü olayları renderer'a ────────────
    // Bugün renderer yalnız `select|continue|respawn|switch|fail` görüyor; yani
    // BEKLEYİŞİN kendisi (zamanlama, yoklama, yeniden deneme) hiç görünmüyor ve
    // kullanıcı "sistem ne yapıyor?" sorusunu ancak elle 5 pane'e yazarak cevaplıyor.
    this.onEvent = typeof cfg.onEvent === 'function' ? cfg.onEvent : null;
    // ── RES-08 — telemetri yazıcısı `(record) => void` (enjekte edilmezse kapalı).
    this.telemetry = typeof cfg.telemetry === 'function' ? cfg.telemetry : null;
  }

  /**
   * RES-07 — bir yaşam döngüsü olayını renderer'a köprüle. `extra` rozetin ihtiyacı
   * olan VERİYİ taşır (metni değil): `nextAttemptAt`, `resetAt`, `resetKnown`,
   * `attempt`, `verdict`. Hook best-effort — bir dinleyici hatası daemon'ı kesmez.
   */
  _emit(kind, entry, detail, extra = {}) {
    if (!this.onEvent) return;
    try {
      this.onEvent({
        kind,
        paneId: (entry && entry.paneRef) || null,
        agentId: (entry && entry.agentId) || null,
        detail: detail || null,
        ...extra,
      });
    } catch {
      /* renderer köprüsü best-effort */
    }
  }

  /** RES-08 — tek bir yapılandırılmış olay satırı (bkz. resumeTelemetry.cjs). */
  _track(event, entry, extra = {}) {
    if (!this.telemetry) return;
    try {
      this.telemetry({
        ts: this.now(),
        agentId: (entry && entry.agentId) || null,
        paneRef: (entry && entry.paneRef) || null,
        runtime: (entry && entry.runtime) || null,
        event,
        resetAt: entry && Number.isFinite(entry.resetAt) ? entry.resetAt : null,
        resetAtSource: (entry && entry.resetSource) || 'unknown',
        attempt: entry && Number.isInteger(entry.attempts) ? entry.attempts : null,
        ...extra,
      });
    } catch {
      /* telemetri bir iyileştirmedir, ön koşul değil */
    }
  }

  /**
   * RES-07 — rozetin okuyacağı durum: bir sonraki denemenin ANI ve reset saatinin
   * OKUNUP okunmadığı. `verdict` RES-07 §3'ün üçüncü hâli: `SUSPECT` = limit şüphesi
   * var ama saat okunamadı (bugün bu iki durum tek "PLAIN" verdict'i içinde eriyordu).
   */
  _statusOf(entry, nextAttemptAt) {
    const resetKnown = !!(entry && Number.isFinite(entry.resetAt));
    return {
      nextAttemptAt: Number.isFinite(nextAttemptAt) ? nextAttemptAt : null,
      resetAt: resetKnown ? entry.resetAt : null,
      resetKnown,
      resetSource: (entry && entry.resetSource) || 'unknown',
      attempt: entry && Number.isInteger(entry.attempts) ? entry.attempts : 0,
      verdict: resetKnown ? 'LIMITED' : 'SUSPECT',
    };
  }

  /**
   * ADP-947 — the reset instant to ARM, with the roll-forward trap closed.
   *
   * `nextEpochForClock` walks a wall clock that already passed to TOMORROW. claude
   * LEAVES its limit line on the screen after the window renews, so from the printed
   * minute onward every poll re-reads that same line and resolves it to +24h: the
   * agent is parked a full day right after its limit came back — Eren's second
   * report, "13:00'de yenilendi FAKAT otomatik başlamıyo" (MEASURED on the untouched
   * daemon: "resets 1pm" seen at 13:05 armed a 1436-minute timer).
   *
   * A clock that passed within STALE_CLOCK_GRACE_MS therefore means the reset
   * HAPPENED. The asymmetry is deliberate: being wrong this way costs ONE send that
   * verify/retry immediately judges; being wrong the other way costs a silent day.
   *
   * RES-04 (D3) — but that conclusion is NOT a schedule, and it used to be returned
   * as `now` and stored in `resetAt`. Every 5-second poll then wrote a fresh `now`,
   * the queue reported `changed`, and the daemon cancelled its timer and re-armed it
   * 90 seconds out — forever. MEASURED on the untouched daemon: 540 re-arms and ZERO
   * sends across the 50 minutes around a reset, with the watchdog and the 6-hour
   * ceiling both disarmed by the same moving timestamps. So the two facts are now
   * returned separately: `at` is the instant we were SHOWN (null when it is behind
   * us), `passed` is the conclusion. Only `at` reaches `resetAt`.
   *
   * RES-08 — `source` de döner (`clock`/`clock-local`/`rel`/`unknown`), çünkü
   * telemetrinin ölçmesi istenen ilk şey "saati KAÇ kez okuyabildik" (RES-03 hedefi
   * ≥ %90; ölçülen taban %0). Kaynağı çağrı yerinde yeniden türetmek, aynı bilgiyi
   * iki yerde hesaplamak olurdu.
   *
   * @returns {{at:number|null, passed:boolean, source:string}}
   */
  _resetSignal(signal, now) {
    const r = limitDetect.resolveResetAt(signal, now);
    const passed =
      !!r.rolledOver && Number.isFinite(r.clockAt) && now - r.clockAt <= STALE_CLOCK_GRACE_MS;
    const at = passed ? null : r.at;
    let source = 'unknown';
    if (Number.isFinite(at)) {
      if (r.source === 'rel') source = 'rel';
      else if (r.source === 'abs') source = 'abs'; // CDX-LIMIT-02 — codex mutlak tarihi
      else if (r.source === 'date') source = 'date'; // LIMIT-RESUME-02 — yılsız ay-gün (haftalık limit)
      else if (r.source === 'clock-local-fallback') source = 'clock-local';
      else if (r.source === 'clock') source = 'clock';
      // LIMIT-RESUME-02 — saati CLI'ın KENDİ bandı söylediyse kaynak odur (K8).
      if (r.via === 'cli-band') source = 'cli-band';
    }
    return { at, passed, source };
  }

  /**
   * ADP-947 — never let a NOISIER later read ERASE a reset instant already resolved.
   *
   * `captureLimit` overwrites resetAt on every tick, and a ConPTY-mangled repaint
   * parses the limit line but loses the clock → resetAt drops back to null → the
   * queue `changed` flag flips → the entry is re-armed on the 5-minute UNKNOWN
   * fallback and we type into the pane long before the real reset. MEASURED on the
   * untouched daemon: a known 01:20 reset (27.5-min timer) became `null` with a
   * 5-minute timer ONE poll later — exactly the 00:54-vs-1:20am early resume.
   * Downgrades to null are refused; any freshly PARSED instant still wins.
   */
  _carryResetAt(id, resetAt) {
    if (Number.isFinite(resetAt)) return resetAt;
    if (!id || !id.agentId) return resetAt;
    const now = this.now();
    const prev = resumeQueue
      .activeEntries(this.homedir)
      .find((e) => e.agentId === id.agentId && Number.isFinite(e.resetAt));
    return prev && prev.resetAt > now ? prev.resetAt : resetAt;
  }

  /**
   * ADP-947 — WATCHDOG: the 5-second poll is the SECOND trigger, so a timer that
   * never comes due can no longer swallow a resume.
   *
   * A single long `setTimeout` is not a reliable alarm on a laptop: it is armed
   * against a monotonic tick that does not advance while the box is asleep, so a
   * timer set at 02:00 for a 13:00 reset simply never fires on a machine that slept
   * in between — the pane sits there, the poll sees it every 5s, and nothing
   * happens ("13:00'de yenilendi FAKAT otomatik başlamıyo"). The poll interval, by
   * contrast, re-arms from `now` on every tick and so resumes within `pollMs` of
   * wake. Whenever the poll re-observes a captured limit whose reset instant is
   * already past and whose entry is still merely `scheduled`, we fire it ourselves.
   *
   * Throttled to WATCHDOG_MIN_GAP_MS so a pane that keeps deferring (see
   * _deferWhileLimited) cannot turn this into a 5-second re-fire loop.
   */
  _watchdogDue(entry, now) {
    if (!entry || entry.status !== 'scheduled') return false;
    if (!Number.isFinite(entry.resetAt)) return false;
    const buffer = Number.isFinite(this.scheduler.resetBufferMs) ? this.scheduler.resetBufferMs : 0;
    if (now < entry.resetAt + buffer) return false;
    const last = this._watchdog.get(entry.id);
    if (Number.isFinite(last) && now - last < WATCHDOG_MIN_GAP_MS) return false;
    this._watchdog.set(entry.id, now);
    return true;
  }

  /**
   * ADP-947 — fire this agent's captured limit FROM THE POLL when its reset instant
   * is already past (see _watchdogDue for why the poll, not a long setTimeout, is the
   * reliable alarm). Returns true when a fire was armed.
   */
  _watchdogFire(id) {
    if (!id || !id.agentId) return false;
    const now = this.now();
    const entry = resumeQueue.activeEntries(this.homedir).find((e) => e.agentId === id.agentId);
    if (!entry || !this._watchdogDue(entry, now)) return false;
    this.scheduler.scheduleAt(entry.id, 0, () => this.fire(entry));
    this._notify(
      'resume',
      entry,
      `reset saati (${formatClock(entry.resetAt)}) geçmiş ama tetik gelmemiş ` +
        `(pane ${entry.paneRef}) — devam yoklamadan tetiklendi`,
    );
    return true;
  }

  _notify(kind, entry, detail) {
    if (!this.notifyLog) return;
    const who = (entry && (entry.taskId || entry.agentId || entry.paneRef)) || '?';
    resumeNotify.notify(this.notifyLog, kind, who, detail, this.now());
  }

  /** Latest persisted copy of an entry (attempts/status may have moved); falls back to the snapshot. */
  _reload(entry) {
    const all = resumeQueue.loadQueue(this.homedir).entries;
    return all.find((e) => e.id === entry.id) || entry;
  }

  /**
   * Merge a pane's authoritative registry identity over the raw poll `meta`
   * (ADP-089 req #4/#5): registry wins for engine/agentId/sessionId/cwd so the
   * daemon never guesses a hardcoded engine or a cross-pane session.
   */
  _identity(meta) {
    const info = this.lookupPane(meta.paneRef) || null;
    return {
      ...meta,
      engine: (info && info.engine) || meta.engine || 'claude',
      agentId: (info && info.agentId) || meta.agentId || meta.paneRef || null,
      sessionId: (info && info.sessionId) || meta.sessionId || null,
      cwd: (info && info.cwd) || meta.cwd || null,
      // ACCT-FIX-01 — pane'in hesap profili (engineSwitch `limitedProfileOf` okur).
      engineProfileId: (info && info.engineProfileId) || meta.engineProfileId || null,
    };
  }

  /**
   * Feed one pane's captured output through ROBUST detection. Returns an
   * observability verdict (or null when clean) so the daemon can log EVERY poll:
   *   • null                         — no limit (report prose, working agent, …)
   *   • {kind:'prompt', action,…}    — Format A: graceful option selected (or dry)
   *   • the queue entry (has .status)— Format B/plain: captured + resume scheduled
   *
   * ADP-098 split (the prod-miss fix):
   *   Format A (interactive /rate-limit-options prompt) → select the graceful
   *     "Stop and wait" option (send the digit). Claude Code then NATIVELY
   *     auto-resumes itself at reset time — so we do NOT queue or schedule a
   *     `claude --resume`; we just hand off and log. Idempotent per pane.
   *   Format B (plain, session exited) → capture + schedule the `claude --resume`
   *     path (unchanged ADP-088/089 machine).
   * `meta` = { paneRef, agentId?, taskId?, engine?, cwd?, runtime }.
   */
  observe(text, meta) {
    const paneRef = meta && meta.paneRef;
    const now = this.now();
    // LIMIT-RESUME-02 — pane sessizliği HER poll'da ölçülür (nöbetçinin "son 10 dk
    // çıktı yok" kapısı). Ucuz: 8 KB tail'in imzası.
    const paneState = this._notePane(paneRef, text, now);
    const signal = limitDetect.detectLimitState(text);
    // LIMIT-RESUME-02 — native pane: kayıt varsa/limit varsa NÖBETÇİ yolu; bugünkü
    // tuş/ESC/gönderim makinesi bu pane için HİÇ çağrılmaz (§6.3/1). Karar pane
    // başına (sürüm), enjekte edilmemişse hiç sorulmaz.
    const nativeId = this.nativeContinue ? this._identity(meta || {}) : null;
    if (nativeId && this._isNative(nativeId)) {
      if (paneRef) this._promptSelected.delete(paneRef);
      return this._observeNative(signal, nativeId, text, now, paneState);
    }
    if (!signal) {
      if (paneRef) this._promptSelected.delete(paneRef); // prompt cleared → re-arm next time
      // ADP-938 — ajan limitsiz çalışıyor: geçiş zinciri sıfırlanır (tavan "hayat
      // boyu" değil, ARKA ARKAYA limit penceresi içindir).
      if (this.autoSwitch) {
        try {
          this.autoSwitch.noteClear(this._identity(meta || {}), this.now());
        } catch { /* defter/karar hatası poll'u ASLA kesmez */ }
      }
      return null;
    }
    // ADP-938 (ADR Faz 3) — GEÇİŞ, BEKLEMEDEN ÖNCE denenir. Kullanıcının ikinci
    // aboneliği varsa doğru davranış 5 saat park etmek değil, öteki hesapla
    // KALDIĞI YERDEN devam etmektir. Ayar KAPALIYSA (varsayılan) bu çağrı anında
    // `disabled` döner ve aşağısı bugünkü akışın aynısıdır.
    const switched = this._tryAutoSwitch(signal, meta);
    if (switched) return switched;
    if (signal.kind === 'prompt') {
      return this._handlePrompt(signal, meta);
    }
    if (paneRef) this._promptSelected.delete(paneRef);
    return this._handlePlain(signal, meta);
  }

  // ═══ LIMIT-RESUME-02 — native-continue (nöbetçi) modu ═════════════════════

  /** Pane sessizlik ölçümü: imza değiştiyse `changedAt = now`. → {quietMs, changed} */
  _notePane(paneRef, text, now) {
    if (!paneRef) return { quietMs: 0, changed: true };
    const sig = paneSignature(text);
    const prev = this._pane.get(paneRef);
    if (!prev || prev.sig !== sig) {
      this._pane.set(paneRef, { sig, changedAt: now });
      return { quietMs: 0, changed: true, sig };
    }
    return { quietMs: now - prev.changedAt, changed: false, sig };
  }

  /** Bu pane'in motoru limitte kendi devam eder mi (bir hata → hayır, bugünkü yol). */
  _isNative(id) {
    if (!this.nativeContinue) return false;
    try {
      return this.nativeContinue(id) === true;
    } catch {
      return false;
    }
  }

  /** Bu ajanın aktif kaydı (native ya da değil). */
  _activeEntryOf(id) {
    if (!id || !id.agentId) return null;
    return resumeQueue.activeEntries(this.homedir).find((e) => e.agentId === id.agentId) || null;
  }

  /**
   * Native pane'in poll yolu. Dönüş observe() sözleşmesindedir:
   *   null                      — limit yok, kayıt yok
   *   {kind:'native', action,…} — limit/band görüldü ya da kayıt izleniyor
   * Sıra: (1) motor kendi devam ettiyse kaydı KAPAT (dış devam), (2) limit/band
   * varsa kaydı yaz/tazele (zamanlayıcı YOK), (3) nöbetçi kuralı.
   */
  _observeNative(signal, id, text, now, paneState) {
    const band = limitDetect.detectNativeContinueState(text);
    // Temiz ekran + izlenen kayıt yok → kuyruk dosyasına dokunmadan çık (ucuz yol).
    if (!signal && !band && !(id.agentId && this._nativeWatch.has(id.agentId))) {
      if (this.autoSwitch) {
        try {
          this.autoSwitch.noteClear(id, now);
        } catch { /* poll'u kesmez */ }
      }
      return null;
    }
    let entry = this._activeEntryOf(id);
    if (!entry && id.agentId) this._nativeWatch.delete(id.agentId);

    // (1) Dış devam: kayıt aktifken ajan görünür biçimde çalışıyor ya da transcript'e
    // yeni asistan satırı düştü → motor (ya da kullanıcı) kendi devam etti. ESC yok,
    // gönderim yok; kayıt kapanır (§6.3/3). Hüküm yalnız kesme yoksa (§6.3/4).
    if (entry && entry.mode === 'native') {
      const ext = this._externalResume(entry, text, now);
      if (ext) return ext;
    }

    if (!signal && !band) {
      if (this.autoSwitch) {
        try {
          this.autoSwitch.noteClear(id, now);
        } catch { /* poll'u kesmez */ }
      }
      return entry && entry.mode === 'native' ? this._nativeStatus(entry, 'watching', now) : null;
    }

    // (2) Limit ya da band: kaydı yaz/tazele. Zamanlayıcı KURULMAZ — bu, bugünkü
    // makinenin tam tersi ve bilerek: fire() bu kayıt için hiç koşmaz.
    const src = signal || band;
    const reset = this._resetSignal(src, now);
    let resetAt = reset.at;
    // Kayıttaki saat korunur: bayat satırın yeniden okunması (geçmişte kaldığı için
    // null) bilineni SİLMEZ (ADP-947 kuralı burada da).
    if (!Number.isFinite(resetAt) && entry && Number.isFinite(entry.resetAt)) resetAt = entry.resetAt;
    const { entry: rec, changed } = resumeQueue.captureLimit(
      {
        ...id,
        detectedAt: now,
        resetAt,
        resetSource: reset.source,
        resetPassedAt: reset.passed ? now : null,
        resetRaw: (signal && signal.raw) || (band && band.raw) || null,
        status: 'scheduled',
        mode: 'native',
      },
      this.homedir,
    );
    if (rec.mode !== 'native') {
      // Eski (legacy) bir kayıt aynı ajan için açıkken pane native'e döndü: eski
      // zamanlayıcıyı sök, kaydı native'e çevir — iki makine aynı pane'e yazmasın.
      this.scheduler.cancel(rec.id);
      this.scheduler.cancel(rec.id + this._verifySuffix);
      resumeQueue.updateEntry(rec.id, { mode: 'native' }, this.homedir);
      rec.mode = 'native';
    }
    entry = rec;
    if (entry.agentId) this._nativeWatch.add(entry.agentId);
    if (changed) {
      this._track('detect', entry, { outcome: signal ? `${signal.kind}-native` : `band-${band.phase}` });
      this._emit('schedule', entry, 'native', this._statusOf(entry, Number.isFinite(entry.resetAt) ? entry.resetAt : null));
    }
    this._sayNative(entry, band, now);

    // (3) Nöbetçi.
    const nudged = this._sentinel(entry, signal, band, text, now, paneState);
    if (nudged) return nudged;
    return this._nativeStatus(entry, band ? `band-${band.phase}` : 'limited', now, { changed });
  }

  /** observe() dönüşü (heartbeat/rozet için): kind 'native' + eylem + saat. */
  _nativeStatus(entry, action, now, extra = {}) {
    return {
      kind: 'native',
      paneRef: entry.paneRef,
      agentId: entry.agentId,
      engine: entry.engine,
      action,
      entryId: entry.id,
      resetAt: Number.isFinite(entry.resetAt) ? entry.resetAt : null,
      status: entry.status,
      ...extra,
    };
  }

  /** Dürüst durum satırı — aynı durum için bir kez (her 5 sn'de bir değil). */
  _sayNative(entry, band, now) {
    const known = Number.isFinite(entry.resetAt);
    const key = `${entry.id}|${known ? entry.resetAt : 'unknown'}|${band ? band.phase : '-'}`;
    if (this._nativeSaid.get(entry.paneRef) === key) return;
    this._nativeSaid.set(entry.paneRef, key);
    let line;
    if (band && band.phase === 'stale') {
      line = `motor "limit yenilendi, Enter bekliyorum" diyor (pane ${entry.paneRef}) — nöbetçi sessizlik + ${Math.round(this.sentinelGraceMs / 60_000)}dk sonra tek Enter gönderecek`;
    } else if (band && band.phase === 'cancelled') {
      line = `motorun otomatik devamı İPTAL olmuş (pane ${entry.paneRef}) — ${known ? `reset ${formatClock(entry.resetAt)} + ${Math.round(this.sentinelGraceMs / 60_000)}dk sonra tek "devam et"` : 'saat okunamadı → bekliyor, gönderim yok'}`;
    } else if (known) {
      line = `limit (pane ${entry.paneRef}) — motor ${formatWhen(entry.resetAt, now)}'de KENDİ devam edecek; daemon tuşa basmıyor, ESC yazmıyor (kaynak: ${entry.resetSource})`;
    } else {
      line = `limit (pane ${entry.paneRef}) — bekliyor — saat okunamadı; motor kendi devam ederse sürer, etmezse ekrandaki "press enter" bandı görülünce tek Enter gönderilir (gönderim 0, FAIL yok)`;
    }
    this._notify('resume', entry, line);
    this._track('native', entry, { outcome: band ? band.phase : known ? 'armed-clock' : 'waiting-no-clock' });
  }

  /**
   * §6.3/3-4 — motor (ya da kullanıcı) KENDİ devam etti mi? Kanıt: son karede çalışma
   * işareti + tampon değişmiş, ya da transcript'te detectedAt sonrası asistan İÇERİĞİ.
   * Kesme (`[Request interrupted by user]`) varsa "resumed" DENMEZ — kayıt açık kalır.
   */
  _externalResume(entry, text, now) {
    const since = Number.isFinite(entry.sentinelAt) ? entry.sentinelAt : entry.detectedAt || 0;
    let src = null;
    const frame = limitDetect.lastFrameText(text);
    // Son karede çalışma işareti: algılama anında G2 sinyali keserdi, yani bu kare
    // algılamadan SONRA çizildi (tampon değişti) — bayat spinner sayılmaz.
    if (limitDetect.isAgentWorking(frame) && !limitDetect.detectLimitState(text)) {
      src = 'pane-working';
    } else {
      const last = this._external.get(entry.id) || 0;
      if (now - last >= EXTERNAL_CHECK_MIN_GAP_MS) {
        this._external.set(entry.id, now);
        const ev = this.activityEvidence(entry, since, text) || { ok: false };
        if (ev.ok) src = ev.src || 'transcript';
      }
    }
    if (!src) return null;
    if (this._interruptedSince(entry, since)) {
      const key = `${entry.id}|interrupted`;
      if (this._nativeSaid.get(entry.paneRef) !== key) {
        this._nativeSaid.set(entry.paneRef, key);
        this._notify('resume', entry, `pane ${entry.paneRef} hareketlendi ama transcript'te kullanıcı KESMESİ var — "devam etti" sayılmadı, kayıt açık`);
        this._track('external', entry, { outcome: 'interrupted', evidenceSrc: src });
      }
      return null;
    }
    const via = Number.isFinite(entry.sentinelAt) ? `nöbetçi ${entry.sentinelPhase}` : 'dış/native';
    this._notify('resume', entry, `kaldığı yerden devam ediyor ✓ (pane ${entry.paneRef}, ${via}, kanıt: ${src}) — daemon hiçbir tuş yazmadı${Number.isFinite(entry.sentinelAt) ? ' (tek nöbetçi dokunuşu hariç)' : ''}`);
    this._track('external', entry, { outcome: Number.isFinite(entry.sentinelAt) ? 'resumed-after-sentinel' : 'resumed-externally', evidenceSrc: src });
    this._emit('resumed', entry, src, { nextAttemptAt: null, resetAt: null, resetKnown: false, verdict: null });
    resumeQueue.updateEntry(entry.id, { status: 'resumed', lastError: null }, this.homedir);
    resumeQueue.removeEntry(entry.id, this.homedir);
    this._external.delete(entry.id);
    this._nativeSaid.delete(entry.paneRef);
    if (entry.agentId) this._nativeWatch.delete(entry.agentId);
    if (this.autoSwitch) {
      try {
        this.autoSwitch.noteClear(entry, now);
      } catch { /* poll'u kesmez */ }
    }
    return this._nativeStatus(entry, Number.isFinite(entry.sentinelAt) ? 'resumed-after-sentinel' : 'resumed-externally', now, { evidenceSrc: src });
  }

  /** Transcript'te `since` sonrası kullanıcı kesmesi var mı (uuid oturum + cwd şart). */
  _interruptedSince(entry, since) {
    if (!entry || entry.engine === 'codex' || !entry.cwd || !resumeTmux.isUuid(entry.sessionId)) return false;
    try {
      const file = path.join(resumeTmux.claudeProjectsDir(entry.cwd, this.homedir), `${entry.sessionId}.jsonl`);
      return transcriptInterruptedAfter(file, since);
    } catch {
      return false;
    }
  }

  /**
   * §6.3/2 — NÖBETÇİ. Hepsi birden sağlanmadan hiçbir şey yazılmaz:
   *   • ekranda ajan çalışmıyor (isAgentWorking → hayır; bu G2 zaten sinyali keser)
   *   • pane `sentinelQuietMs` boyunca sessiz
   *   • stale band ("press enter") → saat gerekmez: motor "reset OLDU" diyor → TEK Enter
   *   • diğer hâller → resetAt BİLİNİYOR ve resetAt + grace geçmiş:
   *       cancelled band / bayat düz limit satırı → TEK "devam et"
   *       Format-A menüsü hâlâ ekranda      → zarif 'wait' seçeneği bir kez (motor
   *                                            geçmiş reset'i görüp sürer; canlı CLI'da
   *                                            ÖLÇÜLMEDİ — raporda açık soru)
   *   • saat bilinmiyor + stale değil → HİÇ (dürüst "bekliyor" satırı zaten yazıldı)
   *   • en fazla SENTINEL_MAX_NUDGES dokunuş; her faz için bir kez
   */
  _sentinel(entry, signal, band, text, now, paneState) {
    if (this.dryRun) return null;
    if (!paneState || paneState.quietMs < this.sentinelQuietMs) return null;
    if (limitDetect.isAgentWorking(limitDetect.lastFrameText(text))) return null;
    if ((entry.sentinelCount || 0) >= SENTINEL_MAX_NUDGES) return null;
    const phase = band ? band.phase : signal ? (signal.kind === 'prompt' ? 'menu' : 'plain') : null;
    // 'armed' → motor kendi kuracağını söylüyor; 'again' → limit YENİDEN aktif (motorun
    // kendi devamı çarptı), dokunmak ikinci bir çarpma olur → ikisinde de dokunma.
    if (!phase || phase === 'armed' || phase === 'again') return null;
    if (entry.sentinelPhase === phase) return null; // bu faza bir kez dokunuldu
    if (Number.isFinite(entry.sentinelAt) && now - entry.sentinelAt < this.sentinelGraceMs) return null;

    const known = Number.isFinite(entry.resetAt);
    let action = null;
    if (phase === 'stale') {
      action = 'enter';
    } else if (known && now >= entry.resetAt + this.sentinelGraceMs) {
      action = phase === 'menu' ? 'menu-select' : 'continue';
    }
    if (!action) return null;

    let ok = false;
    let detail = '';
    if (action === 'enter') {
      ok = this.pressEnter ? this.pressEnter(entry.paneRef) === true : false;
      detail = 'tek Enter (motor "press enter to continue" diyordu)';
      if (!this.pressEnter) detail = 'Enter yolu enjekte edilmemiş → gönderim yok';
    } else if (action === 'menu-select') {
      ok = Number.isInteger(signal && signal.stopOption) ? this.selectOption(entry.paneRef, signal.stopOption) !== false : false;
      detail = `menü hâlâ ekranda, reset ${formatClock(entry.resetAt)} geçti → zarif seçenek ${signal && signal.stopOption} bir kez`;
    } else {
      const r = this.sendResume({ ...entry }, { liveness: 'live' });
      ok = !!(r && r.ok);
      detail = `tek "devam et" (reset ${formatClock(entry.resetAt)} + ${Math.round(this.sentinelGraceMs / 60_000)}dk geçti, pane ${Math.round(paneState.quietMs / 60_000)}dk sessiz, band: ${phase})`;
    }
    const count = (entry.sentinelCount || 0) + 1;
    const live =
      resumeQueue.updateEntry(
        entry.id,
        { sentinelAt: now, sentinelPhase: phase, sentinelCount: count, firedAt: now, firedSig: paneSignature(text) },
        this.homedir,
      ) || entry;
    this._track('sentinel', live, { outcome: ok ? action : `${action}-failed`, attempt: count });
    this._notify('resume', live, `nöbetçi: ${detail} (pane ${live.paneRef}, dokunuş ${count}/${SENTINEL_MAX_NUDGES})${ok ? '' : ' — YAZILAMADI'}`);
    this._emit('sentinel', live, action, this._statusOf(live, null));
    this._pane.set(live.paneRef, { sig: paneSignature(text), changedAt: now }); // sessizlik sayacı sıfır
    return this._nativeStatus(live, `sentinel-${action}`, now, { ok });
  }

  /**
   * ADP-938 — limit görüldü: müsait BAŞKA hesap varsa oraya geç ve oturumu
   * kaybetmeden devam et. Döngü koruması, defter ve tavan engineSwitch.cjs'te;
   * burada yalnız ÇAĞRI + görünürlük var.
   *
   * @returns {object|null} geçiş OLDUYSA observe()'un döneceği verdict; aksi
   *   hâlde null → çağıran bugünkü (kuyruk + resetAt'te devam) akışa düşer.
   *
   * Kurallar:
   *   • `dryRun` hiçbir pane'e dokunmaz → yalnız NE YAPACAĞINI loglar (ADP-089).
   *   • Geçiş olmasa bile motorun ürettiği mesaj (hepsi limitli / tavan doldu)
   *     BASILIR — sessiz geçiş de sessiz VAZGEÇİŞ de yasak.
   *   • Bir hata bu dalı geçersiz kılar ama poll'u ASLA kesmez: hesap geçişi bir
   *     İYİLEŞTİRMEdir, resume hattının ön koşulu değil.
   */
  _tryAutoSwitch(signal, meta) {
    if (!this.autoSwitch) return null;
    const id = this._identity({ ...(meta || {}), engine: (meta && meta.engine) || signal.engine });
    const now = this.now();
    let res = null;
    try {
      const resetAt = this._resetSignal(signal, now).at; // ADP-947 / RES-04
      if (this.dryRun) {
        res = this.autoSwitch.previewSwitch
          ? this.autoSwitch.previewSwitch({ ...id, resetAt }, now)
          : { switched: false, reason: 'dryrun', message: null };
        if (res && res.message) this._notify('dryrun', id, `hesap geçişi: ${res.message}`);
        return null;
      }
      res = this.autoSwitch.trySwitch({ ...id, resetAt, raw: signal.raw }, now);
    } catch (err) {
      this._notify('resume', id, `otomatik hesap geçişi denenemedi: ${(err && err.message) || err}`);
      return null;
    }
    if (!res) return null;
    if (res.message) this._notify('resume', id, `${res.message} (pane ${id.paneRef})`);
    if (!res.switched) return null;
    // Geçiş yapıldı: ESKİ pane'in limit kaydı ve zamanlayıcısı ARTIK GEÇERSİZ —
    // aksi hâlde ölü bir pane'e resume gönderilirdi (ADP-089 olay sınıfı).
    if (id.paneRef) this._promptSelected.delete(id.paneRef);
    return {
      kind: 'switch',
      paneRef: id.paneRef,
      agentId: id.agentId,
      engine: id.engine,
      from: res.from,
      to: res.to,
      newPaneId: res.paneId || null,
    };
  }

  /**
   * Format A — interactive rate-limit prompt. Select the graceful "wait" option
   * ONCE (Claude's native auto-resume takes it from there) and log. No queue, no
   * `--resume`. Idempotent: a still-on-screen prompt across polls is selected only
   * once (keyed by pane + option + raw).
   */
  _handlePrompt(signal, meta) {
    const id = this._identity({ ...meta, engine: meta.engine || signal.engine });
    const paneRef = id.paneRef;
    const sig = `${signal.stopOption}|${signal.raw}`;
    const result = {
      kind: 'prompt',
      paneRef,
      agentId: id.agentId,
      engine: id.engine,
      stopOption: signal.stopOption,
      raw: signal.raw,
    };
    // Already handled this exact prompt on this pane → no-op (don't re-press).
    if (paneRef && this._promptSelected.get(paneRef) === sig) {
      // ADP-947 — …but DO keep watching the clock. This early return is the ONE poll
      // path that never reaches the scheduler again, so a Format-A pane (Claude Code's
      // interactive /rate-limit-options menu — the common case) whose fire timer never
      // came due would sit here forever: the poll re-observes a live limit menu every
      // 5s, recognises it, and does nothing. That is "13:00'de yenilendi FAKAT otomatik
      // başlamıyo" with the record still healthy in the queue.
      // RES-02 §5 — the watchdog only covers a KNOWN reset instant that has passed.
      // The other hole on this path is an active record with no timer at all (reset
      // never parsed, or the timer lost) — the poll would recognise the menu forever
      // and arm nothing. Run the invariant check here too.
      const armed = this._watchdogFire(id) || this._ensureArmed(id);
      // RES-07 §3 — bu, Format-A'nın KALICI hâli (menü ekranda durdukça her poll
      // buradan döner), yani kalp atışının "limit var ama saati okuyabildik mi?"
      // ayrımını yapabileceği TEK yer. Kayıttan okunur, ekrandan yeniden türetilmez.
      const rec = id.agentId
        ? resumeQueue.activeEntries(this.homedir).find((e) => e.agentId === id.agentId)
        : null;
      return {
        ...result,
        action: armed ? 'watchdog-fire' : 'already-selected',
        resetAt: rec && Number.isFinite(rec.resetAt) ? rec.resetAt : null,
      };
    }
    if (paneRef) this._promptSelected.set(paneRef, sig);

    const who = id.taskId || id.agentId || paneRef;
    if (!Number.isInteger(signal.stopOption)) {
      // Detected a limit prompt but couldn't identify the wait option — surface it
      // (never silently drop) and let Claude's default (option 1 / native) stand.
      this._notify('resume', { ...id }, `limit prompt'u algılandı ama 'wait' seçeneği bulunamadı (pane ${paneRef}) — native auto-resume'e bırakıldı`);
      return { ...result, action: 'no-stop-option' };
    }
    if (this.dryRun) {
      this._notify(
        'dryrun',
        { ...id },
        `2-seçenekli limit prompt'u: seçenek ${signal.stopOption} (graceful stop) seçilecekti (pane ${paneRef}) → Claude native auto-resume devralır`,
      );
      return { ...result, action: 'dryrun-select' };
    }
    this.selectOption(paneRef, signal.stopOption);
    // ADP-131 (Eren 2026-06-21): Claude Code "Stop and wait" sonrası reset'te KENDİ
    // DEVAM ETMİYOR — birinin gerçek "devam et" promptu göndermesi gerekir. O yüzden
    // stop seçtikten sonra reset-zamanı nudge'ını ZAMANLA (_handlePlain'in kanıtlı
    // capture→schedule→fire→sendResume makinesini REUSE; pane 'live' → buildContinueText
    // "devam et" yazar). Native-resume varsayımı KALDIRILDI.
    const now = this.now();
    const reset = this._resetSignal(signal, now); // ADP-947 / RES-04
    const resetAt = this._carryResetAt(id, reset.at);
    const { entry, changed } = resumeQueue.captureLimit(
      {
        ...id,
        detectedAt: now,
        resetAt,
        resetSource: reset.source, // RES-08
        resetPassedAt: reset.passed ? now : null,
        resetRaw: signal.raw,
        status: 'scheduled',
      },
      this.homedir,
    );
    if (changed) this._track('detect', entry, { outcome: 'prompt' }); // RES-08
    this._armIfNeeded(entry, changed, now);
    this._notify(
      'resume',
      { ...id },
      `limit prompt'u: graceful stop seçildi (seçenek ${signal.stopOption}, pane ${paneRef}) → reset'te "devam et" gönderilecek (${resetAt ? formatClock(resetAt) : '~5dk fallback'})`,
    );
    // RES-07 §3 — kalp atışı bu iki hâli AYIRT edebilsin: saat okundu mu, okunmadı mı.
    return {
      ...result,
      action: 'select-and-schedule',
      entryId: entry.id,
      resetAt: entry.resetAt,
    };
  }

  /**
   * Format B / plain — capture the limit and arm the scheduled `claude --resume`
   * (the ADP-088/089 detect→schedule→resume→verify→backoff machine).
   */
  _handlePlain(signal, meta) {
    const id = this._identity({ ...meta, engine: meta.engine || signal.engine });
    const now = this.now();
    const reset = this._resetSignal(signal, now); // ADP-947 / RES-04
    const resetAt = this._carryResetAt(id, reset.at);

    const { entry, changed } = resumeQueue.captureLimit(
      {
        ...id,
        detectedAt: now,
        resetAt,
        resetSource: reset.source, // RES-08
        resetPassedAt: reset.passed ? now : null,
        resetRaw: signal.raw,
        status: 'scheduled',
      },
      this.homedir,
    );

    // RES-08 — HER poll değil, yalnız takvim DEĞİŞTİĞİNDE bir satır: 5 saniyelik bir
    // poll'un her turunu yazmak günlüğü ölçülemez hâle getirirdi (RES-01'in elle
    // birleştirmek zorunda kaldığı gürültünün aynısı).
    if (changed) this._track('detect', entry, { outcome: 'plain' });
    this._armIfNeeded(entry, changed, now);
    return entry;
  }

  /**
   * RES-02 §5 / RES-04 — the ONE place a poll may arm a trigger, and the place the
   * "no active record without an armed trigger" invariant is enforced.
   *
   * Idempotent across the multi-tick limit message (ADR §2.4): a schedule that has
   * not MOVED and already has a live timer is left completely alone — that is the
   * starvation fix, because a 5-second poll re-arming a 90-second timer means the
   * timer never comes due. The three real cases are kept apart:
   *
   *   • a verify is pending          → that timer owns the entry, hands off
   *   • the schedule moved / no timer → arm (immediately when we know the reset
   *                                     already happened but were never given a clock)
   *   • armed, but the instant it was armed for is long past (slept laptop)
   *                                  → ADP-947 watchdog, throttled
   *
   * An active record with NO timer at all is a dead worker — the exact shape of the
   * customer complaint — so it is closed AND logged rather than silently patched.
   */
  _armIfNeeded(entry, changed, now) {
    if (this.scheduler.has(entry.id + this._verifySuffix)) return; // verify owns it
    const armed = this.scheduler.has(entry.id);
    if (!changed && !armed) {
      this._notify(
        'resume',
        entry,
        `INVARIANT: aktif kayıt (${entry.status}) için armlanmış tetik yoktu — ` +
          `yeniden kuruldu (pane ${entry.paneRef})`,
      );
    }
    if (changed || !armed) {
      // Reset already behind us and no clock was ever parsed: waiting is the wrong
      // answer — the scheduler's blind 5-minute unknown-reset delay is what fired
      // resumes hours early. Go now; verify judges the attempt.
      let delay;
      if (!Number.isFinite(entry.resetAt) && Number.isFinite(entry.resetPassedAt)) {
        delay = this.scheduler.scheduleAt(entry.id, 0, () => this.fire(entry));
      } else {
        delay = this.scheduler.schedule(entry, (e) => this.fire(e), now);
      }
      this._announceSchedule(entry, delay, now); // RES-07/08
      return;
    }
    if (this._watchdogDue(entry, now)) {
      this.scheduler.scheduleAt(entry.id, 0, () => this.fire(entry)); // ADP-947
      this._announceSchedule(entry, 0, now, 'watchdog');
    }
  }

  /**
   * RES-07 §2 + RES-08 — "sıradaki deneme ŞU AN" bilgisini TEK yerden yay: renderer
   * rozeti (kullanıcı uygulamadan çıkmadan saati okuyabilsin) ve telemetri satırı.
   * Metin ÜRETİLMEZ, veri taşınır — biçimlendirme arayüzün işi (ve i18n'in).
   */
  _announceSchedule(entry, delayMs, now, reason) {
    const at = Number.isFinite(delayMs) ? now + delayMs : null;
    const st = this._statusOf(entry, at);
    this._track('schedule', entry, { delayMs: Number.isFinite(delayMs) ? delayMs : null, outcome: reason || 'armed' });
    this._emit('schedule', entry, reason || null, st);
  }

  /**
   * RES-02 §5 — invariant sweep for a poll path that does NOT go through
   * captureLimit (the Format-A "already-selected" early return). Re-arms this
   * agent's active record if it has been left with no timer. Returns true when a
   * hole was closed.
   */
  _ensureArmed(id) {
    if (!id || !id.agentId) return false;
    const entry = resumeQueue.activeEntries(this.homedir).find((e) => e.agentId === id.agentId);
    if (!entry) return false;
    if (this.scheduler.has(entry.id) || this.scheduler.has(entry.id + this._verifySuffix)) {
      return false;
    }
    this._armIfNeeded(entry, false, this.now());
    return true;
  }

  /**
   * Resolve the session id to resume with, honoring cross-pane isolation:
   *   • a registry/minted uuid is trusted as-is (and any non-empty codex id)
   *   • claude with no id → jsonl YEDEK, but resolveSessionId returns null when
   *     the cwd has 2+ recently-active sessions (ambiguous → refuse to guess)
   * Returns { id, src }.
   */
  _resolveSession(entry, now) {
    if (resumeTmux.isUuid(entry.sessionId)) return { id: entry.sessionId, src: 'registry/minted' };
    if (entry.engine === 'codex') {
      return entry.sessionId
        ? { id: entry.sessionId, src: 'registry' }
        : { id: null, src: 'codex resume --last' };
    }
    const id = this.resolveSessionId(entry, now);
    return { id, src: id ? 'jsonl' : 'unresolved (ambiguous/missing — cross-pane korumalı)' };
  }

  /**
   * Scheduled callback: continue/resume the session in its pane. Liveness decides
   * continue-vs-resume (resumeTmux.sendResume). Dry-run LOGS the plan and drops the
   * entry without touching the pane. Claude with no safely-resolvable session id
   * → backoff (never a wrong-session resume).
   */
  fire(entrySnapshot) {
    const entry = this._reload(entrySnapshot);
    if (!resumeQueue.isActiveStatus(entry.status)) return; // already terminal
    // LIMIT-RESUME-02 — native kayıt HİÇ ateşlenmez (yanlışlıkla armlanmış bir
    // zamanlayıcı bile olsa): motor kendi devam eder, nöbetçi poll'dan bakar.
    if (entry.mode === 'native') return 'native';
    const now = this.now();

    // ADP-180 — decide continue-vs-resume FIRST. A LIVE engine TUI (the common case:
    // claude stays attached showing the limit) only needs a "devam et" nudge — NO
    // session id. The PROVEN prod bug was here: the old code DEMANDED a uuid before
    // it ever looked at liveness, so a live claude pane (whose process is renamed to
    // its version → looked like 'shell') hit the "session-id güvenli çözülemedi"
    // backoff and the reset-time continue NEVER landed. Now liveness gates the guard.
    const liveText = this.capturePane(entry.paneRef);

    // ADP-938 — EARLY-FIRE GUARD (the P0 the Windows customer hit). Every send path
    // funnels through fire() — first attempt, verify-retry, backoff, boot reschedule —
    // so this ONE check is enough: never type into a pane that is still showing its
    // limit while the reset instant has not arrived. Before this, an unparsed reset
    // time meant the scheduler's 5-minute unknown-reset fallback poked the agent long
    // before the reset (measured: limit at 00:54 → send at 00:59 for a 1:20 reset),
    // which re-hit the limit and stranded every worker. Dry-run never touches a pane,
    // so it keeps reporting the plan it always did.
    if (!this.dryRun) {
      const held = this._deferWhileLimited(entry, liveText, now);
      if (held) return held;
    }

    const liveness = this.liveness(entry, liveText);

    // RES-05 — SIFIR-TOKEN ÖN-YOKLAMA. Yalnız CANLI bir motor TUI'si için anlamlıdır:
    // motor çıkmışsa (`shell`) tazelenecek bir TUI yoktur ve devam yolu bir re-spawn'dır
    // — orada ESC yazmak hiçbir şey öğretmez, ısrar etmek ise respawn'ı hiç yaptırmaz
    // (kendi kurduğumuz "park edilmiş ajan"). Dry-run pane'e DOKUNMAZ.
    if (!this.dryRun && liveness === 'live') {
      const probed = this._probeBeforeSend(entry, liveText, now);
      if (probed) return probed;
    }

    let sessionId = entry.sessionId;
    let src = 'live continue (session gerekmez)';
    if (liveness !== 'live') {
      // Engine exited (or unknown) → relaunch with `--resume`, which needs a real id.
      const resolved = this._resolveSession(entry, now);
      sessionId = resolved.id;
      src = resolved.src;
      // Claude cannot resume without a uuid; refuse to guess (incident guard).
      if (entry.engine !== 'codex' && !resumeTmux.isUuid(sessionId)) {
        return this._backoffOrFail(entry, `session-id güvenli çözülemedi (${src})`);
      }
    }

    if (this.dryRun) {
      const planned = liveness === 'live' ? null : resumeTmux.buildResumeCommand({ ...entry, sessionId });
      this._notify(
        'dryrun',
        entry,
        `limit sonrası devam ettirilecekti — engine=${entry.engine}, liveness=${liveness}, session=${src}` +
          ` (${sessionId || 'yok'}), pane ${entry.paneRef}` +
          (planned ? ` → \`${planned}\`` : ' → live: "devam et" continue keystroke'),
      );
      resumeQueue.removeEntry(entry.id, this.homedir);
      return 'dryrun';
    }

    const attemptNo = (Number.isInteger(entry.attempts) ? entry.attempts : 0) + 1;
    const live =
      resumeQueue.updateEntry(
        entry.id,
        {
          status: 'resuming',
          sessionId: sessionId || entry.sessionId,
          firedAt: now,
          // RES-02 — what the pane looked like BEFORE we typed. verify() requires it
          // to have changed, so a frozen pane cannot pass as a working one.
          firedSig: paneSignature(liveText),
        },
        this.homedir,
      ) || entry;

    const { ok, command, mode, engineSwitched, paneRef } = this.sendResume({ ...live, sessionId }, { liveness });
    // RES-08 — GÖNDERİM, başarı oranının PAYDASI. `resetAt` de yazılır: sapma
    // (tetik − reset) tam olarak bu iki damganın farkıdır (RES-06 pay kararı).
    this._track('send', live, {
      attempt: attemptNo,
      outcome: ok ? mode || 'sent' : 'failed',
    });
    if (!ok) {
      this._backoffOrFail(live, 'resume gönderilemedi (session-id yok / send başarısız)');
      return;
    }
    this._probe.delete(live.id); // gönderildi → yoklama zinciri sıfırlanır
    // ADP-428 — her deneme loglanır: attempt sayısı + doğrulama planı satırda.
    // HATA-12-B — motor bu arada değiştiyse pane YENİ motorla TEMİZ açıldı: hem
    // bildirim hem de doğrulama artık YENİ motoru anlatmalı. `verify(live)` eski
    // nesneyle çağrılırsa yanlış motorun TUI işaretleri aranır (ölçüldü: çalışan
    // pane "devam doğrulanamadı" sayıldı).
    const after = {
      ...live,
      ...(paneRef ? { paneRef } : null),
      ...(engineSwitched ? { engine: engineSwitched.to, sessionId: null } : null),
    };
    this._notify(
      'resume',
      after,
      `limit sonrası devam tetiklendi — ${
        mode === 'continue'
          ? 'continue keystroke'
          : engineSwitched
            ? `motor değişti (${engineSwitched.from}→${engineSwitched.to}), TEMİZ yeniden açıldı`
            : '--resume'
      } ` +
        `(engine=${after.engine}, pane ${after.paneRef}, deneme ${attemptNo}/${this.verifyMaxAttempts}, ` +
        `doğrulama ${Math.round(this.verifyWindowMs / 1000)}s sonra)`,
    );
    this.scheduler.scheduleAt(after.id + this._verifySuffix, this.verifyWindowMs, () =>
      this.verify(after),
    );
    return command;
  }

  /**
   * ADP-938/947 — hold a resume back until the pane's reset instant has arrived.
   * Returns 'deferred' when the send was postponed (and a timer was re-armed), or
   * null to let fire() proceed.
   *
   * ADP-947 — THE CLOCK GATES THE SEND, NOT THE SCREEN. The ADP-938 version asked the
   * screen FIRST and returned "go" whenever the captured tail did not parse as a limit
   * — but the tail is exactly the thing ConPTY makes unreliable (that was ADP-938's own
   * root cause #1), so a single clean-looking repaint let a backoff / verify-retry /
   * boot re-arm type into the pane 26 MINUTES before a KNOWN 01:20 reset (MEASURED on
   * the untouched daemon). A reset instant we already resolved is authoritative on its
   * own; the screen is only consulted when we have no instant at all.
   *
   * Rules (bounded on purpose — a guard that can block forever is a dead worker):
   *   • entry.resetAt KNOWN and not yet reached       → defer to exactly resetAt+buffer,
   *     WHATEVER the screen shows (spurious early fire: probe, backoff, boot re-arm)…
   *   • …but never past MAX_TOTAL_DEFER_MS after detection (ADP-947): the KNOWN branch
   *     used to be the one path with no ceiling, so a single mis-parsed instant parked
   *     the agent for a whole day with no attempt, no failure and no log.
   *   • entry.resetAt KNOWN and PASSED                → proceed. The limit line on the
   *     screen is then STALE output (claude leaves it there) — re-reading its clock
   *     would resolve to TOMORROW and park the agent for a day. The existing
   *     verify-retry tests are exactly this case, and they caught that mistake.
   *   • entry.resetAt UNKNOWN + clear screen          → proceed (nothing left to wait on)
   *   • entry.resetAt UNKNOWN + still limited (the ADP-938 incident: the reset time
   *     never parsed) → RE-READ it from the live screen and honour it; that is the
   *     self-heal. A re-read clock that has ALREADY PASSED means the reset happened →
   *     proceed instead of rolling it to tomorrow (ADP-947, see _resetInstant).
   *     Failing that, look again in DEFER_PROBE_MS. All bounded by MAX_TOTAL_DEFER_MS
   *     after detection, past which we send anyway and let verify/retry judge it.
   * Deferring costs no `attempts`: nothing was sent, so nothing failed.
   */
  _deferWhileLimited(entry, text, now) {
    const buffer = Number.isFinite(this.scheduler.resetBufferMs) ? this.scheduler.resetBufferMs : 0;
    const since = Number.isFinite(entry.detectedAt) ? entry.detectedAt : now;
    const ceiling = since + MAX_TOTAL_DEFER_MS - now;
    const defer = (delay, why) => {
      this.scheduler.scheduleAt(entry.id, delay, () => this.fire(entry));
      this._notify(
        'resume',
        entry,
        `erken devam ENGELLENDİ — pane ${entry.paneRef} hâlâ limitli, ${why} → ` +
          `${Math.max(1, Math.round(delay / 60_000))}dk sonra denenecek`,
      );
      // RES-07/08 — bekleyiş de bir OLAYDIR: kullanıcı sıradaki denemenin saatini
      // görebilsin, ölçüm onu sayabilsin.
      const live = this._reload(entry);
      this._track('schedule', live, { delayMs: delay, outcome: 'deferred' });
      this._emit('schedule', live, 'deferred', this._statusOf(live, now + delay));
      return 'deferred';
    };

    if (Number.isFinite(entry.resetAt)) {
      const delay = entry.resetAt + buffer - now;
      if (delay <= 0) return null; // reset instant already honoured → line is stale → send
      if (ceiling <= 0) return null; // ADP-947 — bounded: no single read parks a day
      return defer(Math.min(delay, ceiling), `reset ${formatClock(entry.resetAt)}`);
    }

    // resetAt was never parsed (ConPTY noise / wrapped colon / no clock printed).
    const state = limitDetect.detectLimitState(text);
    if (!state) return null; // clear screen and nothing known → go
    if (ceiling <= 0) return null; // waited long enough blind → hand over to verify/retry

    const fresh = limitDetect.resolveResetAt(state, now);
    const reset = this._resetSignal(state, now); // ADP-947 — roll-forward trap closed
    if (Number.isFinite(reset.at) && reset.at > now) {
      resumeQueue.updateEntry(entry.id, { resetAt: reset.at, resetSource: 'reread' }, this.homedir);
      const delay = Math.min(Math.max(0, reset.at + buffer - now), ceiling);
      return defer(
        delay,
        `reset ${formatClock(reset.at)} (ekrandan yeniden okundu` +
          `${fresh.source === 'clock-local-fallback' ? ', zaman dilimi tanınmadı → yerel saat' : ''})`,
      );
    }
    if (reset.passed) {
      // ADP-947 — the clock on screen has already passed: the reset HAPPENED. RES-04
      // records that in its OWN field (writing it into resetAt is what starved the
      // send) and lets this attempt go out.
      if (!Number.isFinite(entry.resetPassedAt)) {
        resumeQueue.updateEntry(entry.id, { resetPassedAt: now }, this.homedir);
      }
      return null;
    }
    if (now - since >= UNKNOWN_MAX_DEFER_MS) return null;
    return defer(Math.min(DEFER_PROBE_MS, ceiling), 'reset saati okunamadı');
  }

  /**
   * RES-05 (D8) — GÖNDERİMDEN ÖNCE SIFIR-TOKEN YOKLAMA.
   *
   * Bugüne kadar "limit geçti mi?" sorusunun tek sorulma biçimi bir PROMPT harcamaktı:
   * gönder, 180 sn bekle, hükmü ver. Ölçülen bedeli RES-01 §3a'da: 9 olayın 9'unda
   * gönderim limite çarptı, `attempts` her seferinde arttı, bütçe erirken kullanıcı
   * pane'lere elle "devam et" yazdı. Oysa cevap ekranda YAZIYOR — sormanın ücretsiz
   * bir yolu var: TUI'yi SUBMIT ETMEDEN tazele (yalnız ESC) ve tazelenmiş ekrana bak.
   *
   * İKİ FAZ (çekirdek senkron; uyku yok, sahte saat altında da aynen koşar):
   *   faz 1 — ESC yaz, `probeSettleMs` sonrasına yeniden kur, `'probing'` dön
   *   faz 2 — tazelenmiş tamponu oku ve ÜÇ DURUMLU hüküm ver:
   *       limited → GÖNDERİM YOK, `attempts` ARTMAZ, yeniden zamanlanır
   *                 (defterde `erken devam ENGELLENDİ` satırı)
   *       unknown → GÖNDERİM YOK, yeniden yoklanır (tavanlarla sınırlı)
   *       clear   → yol açık, fire() gönderime devam eder
   *
   * Yoklamanın maliyeti: pane'e yazılan TEK bayt `\x1b`. Metin yok, CR yok, submit
   * yok → motor hiçbir istek üretmez (kanıt: resumeVisibility.test.cjs, yazılan tüm
   * baytlar ve `sendResume` çağrı sayısı ölçülür).
   *
   * @returns {string|null} 'probing' | 'probe-blocked' | 'probe-unknown' → fire() DURUR;
   *   null → yoklama yolu açtı (ya da hiç yok) → gönderime devam.
   */
  _probeBeforeSend(entry, text, now) {
    if (!this.probePane) return null; // yetenek enjekte edilmemiş → bugünkü davranış
    const since = Number.isFinite(entry.detectedAt) ? entry.detectedAt : now;
    const ceilingLeft = since + MAX_TOTAL_DEFER_MS - now;
    const prev = this._probe.get(entry.id) || null;

    // Faz 2 — yalnız TAZE bir yoklamanın cevabı okunur. Araya (örneğin
    // _deferWhileLimited'ın) bir erteleme girdiyse cevap bayattır; o hâlde baştan yokla.
    const fresh = prev && prev.pending && now - prev.at <= Math.max(this.probeRetryMs, this.probeSettleMs * 4);
    if (fresh) {
      const verdict = this._probeVerdict(text, prev.sig);
      if (verdict === 'clear') {
        this._probe.delete(entry.id);
        this._track('probe', entry, { outcome: 'clear' });
        return null;
      }
      if (verdict === 'limited') {
        this._probe.set(entry.id, { ...prev, pending: false, unknowns: 0 });
        return this._probeBlocked(entry, text, now, ceilingLeft);
      }
      // unknown
      const unknowns = prev.unknowns + 1;
      this._probe.set(entry.id, { ...prev, pending: false, unknowns });
      if (unknowns >= this.probeMaxUnknown || ceilingLeft <= 0) {
        this._probe.delete(entry.id);
        this._track('probe', entry, { outcome: 'unknown', attempt: unknowns });
        this._notify(
          'resume',
          entry,
          `ön-yoklama ${unknowns} kez sonuçsuz kaldı (TUI yanıt vermedi) — ` +
            `kör gönderime geçiliyor, hükmü doğrulama verecek (pane ${entry.paneRef})`,
        );
        return null; // kör gönderim: yoklama karar veremiyorsa ajanı park etmeyiz
      }
      const delay = Math.min(this.probeRetryMs, Math.max(0, ceilingLeft));
      this.scheduler.scheduleAt(entry.id, delay, () => this.fire(entry));
      this._track('probe', entry, { outcome: 'unknown', delayMs: delay, attempt: unknowns });
      this._emit('probe', entry, 'unknown', this._statusOf(entry, now + delay));
      this._notify(
        'resume',
        entry,
        `ön-yoklama sonuçsuz (ekran tazelenmedi) — gönderim YOK, ` +
          `${Math.max(1, Math.round(delay / 60_000))}dk sonra yeniden yoklanacak (pane ${entry.paneRef})`,
      );
      return 'probe-unknown';
    }

    // Faz 1 — tavanı dolmuş bir zincir artık yoklamaz: gönder, verify hüküm versin.
    if (ceilingLeft <= 0) {
      this._probe.delete(entry.id);
      return null;
    }
    let wrote = false;
    try {
      wrote = this.probePane(entry.paneRef) === true;
    } catch {
      wrote = false;
    }
    if (!wrote) {
      // Pane yazılamıyor (kapanmış / adaptör desteklemiyor) → yoklama YOK, bugünkü yol.
      this._probe.delete(entry.id);
      return null;
    }
    this._probe.set(entry.id, {
      at: now,
      sig: paneSignature(text),
      pending: true,
      unknowns: prev ? prev.unknowns : 0,
    });
    this.scheduler.scheduleAt(entry.id, this.probeSettleMs, () => this.fire(entry));
    this._track('probe', entry, { outcome: 'sent', delayMs: this.probeSettleMs });
    return 'probing';
  }

  /**
   * RES-05 §2 — yoklama "hâlâ limitli" dedi: GÖNDERİM YAPILMAZ ve `attempts` ARTMAZ
   * (hiçbir şey gönderilmedi, dolayısıyla hiçbir şey başarısız olmadı). Yeniden
   * zamanlama için önce ekranın kendi saatine bakılır — kör bir sabit yerine kesin
   * saat (RES-04'ün kuralı burada da geçerli).
   */
  _probeBlocked(entry, text, now, ceilingLeft) {
    const buffer = Number.isFinite(this.scheduler.resetBufferMs) ? this.scheduler.resetBufferMs : 0;
    const state = limitDetect.detectLimitState(text);
    const reset = state ? this._resetSignal(state, now) : { at: null, passed: false, source: 'unknown' };
    let delay = Math.min(DEFER_PROBE_MS, Math.max(0, ceilingLeft));
    let why = 'reset saati okunamadı';
    let live = entry;
    if (Number.isFinite(reset.at) && reset.at > now) {
      delay = Math.min(Math.max(0, reset.at + buffer - now), Math.max(0, ceilingLeft));
      why = `reset ${formatClock(reset.at)} (yoklamada okundu)`;
      live =
        resumeQueue.updateEntry(entry.id, { resetAt: reset.at, resetSource: 'reread' }, this.homedir) || entry;
    }
    this.scheduler.scheduleAt(entry.id, delay, () => this.fire(entry));
    // RES-05 DoD §2 — bu satır bugüne kadar SIFIR kez yazıldı; artık yoklama onu
    // gönderim YAPMADAN yazabiliyor (eskiden yalnız _deferWhileLimited yazabiliyordu
    // ve o da ancak reset saati bilinirken devreye giriyordu).
    this._notify(
      'resume',
      live,
      `erken devam ENGELLENDİ — ön-yoklama pane ${live.paneRef} hâlâ limitli diyor, ${why} → ` +
        `${Math.max(1, Math.round(delay / 60_000))}dk sonra denenecek (gönderim YOK, deneme sayılmadı)`,
    );
    this._track('probe', live, { outcome: 'limited', delayMs: delay });
    this._emit('probe', live, 'limited', this._statusOf(live, now + delay));
    return 'probe-blocked';
  }

  /**
   * RES-05 §3 — yoklamanın ÜÇ DURUMLU hükmü. İki durumlu ("limit var / yok") bir
   * cevap yalancıdır: ESC'e boyama yapmayan bir pane'in sessizliği "limit yok" DEĞİL,
   * "bilmiyorum"dur — ve bugünkü kod tam olarak o sessizliği "yol açık" diye okuyup
   * gönderim yapıyordu.
   *
   *   limited — tazelenmiş ekran hâlâ limit satırını/menüsünü gösteriyor
   *   clear   — ajan görünür biçimde ÇALIŞIYOR, ya da TUI tazelendi (tampon değişti)
   *             ve limit YOK
   *   unknown — tampon hiç kıpırdamadı: TUI yanıt vermedi, hüküm veremeyiz
   */
  _probeVerdict(text, priorSig) {
    if (!text) return 'unknown';
    if (limitDetect.detectLimitState(text)) return 'limited';
    // Çalışan bir ajan limitli DEĞİLDİR ve bunu ekranın kendisi söylüyor — tampon
    // imzasına bakmaya gerek yok (bu, G2 kapısının yoklamadaki karşılığı).
    if (limitDetect.isAgentWorking(limitDetect.lastFrameText(text))) return 'clear';
    return paneSignature(text) !== priorSig ? 'clear' : 'unknown';
  }

  /**
   * Post-resume check (ADR §5.3 + ADP-428): re-capture the pane and re-run ROBUST
   * detection, then demand POSITIVE evidence that the assistant actually produced
   * output after our send. The incident: the "devam et" nudge landed while still
   * limited; the typed text scrolled the limit line away, so the old negative-only
   * check ("no limit text on screen") declared success and DROPPED the entry —
   * nobody retried, Eren hand-continued 4 panes. Now success requires evidence
   * (working TUI markers or a post-send assistant transcript line); anything else
   * re-sends on the escalating verify-retry chain.
   */
  verify(entrySnapshot) {
    const entry = this._reload(entrySnapshot);
    const text = this.capturePane(entry.paneRef);
    const since = Number.isFinite(entry.firedAt) ? entry.firedAt : entry.detectedAt || 0;
    const evidence = this.activityEvidence(entry, since, text) || { ok: false };

    // (1) RES-02 §2 — the engine ANSWERED our nudge with its own limit line. Checked
    // FIRST, and off the TRANSCRIPT, because the screen is the unreliable surface:
    // once the nudge scrolls the announcement behind the input box the pane gates
    // stop recognising it (MEASURED: 0 of 62.668 pane verdicts were ever PLAIN) and
    // the old code read that silence as success. The refusal PRINTS the next reset
    // time, so the failure hands us the answer — re-arm on THAT clock, keep the
    // record. Deleting it here is what left panes idle for hours.
    if (evidence.limitAgain) {
      this._track('verify', entry, { outcome: 'limit-again', evidenceSrc: evidence.src || null });
      return this._verifyRetryOrFail(
        entry,
        'devam denemesi limite ÇARPTI (motor limit satırını geri döndürdü)',
        { limitText: evidence.limitText, outcome: 'limit-again' },
      );
    }
    if (limitDetect.detectLimitState(text)) {
      this._track('verify', entry, { outcome: 'still-limited', evidenceSrc: 'pane' });
      return this._verifyRetryOrFail(entry, 'resume sonrası hâlâ limitli', { limitText: text });
    }
    if (evidence.ok) {
      resumeQueue.updateEntry(entry.id, { status: 'resumed', lastError: null }, this.homedir);
      this._notify(
        'resume',
        entry,
        `kaldığı yerden devam ediyor ✓ (pane ${entry.paneRef}, kanıt: ${evidence.src || '?'})`,
      );
      // RES-08 — başarı oranının PAYI. RES-01'in 12/12 sahte başarısı tam olarak
      // burada sayılamadığı için üç gün görünmedi.
      this._track('verify', entry, { outcome: 'resumed', evidenceSrc: evidence.src || null });
      // RES-07 — rozet KENDİ KENDİNE düşsün: kullanıcı "hâlâ limitli mi?" diye
      // pane'e bakmak zorunda kalmasın.
      this._emit('resumed', entry, evidence.src || null, {
        nextAttemptAt: null,
        resetAt: null,
        resetKnown: false,
        verdict: null,
      });
      resumeQueue.removeEntry(entry.id, this.homedir);
      this._watchdog.delete(entry.id); // ADP-947
      this._probe.delete(entry.id); // RES-05
      return 'resumed';
    }
    this._track('verify', entry, { outcome: 'no-evidence' });
    return this._verifyRetryOrFail(entry, 'resume sonrası asistan çıktısı yok (kanıt bulunamadı)');
  }

  /**
   * Post-send evidence. ADP-428 made it POSITIVE-only; RES-02 makes it HONEST about
   * the negative case, because both of its positive sources were forgeable:
   *
   *   • pane-working — MUST come from the LAST redraw frame (limitDetect.lastFrameText)
   *     AND the buffer must have moved since the send. The pty buffer keeps every
   *     repaint, so a spinner printed BEFORE the limit was still in the 14-line tail
   *     minutes later and read as "the agent is working" on a pane that had not
   *     produced a byte since our nudge.
   *   • transcript  — only for a REAL uuid session, and only when the assistant's
   *     post-send lines are not the limit announcement itself. The `newestJsonl`
   *     fallback is GONE (D9): with no uuid it picked the newest file in the cwd,
   *     which in this workspace is routinely a DIFFERENT agent — the neighbour's
   *     work counted as ours (measured: 5 sessions active in one cwd inside 3 min).
   *
   * Returns { ok, src?, limitAgain?, limitText? } — never throws (fs errors → no
   * evidence). `limitAgain` is the RES-02 verdict that turns a silent "success" into
   * a re-schedule on the clock the engine just printed.
   */
  _activityEvidence(entry, sinceMs, text) {
    const changedSinceSend =
      !entry || !entry.firedSig || entry.firedSig !== paneSignature(text);
    if (changedSinceSend && limitDetect.isAgentWorking(limitDetect.lastFrameText(text))) {
      return { ok: true, src: 'pane-working' };
    }
    if (entry && entry.engine !== 'codex' && entry.cwd && resumeTmux.isUuid(entry.sessionId)) {
      try {
        const dir = resumeTmux.claudeProjectsDir(entry.cwd, this.homedir);
        const file = path.join(dir, `${entry.sessionId}.jsonl`);
        if (fs.statSync(file).mtimeMs > sinceMs) {
          const lines = assistantLinesAfter(file, sinceMs);
          const refusal = lines.find((l) => l.kind === 'limit');
          if (refusal) return { ok: false, limitAgain: true, limitText: refusal.text, src: 'transcript-limit' };
          if (lines.length) return { ok: true, src: 'transcript' };
        }
      } catch {
        /* no transcript → no evidence */
      }
    }
    return { ok: false };
  }

  /**
   * ADP-428 — a verify failure re-sends with escalating waits (default +5m, +15m)
   * and gives up LOUDLY after the send budget (default 3): status=failed + FAIL
   * notice + onFail (renderer toast + notify log; ADP-844 — no off-screen bot arm).
   * Every retry is
   * logged with its attempt number — a silent early-fire can no longer strand
   * the agents until Eren notices by hand.
   */
  _verifyRetryOrFail(entry, reason, opts = {}) {
    const attempts = (Number.isInteger(entry.attempts) ? entry.attempts : 0) + 1;
    if (attempts >= this.verifyMaxAttempts) {
      return this._fail(entry, attempts, reason);
    }
    const now = this.now();
    const buffer = Number.isFinite(this.scheduler.resetBufferMs) ? this.scheduler.resetBufferMs : 0;

    // RES-04 §3 — a clock BEATS a backoff. When the engine's refusal (or the pane)
    // states the next reset, that instant is a fact and the escalating chain is only
    // a guess; scheduling on the guess is what sent the next attempt hours early.
    // Bounded on the same rule as _deferWhileLimited: no single reading may park an
    // agent longer than MAX_TOTAL_DEFER_MS. The anchor here is NOW, not detection —
    // a refusal that just arrived carries a FRESH clock and deserves its own budget.
    // A clock further out than that is implausible for a 5-hour session window (much
    // likelier a stale line), so the blind chain takes over: a mis-parse then costs a
    // wait, not a day. MEASURED motivation: a "resets 10:30pm" line read at 02:16
    // resolves 20h out — exactly the ADP-217 all-night stall.
    const ceiling = MAX_TOTAL_DEFER_MS;
    let resetAt = null;
    if (opts.limitText) {
      const parsed = limitDetect.extractResetWide(opts.limitText);
      if (parsed.resetClock || parsed.resetRel) {
        const r = this._resetSignal(parsed, now);
        if (Number.isFinite(r.at) && r.at > now && r.at + buffer - now <= ceiling) resetAt = r.at;
      }
    }
    const delay = resetAt
      ? Math.max(0, resetAt + buffer - now)
      : this.verifyRetryDelaysMs[Math.min(attempts - 1, this.verifyRetryDelaysMs.length - 1)];

    const patch = { status: 'scheduled', attempts, lastError: reason };
    if (resetAt) {
      patch.resetAt = resetAt;
      patch.resetSource = 'reread'; // RES-08 — saat motorun REDDİNDEN okundu
    }
    const updated =
      resumeQueue.updateEntry(entry.id, patch, this.homedir) || { ...entry, attempts };
    this.scheduler.scheduleAt(updated.id, delay, () => this.fire(updated));
    // RES-07/08 — yeniden deneme de görünür ve ölçülür olsun.
    this._track('retry', updated, { attempt: attempts, delayMs: delay, outcome: opts.outcome || 'verify-retry' });
    this._emit('retry', updated, reason, this._statusOf(updated, now + delay));
    this._notify(
      'resume',
      updated,
      `devam doğrulanamadı (${reason}) — deneme ${attempts}/${this.verifyMaxAttempts} başarısız, ` +
        (resetAt
          ? `cevaptaki reset saatine (${formatClock(resetAt)}) yeniden zamanlandı`
          : `${Math.round(delay / 60_000)}dk sonra yeniden denenecek`) +
        ` (pane ${updated.paneRef})`,
    );
    return opts.outcome || 'verify-retry';
  }

  /** Terminal failure: persist + FAIL notice + onFail hook (visible alert). */
  _fail(entry, attempts, reason) {
    this._watchdog.delete(entry.id); // ADP-947 — terminal → stop watching the clock
    this._probe.delete(entry.id); // RES-05 — terminal → stop probing
    this._track('fail', entry, { attempt: attempts, outcome: reason }); // RES-08
    resumeQueue.updateEntry(
      entry.id,
      { status: 'failed', attempts, lastError: reason },
      this.homedir,
    );
    this._notify('fail', entry, `auto-resume vazgeçti (${attempts} deneme): ${reason}`);
    if (this.onFail) {
      try {
        this.onFail(entry, `${reason} (${attempts} deneme)`);
      } catch {
        /* alert hook is best-effort */
      }
    }
    return 'failed';
  }

  /** Bump attempts; reschedule with exponential backoff, or FAIL after the budget. */
  _backoffOrFail(entry, reason) {
    const attempts = (Number.isInteger(entry.attempts) ? entry.attempts : 0) + 1;
    if (isExhausted(attempts)) {
      return this._fail(entry, attempts, reason);
    }
    const updated =
      resumeQueue.updateEntry(
        entry.id,
        { status: 'scheduled', attempts, lastError: reason },
        this.homedir,
      ) || { ...entry, attempts };
    this.scheduler.scheduleBackoff(updated, (e) => this.fire(e));
    return 'backoff';
  }

  /**
   * Reschedule-on-boot (ADR §6.2): re-arm a timer for every active entry left in
   * the persisted queue after an app/daemon restart. Past-due resets fire almost
   * immediately. Returns the count re-armed.
   *
   * ADP-limit (runtime scoping, spec §3.3): the queue file is SHARED between the
   * tmux daemon (scripts/resume-daemon.mjs) and the in-app pty daemon
   * (resumePtyDaemon.cjs). The optional `filter` predicate lets each daemon
   * re-arm ONLY its own runtime's entries — a core with tmux io must never fire
   * a pty record (capture would return '' → 8 blind attempts → false FAIL) and
   * vice versa. Additive: no filter → all active entries (behavior unchanged).
   */
  rescheduleOnBoot(filter) {
    // LIMIT-RESUME-02 — native kayıtlar zamanlayıcı ALMAZ (poll izler).
    let entries = resumeQueue.activeEntries(this.homedir).filter((e) => e.mode !== 'native');
    if (typeof filter === 'function') entries = entries.filter(filter);
    return this.scheduler.rescheduleAll(entries, (e) => this.fire(e), this.now());
  }

  /** Cancel all timers (shutdown). */
  stop() {
    this.scheduler.clearAll();
  }
}

module.exports = {
  ResumeDaemonCore,
  DEFAULT_VERIFY_WINDOW_MS,
  VERIFY_RETRY_DELAYS_MS,
  VERIFY_MAX_ATTEMPTS,
  DEFER_PROBE_MS, // ADP-938
  UNKNOWN_MAX_DEFER_MS, // ADP-938
  MAX_TOTAL_DEFER_MS, // ADP-938
  STALE_CLOCK_GRACE_MS, // ADP-947
  WATCHDOG_MIN_GAP_MS, // ADP-947
  PROBE_SETTLE_MS, // RES-05
  PROBE_RETRY_MS, // RES-05
  PROBE_MAX_UNKNOWN, // RES-05
  SENTINEL_GRACE_MS, // LIMIT-RESUME-02
  SENTINEL_QUIET_MS, // LIMIT-RESUME-02
  SENTINEL_MAX_NUDGES, // LIMIT-RESUME-02
  transcriptInterruptedAfter, // LIMIT-RESUME-02
  hasAssistantLineAfter, // exported for unit tests (ADP-428)
  assistantLinesAfter, // RES-02 — post-send lines + limit/content classification
  paneSignature, // RES-02 — pane buffer signature (verify's change requirement)
};

// ADP-limit (Jazz QA araştırması, 2026-07-09) — SONUÇ: bu çekirdek app-içi (node-pty)
// pane'ler için HİÇBİR yerden instantiate edilmiyor; auto-resume yalnız tmux runtime'da
// çalışıyor (scripts/resume-daemon.mjs). ADR-007 Faz-4 pty adaptörü hiç yazılmadı
// (ADP-090 numarası başka işe harcandı). Kök neden + uygulama spec'i:
// docs/agent-tasks/ADP-limit-jazz.md — pty adaptörü io-injection ile bu sınıfı AYNEN
// kullanacak; tek çekirdek-değişikliği rescheduleOnBoot(filter?) (runtime scoping).
