// CrewPane — ADP-475 (P0) crash instrumentation + recovery core.
//
// Eren's report: the app died twice, silently, DURING A HEAVY BUILD in a pane
// (no log line at all). Two separate failure classes look the same from the
// outside ("app just isn't there anymore") but need different evidence + fixes:
//
//   (1) RENDERER dies but the main process survives — Chromium's renderer
//       crashed/OOM'd or was killed. Electron fires `render-process-gone` on
//       that window's webContents. Before this module the handler only logged
//       one line and left the window dead (blank/frozen forever) — from
//       Eren's chair that reads as "the app crashed", not "recovered".
//   (2) The WHOLE PROCESS TREE dies — macOS jetsam (memory-pressure SIGKILL)
//       or a hard native crash. SIGKILL is not catchable, so NOTHING running
//       inside the process — not even our own crash handler — gets to run.
//       The only way to leave evidence for (2) is a log line written to disk
//       (fs.appendFileSync — synchronous) BEFORE the kill happens: a periodic
//       memory/throughput heartbeat, not a reactive handler.
//
// This module is the PURE decision core for both — no Electron/fs imports —
// so the policy (when to reload, when to warn) is unit-testable without a
// real BrowserWindow or a real 30-second wait. main.js wires it to real
// timers/webContents/logLine (same seam style as resumeScheduler.cjs).

'use strict';

// ---------------------------------------------------------------------------
// (1) render-process-gone recovery policy
// ---------------------------------------------------------------------------

// A window that dies and reloads MAX_RELOADS times within RELOAD_WINDOW_MS is
// crash-looping (e.g. a corrupt bundle that crashes on every load) — reloading
// forever would spin CPU/battery for no benefit. Give up after that many and
// let the window sit dead (still logged loudly) rather than loop silently.
const RELOAD_WINDOW_MS = 5 * 60_000;
const MAX_RELOADS = 4;

// Electron's `details.reason` on render-process-gone. 'clean-exit' is a
// deliberate window.close()/app.quit() path — never reload that. Everything
// else ('crashed', 'oom', 'killed', 'launch-failed', 'integrity-failure') is
// an unplanned death and is what ADP-475 is about.
const CLEAN_EXIT_REASONS = new Set(['clean-exit']);

function isRecoverableGone(reason) {
  return !CLEAN_EXIT_REASONS.has(reason);
}

/**
 * Decide whether a dead renderer should be reloaded, given the window's own
 * reload-timestamp history (oldest→newest, caller-owned array). Pure: takes
 * `now` explicitly so tests don't wait on real timers.
 *
 * Returns { reload: boolean, history: number[] } — `history` is the NEW
 * array to store (pruned to the window + this attempt appended iff reloading);
 * caller replaces its stored history with the returned one.
 */
function decideReload(history, now, opts) {
  const windowMs = (opts && opts.windowMs) || RELOAD_WINDOW_MS;
  const maxReloads = (opts && opts.maxReloads) || MAX_RELOADS;
  const recent = (Array.isArray(history) ? history : []).filter((t) => now - t < windowMs);
  if (recent.length >= maxReloads) {
    return { reload: false, history: recent };
  }
  return { reload: true, history: [...recent, now] };
}

// ---------------------------------------------------------------------------
// (2) memory/throughput heartbeat — the evidence a SIGKILL can't erase
// ---------------------------------------------------------------------------

// macOS jetsam pressure kicks in well before "no RAM left"; a sustained
// multi-hundred-MB working set for an Electron dev tool is already unusual.
// These are WARN thresholds for the heartbeat log, not hard caps — nothing in
// this module kills or throttles anything; it only makes the trend visible in
// a durable (fs.appendFileSync'd) line before any OS-level kill can happen.
const RSS_WARN_BYTES = 1.5 * 1024 ** 3; // 1.5 GB combined (main + all children)
const RSS_GROWTH_WARN_BYTES = 400 * 1024 ** 2; // +400MB since the previous tick
// A pane sustaining this much pty output per second is a "heavy build" burst
// worth naming explicitly in the log so a post-mortem can correlate it with
// the memory trend (ADP-475's actual trigger: "ağır build sırasında").
const PANE_BURST_BYTES_PER_SEC = 200 * 1024;

function sumWorkingSet(appMetrics) {
  return (Array.isArray(appMetrics) ? appMetrics : []).reduce(
    (acc, p) => acc + (p && p.memory && Number.isFinite(p.memory.workingSetSize) ? p.memory.workingSetSize * 1024 : 0),
    0,
  );
}

/**
 * One heartbeat tick's verdict. `sample` = { memUsage: process.memoryUsage(),
 * appMetrics: app.getAppMetrics() }. `prevTotalBytes` = combined working set
 * from the previous tick (null on the first tick). Pure — no I/O.
 */
function assessMemory(sample, prevTotalBytes) {
  const totalBytes = sumWorkingSet(sample && sample.appMetrics);
  const growth = Number.isFinite(prevTotalBytes) ? totalBytes - prevTotalBytes : 0;
  const reasons = [];
  if (totalBytes >= RSS_WARN_BYTES) reasons.push(`combined-working-set ${(totalBytes / 1024 ** 2).toFixed(0)}MB ≥ ${(RSS_WARN_BYTES / 1024 ** 2).toFixed(0)}MB`);
  if (growth >= RSS_GROWTH_WARN_BYTES) reasons.push(`+${(growth / 1024 ** 2).toFixed(0)}MB since last tick`);
  return { totalBytes, growth, level: reasons.length ? 'warn' : 'ok', reasons };
}

/**
 * Per-pane throughput since the previous tick. `prevBytes`/`currBytes` are
 * Maps (or plain objects) of paneId → cumulative byte count (the `entry.bytes`
 * counter main.js already keeps per pane). `dtMs` is the real elapsed time
 * between ticks (NOT assumed to be exactly the configured interval — a busy
 * event loop can delay a tick).
 */
function paneThroughput(prevBytes, currBytes, dtMs) {
  if (!(dtMs > 0)) return [];
  const prev = prevBytes instanceof Map ? prevBytes : new Map(Object.entries(prevBytes || {}));
  const curr = currBytes instanceof Map ? currBytes : new Map(Object.entries(currBytes || {}));
  const out = [];
  for (const [paneId, bytes] of curr) {
    const before = prev.has(paneId) ? prev.get(paneId) : bytes; // new pane: no burst on first tick
    const delta = Math.max(0, bytes - before);
    const bytesPerSec = (delta / dtMs) * 1000;
    out.push({ paneId, bytesPerSec, burst: bytesPerSec >= PANE_BURST_BYTES_PER_SEC });
  }
  return out;
}

/**
 * ADP-727 — SÜREÇ TÜRÜNE GÖRE KIRILIM. Eski heartbeat yalnız `main-rss` ve
 * `all-processes` yazıyordu; Eren'in 15 saatlik logunda toplam 1,1 GB'dan 5,6 GB'a
 * çıkmış ama HANGİ sürecin şiştiği (renderer mı, gpu mu, utility mi) log'dan
 * ANLAŞILAMIYOR — teşhis `ps`'e mahkûm kalıyordu. appMetrics zaten `type` taşıyor;
 * tek yapılması gereken toplamayı türe göre yapmaktı.
 */
function memoryByType(appMetrics) {
  const out = {};
  if (!Array.isArray(appMetrics)) return out;
  for (const m of appMetrics) {
    const kb = m && m.memory && Number.isFinite(m.memory.workingSetSize) ? m.memory.workingSetSize : 0;
    const type = (m && m.type) || 'unknown';
    out[type] = (out[type] || 0) + kb * 1024;
  }
  return out;
}

/** Human-readable heartbeat line for logLine(). Never throws on odd input. */
function formatHeartbeat({ memUsage, assessment, panes, appMetrics, at }) {
  const rssMB = memUsage && Number.isFinite(memUsage.rss) ? (memUsage.rss / 1024 ** 2).toFixed(0) : '?';
  const totalMB = (assessment.totalBytes / 1024 ** 2).toFixed(0);
  const bursts = (panes || []).filter((p) => p.burst);
  const byType = memoryByType(appMetrics);
  const typeStr = Object.entries(byType)
    .sort((a, b) => b[1] - a[1])
    .map(([t, b]) => `${t}=${(b / 1024 ** 2).toFixed(0)}MB`)
    .join(' ');
  const parts = [
    // ADP-727 — ZAMAN DAMGASI. Damgasız satırlarda büyüme HIZI hesaplanamıyordu
    // (tick aralığı 30 sn ile 5 sn arasında sessizce değişiyor: warn'da her tick
    // yazılıyor) → "saatte kaç MB" sorusu logdan cevaplanamıyordu.
    `[watchdog ${at || new Date().toISOString()}] main-rss=${rssMB}MB all-processes=${totalMB}MB`,
    typeStr ? `by-type: ${typeStr}` : null,
    assessment.level === 'warn' ? `⚠️ ${assessment.reasons.join('; ')}` : null,
    bursts.length
      ? `heavy-output: ${bursts.map((b) => `${b.paneId}=${(b.bytesPerSec / 1024).toFixed(0)}KB/s`).join(', ')}`
      : null,
  ].filter(Boolean);
  return parts.join(' — ');
}

module.exports = {
  RELOAD_WINDOW_MS,
  MAX_RELOADS,
  CLEAN_EXIT_REASONS,
  isRecoverableGone,
  decideReload,
  RSS_WARN_BYTES,
  RSS_GROWTH_WARN_BYTES,
  PANE_BURST_BYTES_PER_SEC,
  sumWorkingSet,
  assessMemory,
  paneThroughput,
  formatHeartbeat,
  memoryByType,
};
