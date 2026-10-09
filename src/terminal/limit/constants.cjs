// CrewPane — Terminal Limit Detection Constants and ANSI Stripping.
'use strict';

const OSC_PATTERN = new RegExp('\\x1b\\][\\s\\S]*?(?:\\x07|\\x1b\\\\)', 'g');
const ANSI_PATTERN = new RegExp(
  '[\\x1b\\x9b][[\\]()#;?]*(?:\\d{1,4}(?:;\\d{0,4})*)?[\\x20-\\x2f]*[\\dA-PR-TZcf-nq-uy=><~]',
  'g',
);

/** Remove ANSI/OSC escape noise so the limit regex sees plain text. */
function stripAnsi(input) {
  if (typeof input !== 'string') return '';
  return input.replace(OSC_PATTERN, '').replace(ANSI_PATTERN, '');
}

const ANSI_ROBUST_PATTERN = new RegExp(
  '[\\x1b\\x9b][[\\]()#;?]*(?:\\d{1,4}(?:;\\d{0,4})*)?[\\x20-\\x2f]*[\\x40-\\x7e]',
  'g',
);

/** stripAnsi for the ROBUST layer: also eats ConPTY finals (X/b/@/…). */
function stripAnsiRobust(input) {
  if (typeof input !== 'string') return '';
  return input.replace(OSC_PATTERN, '').replace(ANSI_ROBUST_PATTERN, '');
}

const LIMIT_HIT = new RegExp(
  "(?:usage|session|rate|\\d+-?\\s*hour)\\s*limit|limit\\s*(?:reached|exceeded)|you'?ve\\s+hit\\s+your\\s+(?:session|usage)\\s+limit|(?:daily\\s+)?quota\\s*(?:exceeded|exhausted)|exhausted\\s+your\\s+(?:daily\\s+)?quota|exceeded\\s+your\\s+(?:current\\s+)?quota",
  'i',
);
const RESET_CLOCK = /resets?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*([ap]m)?/i;
const RESET_CLOCK_ALL = new RegExp(RESET_CLOCK.source, 'gi');
const RESET_REL = /(?:try\s+again|resets?)\s+in\s+(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?/i;

const RESET_ABS =
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\s+(?:at\s+)?(\d{1,2}):(\d{2})\s*([ap]m)\b/i;
const MONTHS3 = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const RESET_MONTHDAY =
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)\b/i;
const CONTINUE_AT = /continu(?:e|ing)\s+automatically\s+at\s+/i;

const NATIVE_ARMED = new RegExp(
  '^(?:usage\\s+limit\\s+reached\\s*[·•∙-]\\s*continuing\\s+(?:automatically|shortly)|claude\\s+code\\s+will\\s+continue\\s+automatically)',
  'i',
);
const NATIVE_STALE = /^(?:your\s+)?(?:claude\.ai\s+)?usage\s+limit\s+has\s+reset\b/i;
const NATIVE_CANCELLED = new RegExp(
  '^(?:automatic\\s+continue\\s+(?:cancelled|stopped)|(?:this\\s+task|the\\s+usage\\s+limit\\s+now\\s+resets)[^.]{0,80}will\\s+not\\s+resume\\s+on\\s+its\\s+own)',
  'i',
);
const NATIVE_AGAIN = /^usage\s+limit\s+reached\s+again\s+after\s+you\s+continued/i;

const MAX_DATED_RESET_AHEAD_MS = 8 * 24 * 60 * 60_000;
const MAX_RESET_AHEAD_MS = 24 * 60 * 60_000 + 60_000;

const TAIL_LINES = 14;
const ANCHOR_LINES = 6;
const RESET_SCAN_LINES = 80;
const LAST_FRAME_LINES = 6;

const BRAILLE_SPINNER = /[⠀-⣿]/;
const WORK_GLYPH_WORD = /[✻✽✶✳✢∗]\s*\w+[…]/;

const LEAD_NOISE = "^[\\s>│|*•▌▏◆●·∙■▪▫□\\-]*";
const LIMIT_LINE = new RegExp(
  LEAD_NOISE +
    '(?:' +
    "claude (?:ai )?usage limit reached|" +
    "you'?ve (?:reached|hit) your (?:\\d+-?\\s*hour |session |usage |5-?hour |weekly )*(?:message |usage )?limit|" +
    "(?:\\d+-?\\s*hour|usage|session|weekly|rate|message) limit (?:reached|exceeded|resets?)|" +
    "(?:\\d+-?\\s*hour) limit resets|" +
    "you'?re out of (?:extra )?usage|" +
    "out of (?:extra )?usage(?:\\s*[·∙•-]|\\s+resets?)" +
    ')',
  'i',
);

const OPTION_LINE = /^[\s│|❯›»>►▶○●◆◇▪▫•*\-]*\s*(\d)[.)]\s+(\S.*)$/;
const SLASH_LIMIT_MARKER = /\/rate-?limit-?options|\/upgrade\b/i;
const PROMPT_QUESTION = /\b(?:what|how)\b.{0,40}\b(?:do|would|to)\b.{0,30}\b(?:do|proceed|continue)\b/i;

const UNICODE_COLONS = /[∶：︓﹕꞉]/g;
const RESET_TZ = /\(([A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+)\)/;

module.exports = {
  stripAnsi,
  stripAnsiRobust,
  LIMIT_HIT,
  RESET_CLOCK,
  RESET_CLOCK_ALL,
  RESET_REL,
  RESET_ABS,
  MONTHS3,
  RESET_MONTHDAY,
  CONTINUE_AT,
  NATIVE_ARMED,
  NATIVE_STALE,
  NATIVE_CANCELLED,
  NATIVE_AGAIN,
  MAX_DATED_RESET_AHEAD_MS,
  MAX_RESET_AHEAD_MS,
  TAIL_LINES,
  ANCHOR_LINES,
  RESET_SCAN_LINES,
  LAST_FRAME_LINES,
  BRAILLE_SPINNER,
  WORK_GLYPH_WORD,
  LEAD_NOISE,
  LIMIT_LINE,
  OPTION_LINE,
  SLASH_LIMIT_MARKER,
  PROMPT_QUESTION,
  UNICODE_COLONS,
  RESET_TZ,
};
