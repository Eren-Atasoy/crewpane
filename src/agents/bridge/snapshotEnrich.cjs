'use strict';

const OSC_PATTERN = new RegExp('\\x1b\\][\\s\\S]*?(?:\\x07|\\x1b\\\\)', 'g');
const ANSI_PATTERN = new RegExp(
  '[\\x1b\\x9b][[\\]()#;?]*(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]',
  'g',
);
const DEFAULT_TAIL_LINES = 14;

/** Strip ANSI/OSC escape noise so the leader reads plain text. */
function stripAnsi(input) {
  return typeof input === 'string' ? input.replace(OSC_PATTERN, '').replace(ANSI_PATTERN, '') : '';
}

/** Last `maxLines` non-blank, ANSI-free lines of a pane tail (what the leader reads). */
function cleanPaneTail(input, maxLines = DEFAULT_TAIL_LINES) {
  const lines = stripAnsi(input)
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t]+$/, ''))
    .filter((l) => l.trim().length > 0);
  return lines.slice(-Math.max(1, maxLines)).join('\n');
}

// The SAME specific transient-error signatures the engine (delegation.ts) classifies on, so a
// LIVE (not-yet-terminal) pane showing an API error is flagged even before the engine settles it.
const API_ERROR_SIGNATURES = [
  /overloaded(?:_error)?\b|\b529\b/i,
  /rate[_ ]?limit(?:_error)?\b|rate limit (?:reached|exceeded|hit)/i,
  /api[_ ]?error\b/i,
  /internal[ _]server[ _]error|\b500 internal\b/i,
  /service[ _]unavailable|\b503 service\b/i,
  /bad gateway|\b502 bad\b/i,
  /request timed out|request_timeout|\bETIMEDOUT\b/i,
  /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang ?up|fetch failed|network error|connection error\b/i,
  /authentication_error|invalid x-api-key|\b401 unauthorized\b/i,
  /credit balance is too low|insufficient_quota/i,
  /usage limit|session limit|\d+-?\s*hour limit|limit (?:reached|exceeded)/i,
];

/** True when a pane tail shows a transient engine/API error (re-dispatchable, not a work failure). */
function paneHasApiError(input) {
  const t = stripAnsi(input);
  if (!t) return false;
  return API_ERROR_SIGNATURES.some((re) => re.test(t));
}

/**
 * Enrich a delegation status snapshot (one object or an array) for the LEADER: clean each
 * subtask's `output` to readable lines and set `apiError` (engine flag OR a live-detected
 * error on a still-running pane).
 */
function enrichDelegationSnapshot(snapshot) {
  if (!snapshot) return snapshot;
  const enrichOne = (d) => {
    if (!d || typeof d !== 'object' || !Array.isArray(d.subtasks)) return d;
    return {
      ...d,
      subtasks: d.subtasks.map((s) => {
        if (!s || typeof s !== 'object') return s;
        const apiError = s.apiError === true || (s.status !== 'done' && paneHasApiError(s.output));
        return { ...s, apiError, output: cleanPaneTail(s.output) };
      }),
    };
  };
  return Array.isArray(snapshot) ? snapshot.map(enrichOne) : enrichOne(snapshot);
}

module.exports = {
  stripAnsi,
  cleanPaneTail,
  paneHasApiError,
  enrichDelegationSnapshot,
};
