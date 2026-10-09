// CrewPane — Transcript verification and time formatting helpers.
'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const limitDetect = require('../limitDetect.cjs');
const { TRANSCRIPT_TAIL_BYTES } = require('./constants.cjs');

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
 * ADP-428 shape, kept for callers/tests that only need the boolean.
 */
function hasAssistantLineAfter(file, sinceMs) {
  return assistantLinesAfter(file, sinceMs).length > 0;
}

/**
 * LIMIT-RESUME-02 §6.3/4 — did the transcript record a USER interrupt after `sinceMs`?
 * Claude Code writes `[Request interrupted by user]` as a user-role line when ESC
 * (ours or a human's) cuts a running request. A "resumed" verdict is only honest
 * without one.
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

module.exports = {
  formatClock,
  formatWhen,
  assistantText,
  assistantLinesAfter,
  hasAssistantLineAfter,
  transcriptInterruptedAfter,
  paneSignature,
};
