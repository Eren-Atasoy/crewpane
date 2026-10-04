// CrewPane — ADP-087 (ADR-007 Faz 1) resume-queue state store.
//
// The SOURCE-OF-TRUTH persistence for the limit-renewal auto-resume system: a
// single JSON file at `~/.crewpane/resume-queue.json`, owned/written by the
// Electron main process (ADR §3.1 — same `~/.crewpane` dir delegationBridge
// already uses, ADR-004 precedent). Chosen over Supabase (no migration, no
// network, survives app restart) and over in-memory (lost on restart).
//
// This module is PURE-ish: every fn takes an optional `homedir` so it is unit
// testable against a tmp dir (resumeQueue.test.cjs) with no Electron. It only
// stores/loads records — it does NOT detect limits (terminalActivity.detectLimit)
// and does NOT schedule or trigger resume (ADP-088). Behavior of running agents
// is unchanged; this is invisible foundation.
//
// Atomic write: tmp-file + rename so a crash mid-write never leaves a half JSON.

'use strict';

const os = require('node:os');
const fs = require('node:fs');
// ADP-835 (790 K1) — atomik yazımın rename adımı platform boğazından geçer:
// Windows'ta Defender/Search hedefi açık tutunca EPERM/EBUSY gelir ve bu çağrıların
// çoğu best-effort catch içinde OLDUĞU İÇİN kayıt SESSİZCE kaybolurdu.
const { renameWithRetrySync } = require('../../platform/atomicWrite.cjs');
const path = require('node:path');
const crypto = require('node:crypto');
const instancePaths = require('../config/instancePaths.cjs'); // ADP-206 — instance-scoped config dir

const QUEUE_VERSION = 1;
// Lifecycle (ADR §3.2). Active = not yet finished; terminal = prunable.
const VALID_STATUS = Object.freeze([
  'scheduled', // captured, waiting for resetAt (the only status ADP-087 writes)
  'resuming', // --resume fired (ADP-088)
  'verifying', // post-resume verify window (ADP-089)
  'resumed', // confirmed back to work (terminal-ok)
  'failed', // gave up after backoff (terminal-fail)
]);
const ACTIVE_STATUS = Object.freeze(['scheduled', 'resuming', 'verifying']);

/** Per-instance config dir (ADP-206): PROD ~/.crewpane, DEV ~/.crewpane-dev. */
function crewpaneDir(homedir) {
  return instancePaths.crewpaneHome(homedir);
}

/** Absolute path of the resume-queue JSON. */
function queuePath(homedir) {
  return path.join(crewpaneDir(homedir), 'resume-queue.json');
}

function emptyQueue() {
  return { version: QUEUE_VERSION, entries: [] };
}

/** True for a status that is not yet terminal (still awaiting/processing). */
function isActiveStatus(status) {
  return ACTIVE_STATUS.includes(status);
}

/**
 * Load the queue. Missing / corrupt / wrong-shape file → a fresh empty queue
 * (never throws — a bad file must not crash spawn). Version is normalized.
 */
function loadQueue(homedir) {
  try {
    const raw = fs.readFileSync(queuePath(homedir), 'utf8');
    const q = JSON.parse(raw);
    if (!q || typeof q !== 'object' || !Array.isArray(q.entries)) return emptyQueue();
    return { version: QUEUE_VERSION, entries: q.entries };
  } catch {
    return emptyQueue();
  }
}

/**
 * Atomically persist the queue (tmp + rename, same dir → same filesystem so the
 * rename is atomic). Creates ~/.crewpane if needed. Returns the file path.
 */
function persist(queue, homedir) {
  const dir = crewpaneDir(homedir);
  fs.mkdirSync(dir, { recursive: true });
  const file = queuePath(homedir);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  const data = JSON.stringify(
    { version: QUEUE_VERSION, entries: Array.isArray(queue.entries) ? queue.entries : [] },
    null,
    2,
  );
  fs.writeFileSync(tmp, data);
  renameWithRetrySync(tmp, file);
  return file;
}

/**
 * Shape a raw capture into a full queue entry (ADR §3.2 schema). Pure: defaults
 * applied, types coerced; an unknown status falls back to 'scheduled'.
 */
function buildEntry(input, now) {
  const i = input && typeof input === 'object' ? input : {};
  const detectedAt = Number.isFinite(i.detectedAt)
    ? i.detectedAt
    : Number.isFinite(now)
      ? now
      : Date.now();
  return {
    id: typeof i.id === 'string' && i.id ? i.id : makeEntryId(detectedAt),
    runtime: i.runtime === 'pty' ? 'pty' : 'tmux',
    paneRef: typeof i.paneRef === 'string' ? i.paneRef : null,
    agentId: typeof i.agentId === 'string' ? i.agentId : null,
    taskId: typeof i.taskId === 'string' ? i.taskId : null,
    engine: i.engine === 'codex' ? 'codex' : 'claude',
    cwd: typeof i.cwd === 'string' ? i.cwd : null,
    sessionId: typeof i.sessionId === 'string' ? i.sessionId : null,
    detectedAt,
    resetAt: Number.isFinite(i.resetAt) ? i.resetAt : null,
    resetRaw: typeof i.resetRaw === 'string' ? i.resetRaw : null,
    // RES-08 — resetAt NEREDEN geldi: 'clock' | 'clock-local' | 'rel' | 'reread' |
    // 'unknown'. RES-03'ün ölçüm hedefi ("saat okunabildi mi?" oranı ≥ %90, taban %0)
    // ancak kaynağı kaydedersek sayılabilir; ayrıca rozet (RES-07) "reset okunamadı"
    // metnini bu alandan değil `resetAt`in kendisinden türetir — bu alan ÖLÇÜM içindir.
    resetSource: typeof i.resetSource === 'string' ? i.resetSource : 'unknown',
    // RES-04 (D3) — WHEN we concluded "the reset already happened", written ONCE.
    // This used to be smuggled into `resetAt` as `now`, which re-armed the timer on
    // every 5-second poll and starved the send forever (MEASURED: 540 re-arms, 0
    // sends over the 50 minutes around a reset). A fact about the PAST belongs in
    // its own field; `resetAt` stays the instant we were actually shown.
    resetPassedAt: Number.isFinite(i.resetPassedAt) ? i.resetPassedAt : null,
    attempts: Number.isInteger(i.attempts) ? i.attempts : 0,
    status: VALID_STATUS.includes(i.status) ? i.status : 'scheduled',
    lastError: typeof i.lastError === 'string' ? i.lastError : null,
    // ADP-428 — when the last resume send fired (epoch ms). Post-send verification
    // compares assistant-activity evidence (transcript mtime) against this instant.
    firedAt: Number.isFinite(i.firedAt) ? i.firedAt : null,
    // RES-02 (D7) — pane-buffer signature AT the moment of the send. Verification
    // demands the buffer moved since then, so a frozen screen (nothing happened)
    // can no longer pass as "the agent is working".
    firedSig: typeof i.firedSig === 'string' ? i.firedSig : null,
    // LIMIT-RESUME-02 — 'native': the engine (claude ≥ 2.1.270) auto-continues ITSELF;
    // the daemon arms NO timer and never fires this record, it only watches (sentinel).
    // 'legacy' (default): the ADP-088/089 detect→schedule→fire→verify machine.
    mode: i.mode === 'native' ? 'native' : 'legacy',
    // LIMIT-RESUME-02 — the sentinel's ONE nudge (Enter / "devam et" / menu select):
    // when, which band it answered, how many so far (bounded, never a blind chain).
    sentinelAt: Number.isFinite(i.sentinelAt) ? i.sentinelAt : null,
    sentinelPhase: typeof i.sentinelPhase === 'string' ? i.sentinelPhase : null,
    sentinelCount: Number.isInteger(i.sentinelCount) ? i.sentinelCount : 0,
  };
}

/** Queue-record id: stable, sortable, collision-resistant (ADR §3.2 `rq-…`). */
function makeEntryId(detectedAt) {
  const ts = Number.isFinite(detectedAt) ? detectedAt : Date.now();
  return `rq-${ts}-${crypto.randomBytes(2).toString('hex')}`;
}

/**
 * Record a detected limit. Idempotent (ADR §2.4 / §7): at most ONE active record
 * per agentId — a second limit tick for an agent already queued UPDATES that
 * record's reset fields instead of adding a duplicate. Returns
 * `{ entry, deduped, changed }`:
 *   • deduped=true  → an existing active record for this agentId was reused
 *   • changed=true  → the SCHEDULE moved (new entry, or resetAt went FORWARD)
 *
 * RES-04 (D3) — `changed` is the signal the daemon re-arms its timer on, so it
 * must mean "the moment we are waiting for MOVED", not "we looked again". The old
 * rule (`resetAt/resetRaw differ`) said changed on every single poll as soon as
 * anything wrote a `now`-ish resetAt, and a 5-second poll re-armed a 90-second
 * timer forever: MEASURED 540 re-arms and ZERO sends across a reset. Only a reset
 * instant that moves FORWARD is a new schedule; a repeat, a downgrade to null, or
 * a value pulled back toward `now` leaves the armed timer alone.
 *
 * `detectedAt` is likewise written ONCE (first capture wins): every deferral
 * ceiling is measured from it, so refreshing it made those ceilings unreachable.
 */
function captureLimit(input, homedir) {
  const q = loadQueue(homedir);
  const entry = buildEntry(input);

  if (entry.agentId) {
    const existing = q.entries.find(
      (e) => e.agentId === entry.agentId && isActiveStatus(e.status),
    );
    if (existing) {
      const moved =
        Number.isFinite(entry.resetAt) &&
        (!Number.isFinite(existing.resetAt) || entry.resetAt > existing.resetAt);
      if (moved) {
        existing.resetAt = entry.resetAt;
        existing.resetRaw = entry.resetRaw;
        existing.resetSource = entry.resetSource; // RES-08 — kaynak saatle BİRLİKTE taşınır
      } else if (entry.resetRaw && !existing.resetRaw) {
        existing.resetRaw = entry.resetRaw; // görünürlük; zamanlamayı DEĞİŞTİRMEZ
      }
      // RES-04 — "reset already happened" is recorded once and never re-stamped.
      if (Number.isFinite(entry.resetPassedAt) && !Number.isFinite(existing.resetPassedAt)) {
        existing.resetPassedAt = entry.resetPassedAt;
      }
      if (entry.sessionId) existing.sessionId = entry.sessionId;
      if (entry.taskId) existing.taskId = entry.taskId;
      if (entry.paneRef) existing.paneRef = entry.paneRef;
      persist(q, homedir);
      return { entry: existing, deduped: true, changed: moved };
    }
  }

  q.entries.push(entry);
  persist(q, homedir);
  return { entry, deduped: false, changed: true };
}

const UPDATABLE_FIELDS = Object.freeze([
  'status',
  'attempts',
  'lastError',
  'resetAt',
  'resetRaw',
  'resetSource', // RES-08
  'resetPassedAt', // RES-04
  'sessionId',
  'paneRef',
  // HATA-12-B — kaydın motoru DEĞİŞEBİLİR: pane limitte düştükten sonra kullanıcı
  // ajanın motorunu değiştirirse daemon pane'i YENİ motorla açar. Kayıt eski motoru
  // söylemeye devam ederse `verify()` yanlış motorun TUI işaretlerini arar ve çalışan
  // bir pane "devam doğrulanamadı" sayılır (e2e'de ölçüldü). Kimlik `agentId`dir,
  // motor değil.
  'engine',
  'firedAt', // ADP-428 — post-send verification anchor
  'firedSig', // RES-02 — pane buffer signature at send time
  'mode', // LIMIT-RESUME-02 — 'native' | 'legacy'
  'sentinelAt', // LIMIT-RESUME-02
  'sentinelPhase', // LIMIT-RESUME-02
  'sentinelCount', // LIMIT-RESUME-02
]);

/**
 * Patch an entry by id (status/attempts/lastError/resetAt/…). Returns the updated
 * entry, or null if no such id. Unknown keys and an invalid status are ignored.
 */
function updateEntry(id, patch, homedir) {
  const q = loadQueue(homedir);
  const e = q.entries.find((x) => x.id === id);
  if (!e) return null;
  const p = patch && typeof patch === 'object' ? patch : {};
  for (const k of UPDATABLE_FIELDS) {
    if (!(k in p)) continue;
    if (k === 'status' && !VALID_STATUS.includes(p[k])) continue;
    e[k] = p[k];
  }
  persist(q, homedir);
  return e;
}

/** Remove an entry by id. Returns true if one was removed. */
function removeEntry(id, homedir) {
  const q = loadQueue(homedir);
  const before = q.entries.length;
  q.entries = q.entries.filter((e) => e.id !== id);
  if (q.entries.length === before) return false;
  persist(q, homedir);
  return true;
}

/** Drop terminal (resumed/failed) entries so the queue does not grow forever (§7). */
function pruneTerminal(homedir) {
  const q = loadQueue(homedir);
  const before = q.entries.length;
  q.entries = q.entries.filter((e) => isActiveStatus(e.status));
  const removed = before - q.entries.length;
  if (removed > 0) persist(q, homedir);
  return removed;
}

/** All currently-active (scheduled/resuming/verifying) entries. */
function activeEntries(homedir) {
  return loadQueue(homedir).entries.filter((e) => isActiveStatus(e.status));
}

module.exports = {
  QUEUE_VERSION,
  VALID_STATUS,
  ACTIVE_STATUS,
  crewpaneDir,
  queuePath,
  emptyQueue,
  isActiveStatus,
  loadQueue,
  persist,
  buildEntry,
  makeEntryId,
  captureLimit,
  updateEntry,
  removeEntry,
  pruneTerminal,
  activeEntries,
};
