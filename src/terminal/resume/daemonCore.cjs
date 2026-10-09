// CrewPane — ResumeDaemonCore class implementation.
'use strict';

const resumeQueue = require('../resumeQueue.cjs');
const resumeTmux = require('../resumeTmux.cjs');
const resumeNotify = require('../resumeNotify.cjs');
const resumePaneRegistry = require('../resumePaneRegistry.cjs');
const { ResumeScheduler } = require('../resumeScheduler.cjs');
const {
  DEFAULT_VERIFY_WINDOW_MS,
  VERIFY_RETRY_DELAYS_MS,
  VERIFY_MAX_ATTEMPTS,
  PROBE_SETTLE_MS,
  PROBE_RETRY_MS,
  PROBE_MAX_UNKNOWN,
  SENTINEL_GRACE_MS,
  SENTINEL_QUIET_MS,
} = require('./constants.cjs');

const observeHandler = require('./observeHandler.cjs');
const fireHandler = require('./fireHandler.cjs');
const verifyHandler = require('./verifyHandler.cjs');

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
    // ADP-938 (ADR Faz 3) — LİMİTTE OTOMATİK HESAP GEÇİŞİ.
    this.autoSwitch = cfg.autoSwitch && typeof cfg.autoSwitch.trySwitch === 'function' ? cfg.autoSwitch : null;
    this.scheduler =
      cfg.scheduler || new ResumeScheduler(undefined, { resetBufferMs: cfg.resetBufferMs });
    const io = cfg.io || {};
    this.capturePane = io.capturePane || ((ref) => resumeTmux.capturePane(ref));
    // ADP-180 — forward opts (so fire() can pass the resolved {liveness}).
    this.sendResume = io.sendResume || ((entry, opts) => resumeTmux.sendResume(entry, opts));
    this.selectOption = io.selectOption || ((ref, n) => resumeTmux.selectOption(ref, n));
    this.liveness =
      io.liveness || ((entry, text) => resumeTmux.paneLiveness(entry && entry.paneRef, text));
    this.resolveSessionId =
      io.resolveSessionId ||
      ((entry, now) => resumeTmux.resolveSessionIdFromJsonl(entry.cwd, this.homedir, { now }));
    this.lookupPane = io.lookupPane || ((ref) => resumePaneRegistry.lookupPane(ref, this.homedir));
    // ADP-428 — post-send SUCCESS evidence: did the assistant actually produce output after our send?
    this.activityEvidence =
      io.activityEvidence || ((entry, sinceMs, text) => this._activityEvidence(entry, sinceMs, text));
    this.now = io.now || (() => Date.now());
    /** verify timers are keyed off the entry id with this suffix (separate from the fire timer). */
    this._verifySuffix = ':verify';
    /** ADP-098: paneRef → last handled prompt signature. */
    this._promptSelected = new Map();
    /** ADP-947: entryId → last poll-driven watchdog fire. */
    this._watchdog = new Map();

    // ── RES-05 — sıfır-token ön-yoklama ───────────────────────────────────
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
    this.nativeContinue = typeof cfg.nativeContinue === 'function' ? cfg.nativeContinue : null;
    this.pressEnter = typeof io.pressEnter === 'function' ? io.pressEnter : null;
    this.sentinelGraceMs = Number.isFinite(cfg.sentinelGraceMs) ? cfg.sentinelGraceMs : SENTINEL_GRACE_MS;
    this.sentinelQuietMs = Number.isFinite(cfg.sentinelQuietMs) ? cfg.sentinelQuietMs : SENTINEL_QUIET_MS;
    /** paneRef → {sig, changedAt}: "pane son N dk çıktı üretti mi?" ölçümü. */
    this._pane = new Map();
    /** entryId → son transcript bakışı (stat ucuz ama her 5 sn değil). */
    this._external = new Map();
    /** paneRef → son bildirilen native durum imzası. */
    this._nativeSaid = new Map();
    /** agentId'ler: aktif native kaydı olanlar. */
    this._nativeWatch = new Set();
    if (this.nativeContinue) {
      try {
        for (const e of resumeQueue.activeEntries(this.homedir)) {
          if (e.mode === 'native' && e.agentId) this._nativeWatch.add(e.agentId);
        }
      } catch { /* kuyruk yoksa boş */ }
    }

    // ── RES-07 — GÖRÜNÜRLÜK: yaşam döngüsü olayları renderer'a ────────────
    this.onEvent = typeof cfg.onEvent === 'function' ? cfg.onEvent : null;
    // ── RES-08 — telemetri yazıcısı
    this.telemetry = typeof cfg.telemetry === 'function' ? cfg.telemetry : null;
  }

  /**
   * RES-07 — bir yaşam döngüsü olayını renderer'a köprüle.
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

  /** RES-08 — tek bir yapılandırılmış olay satırı. */
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
   * RES-07 — rozetin okuyacağı durum.
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
   * Merge a pane's authoritative registry identity over the raw poll `meta`.
   */
  _identity(meta) {
    const info = this.lookupPane(meta.paneRef) || null;
    return {
      ...meta,
      engine: (info && info.engine) || meta.engine || 'claude',
      agentId: (info && info.agentId) || meta.agentId || meta.paneRef || null,
      sessionId: (info && info.sessionId) || meta.sessionId || null,
      cwd: (info && info.cwd) || meta.cwd || null,
      engineProfileId: (info && info.engineProfileId) || meta.engineProfileId || null,
    };
  }

  /**
   * Reschedule-on-boot (ADR §6.2): re-arm a timer for every active entry left in
   * the persisted queue after an app/daemon restart.
   */
  rescheduleOnBoot(filter) {
    let entries = resumeQueue.activeEntries(this.homedir).filter((e) => e.mode !== 'native');
    if (typeof filter === 'function') entries = entries.filter(filter);
    return this.scheduler.rescheduleAll(entries, (e) => this.fire(e), this.now());
  }

  /** Cancel all timers (shutdown). */
  stop() {
    this.scheduler.clearAll();
  }
}

// Attach modular handlers to ResumeDaemonCore prototype
Object.assign(ResumeDaemonCore.prototype, observeHandler, fireHandler, verifyHandler);

module.exports = {
  ResumeDaemonCore,
};
