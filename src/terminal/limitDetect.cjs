// CrewPane — ADP-088 (ADR-007 Faz 2) limit detection (CJS parity port).
//
// WHY a port: the canonical detector lives in src/app/lib/terminalActivity.ts
// (renderer-side TS, used by the bubble pipeline). The resume daemon and Electron
// main are CJS/Node and cannot require that ESM/TS module (separate module graph
// — ADP-087 devir note #2). Rather than bundle a TS file into a daemon, this is a
// byte-for-byte port of detectLimit/parseResetAt. The drift risk is locked down
// by limitDetect.test.cjs running the SAME POC fixture matrix terminalActivity's
// tests use (the ADR §9 / ADP-087 parity matrix).
//
// PURE: string in → signal/epoch out. No IO, no Electron, no side effects.

'use strict';

// Byte-for-byte the patterns terminalActivity.stripAnsi uses (OSC then CSI/ESC).
// Built via `new RegExp` with explicit \xNN escapes so the source stays plain.
const OSC_PATTERN = new RegExp('\\x1b\\][\\s\\S]*?(?:\\x07|\\x1b\\\\)', 'g');
// ENG-01 — INTERMEDIATE BYTES (0x20-0x2F). ECMA-48 puts an optional intermediate
// run between the parameters and the final byte; codex's TUI uses one on EVERY
// cursor-shape write: DECSCUSR = `ESC [ 0 SP q` (SP = 0x20), measured 1085x in a
// 5-minute real session. Without this class the regex cannot reach the final `q`,
// backtracks to eating just `ESC [`, and leaves the literal residue `0 q` in the
// text — which is what made `DONE:st3\b` fail for the delegation supervisor.
// Kept byte-identical with terminalActivity.ts (the parity lock, see file header).
const ANSI_PATTERN = new RegExp(
  '[\\x1b\\x9b][[\\]()#;?]*(?:\\d{1,4}(?:;\\d{0,4})*)?[\\x20-\\x2f]*[\\dA-PR-TZcf-nq-uy=><~]',
  'g',
);

/** Remove ANSI/OSC escape noise so the limit regex sees plain text. */
function stripAnsi(input) {
  if (typeof input !== 'string') return '';
  return input.replace(OSC_PATTERN, '').replace(ANSI_PATTERN, '');
}

// ADP-938 — WINDOWS root cause #1. ANSI_PATTERN above is the parity-locked copy of
// terminalActivity.ts and its FINAL-BYTE class ([\dA-PR-TZcf-nq-uy=><~]) covers only
// the sequences claude itself prints. ECMA-48 allows any final byte in 0x40-0x7E, and
// MEASURED on this repo 26 of those 63 finals survive stripAnsi: @ Q U V W X Y [ \ ]
// ^ _ ` a b d e o p v w x z { | }. On macOS that gap is invisible (the pty carries
// claude's own output). On WINDOWS the pty is ConPTY, which RE-RENDERS the screen with
// exactly those sequences — ECH (CSI n X), REP (CSI n b), ICH (CSI n @) — so leftovers
// like "[80X" land in the captured tail and:
//   • push the limit phrase off the start of its line → G3 anchor fails → limit MISSED
//   • truncate the "(Area/City)" tz annotation ("Europe/Istan" + "[3X" + "bul") → an
//     INVALID IANA zone → Intl throws (see zoneClockParts) → reset time lost
// Either way resetAt becomes unknown → the scheduler's 5-minute unknown-reset fallback
// fires a resume BEFORE the real reset → the agent hits the limit again (the incident).
// The robust/daemon layer therefore strips the FULL final-byte range. The parity copy
// above carries the same grammar minus that widened final class (drift lock, see header).
//
// ENG-01 — the SECOND hole in the same pattern: the intermediate-byte run (0x20-0x2F).
// Here it bit harder than in the parity copy: the robust final class (0x40-0x7e) has no
// digits, so on codex's `ESC [ 0 SP q` the regex backtracked all the way to `ESC [` and
// left `0 q` behind. Glued to a delegation marker that residue reads as
// `DONE:st30 q` → the supervisor's `\b` anchor misses → subtask never closes → false
// `stalled` → forceFresh → SECOND PANE FOR THE SAME AGENT (the measured P1 chain).
const ANSI_ROBUST_PATTERN = new RegExp(
  '[\\x1b\\x9b][[\\]()#;?]*(?:\\d{1,4}(?:;\\d{0,4})*)?[\\x20-\\x2f]*[\\x40-\\x7e]',
  'g',
);

/** stripAnsi for the ROBUST layer: also eats ConPTY finals (X/b/@/…) — ADP-938. */
function stripAnsiRobust(input) {
  if (typeof input !== 'string') return '';
  return input.replace(OSC_PATTERN, '').replace(ANSI_ROBUST_PATTERN, '');
}

// Two-signal rule (ADR §2.1) — kept identical to terminalActivity.ts.
// ENG-20 — GEMİNİ KOTASI BU DESENDE YOKTU (ölçüldü, kullanıcı-görünür arıza).
// gemini ücretsiz katman anahtarı dolunca motorun BASTIĞI cümlelerde "limit"
// kelimesi HİÇ GEÇMİYOR (ENG-14 kanıtı + ENG-20 yeniden ölçümü):
//   "TerminalQuotaError: You have exhausted your daily quota on this model."
//   429 "You exceeded your current quota…" · status "RESOURCE_EXHAUSTED"
// → detectLimit NULL dönüyordu. Sonuç kullanıcı için şuydu: kota bir BEKLEME
// değil bir ÇÖKME gibi görünüyor (limit sınıfı yok → "hata" bildirimi; devam
// zamanlayıcısı da hiç kurulmuyor). İki-sinyal kuralı KORUNUR: çıplak "quota"
// yetmez, exceeded/exhausted ile EŞLEŞMEK zorunda ("quota" kelimesi normal
// çıktıda da geçer).
// 🪤 `RESOURCE_EXHAUSTED` BİLEREK ALINMADI: ölçülen GERÇEK stderr'de o dize HİÇ
// geçmiyor (kanıt dosyası: 0 eşleşme; kota her iki cümleyi de taşıyor) — yani
// hiçbir şey kazandırmayan, ama ajan gRPC/proto metni bastığında yanlış-pozitif
// üretebilecek TEK-sinyalli bir jeton olurdu.
const LIMIT_HIT = new RegExp(
  "(?:usage|session|rate|\\d+-?\\s*hour)\\s*limit|limit\\s*(?:reached|exceeded)|you'?ve\\s+hit\\s+your\\s+(?:session|usage)\\s+limit|(?:daily\\s+)?quota\\s*(?:exceeded|exhausted)|exhausted\\s+your\\s+(?:daily\\s+)?quota|exceeded\\s+your\\s+(?:current\\s+)?quota",
  'i',
);
const RESET_CLOCK = /resets?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*([ap]m)?/i;
// RES-03 (D6) — the SAME pattern, global, so the robust layer can walk EVERY
// candidate instead of stopping at the first one (see extractReset).
const RESET_CLOCK_ALL = new RegExp(RESET_CLOCK.source, 'gi');
const RESET_REL = /(?:try\s+again|resets?)\s+in\s+(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?/i;
// CDX-LIMIT-02 (BUG-R3 #4 kök 2) — codex reset'i MUTLAK TARİH olarak basar:
// "…or try again at Aug 30th, 2026 2:24 AM." Ne RESET_CLOCK ("resets" ister) ne
// RESET_REL ("in" ister) bunu görür → resetAt hiç okunamıyordu. İki-sinyal ruhu
// korunur: ay adı + yıl + ":MM'li saat + am/pm HEPSİ şart — düzyazıdaki yalın bir
// saat ya da tarih tek başına eşleşemez. (PARITY: terminalActivity.ts birebir.)
const RESET_ABS =
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\s+(?:at\s+)?(\d{1,2}):(\d{2})\s*([ap]m)\b/i;
const MONTHS3 = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// LIMIT-RESUME-02 (RESEARCH-ACCT-01 §4.2) — claude'un HAFTALIK limit satırı reset'i
// YILSIZ ay-gün biçiminde basar: "You've hit your weekly limit · resets Sep 20 at 7pm
// (Europe/Istanbul)". RESET_CLOCK rakam bekler, RESET_ABS yıl + ":MM" ister → ikisi de
// null döndü ve daemon 2,5 gün boyunca 48 kör gönderim yaptı (ölçüldü, §5.2). Yıl yok;
// çözümleme "bu yıl, geçtiyse gelecek yıl" (resolveResetAt). Yalnız ROBUST katmanda
// kullanılır — parity kopyası (detectLimit/parseAbsReset) bit-bit durur.
const RESET_MONTHDAY =
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)\b/i;
// LIMIT-RESUME-02 — CLI'ın KENDİ otomatik-devam bandı ve /rate-limit-options çıktısı
// (2.1.276 ikilisinden, harf harf):
//   "Usage limit reached · continuing automatically at 2:30am · esc or type to cancel"
//   "Claude Code will continue automatically at Sep 20 at 7pm. Keep this session open…"
// Saat "resets" kelimesiyle gelmediği için RESET_CLOCK onu göremiyordu. Bant, saati
// SUNUCUDAN bilen tarafın beyanıdır → kaynak olarak 429 satırından daha güvenilir.
const CONTINUE_AT = /continu(?:e|ing)\s+automatically\s+at\s+/i;
// LIMIT-RESUME-02 — CLI otomatik-devam FAZLARI (2.1.276 ikilisinden çıkarılan dizgeler;
// kanıt: LIMIT-RESUME-02-evidence/cli-strings.txt). Bunlar LİMİT satırı DEĞİLDİR
// (LIMIT_LINE "usage limit has reset"i eşlemez) — daemon bunları ayrı okur:
//   armed     — "continuing automatically at …" / "…when it resets" / "continuing shortly"
//   stale     — "Your usage limit has reset · press enter to continue" (reset OLDU, Enter bekliyor)
//   cancelled — "Automatic continue cancelled" / "…will not resume on its own" /
//               "Automatic continue stopped after repeated usage-limit hits"
//   again     — "Usage limit reached again after you continued"
// G3 kuralı burada da geçerli: bant SATIRI BAŞLATIR (LEAD_NOISE'dan sonra `^`); düzyazı
// içinde alıntılanan aynı kelimeler ("…'press enter to continue' fazı…") EŞLEŞMEZ.
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

/**
 * CDX-LIMIT-02 — parse an ABSOLUTE reset date ("Aug 30th, 2026 2:24 AM") to a
 * local-zone epoch. Motor tarihi kullanıcının KENDİ saat diliminde basar (codex
 * tz eki basmaz), bu yüzden OS-lokal çözümleme ADP-947'nin varsayılanıyla aynı
 * dürüstlüktedir. Dönüş: {at, raw} | null. (PARITY: terminalActivity.ts birebir.)
 */
function parseAbsReset(text) {
  const m = String(text == null ? '' : text).match(RESET_ABS);
  if (!m) return null;
  const mo = MONTHS3.indexOf(m[1].toLowerCase());
  const day = parseInt(m[2], 10);
  const year = parseInt(m[3], 10);
  let h = parseInt(m[4], 10);
  const min = parseInt(m[5], 10);
  const ap = m[6].toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (mo < 0 || day < 1 || day > 31 || h > 23 || min > 59) return null;
  const at = new Date(year, mo, day, h, min, 0, 0).getTime();
  return Number.isFinite(at) ? { at, raw: m[0] } : null;
}

/**
 * Detect a usage/session limit in a tail of pane output. Returns null unless a
 * LIMIT_HIT phrase is present (two-signal guard). Reset time (clock and/or
 * relative) is parsed when present but not required.
 * @returns {{resetClock:object|null, resetRel:object|null, raw:string}|null}
 */
function detectLimit(rawTail) {
  if (typeof rawTail !== 'string' || rawTail.length === 0) return null;
  const t = stripAnsi(rawTail);
  const hit = t.match(LIMIT_HIT);
  if (!hit) return null;
  const sig = { resetClock: null, resetRel: null, resetAbs: parseAbsReset(t), raw: hit[0] };
  const c = t.match(RESET_CLOCK);
  // ADP-288 — saat ancak DAKİKA (:MM) veya am/pm taşıyorsa saattir (parity:
  // terminalActivity.ts ile birebir). Çıplak "reset(s) <sayı>" Format-A menü
  // seçeneği olabilir ("…limit to reset\n  2. Use extra…" → 02:00 misparse —
  // 2026-07-10 canlı vaka: devam 15:00 yerine 02:00'a kuruldu).
  if (c && (c[2] || c[3])) {
    let h = parseInt(c[1], 10);
    const min = c[2] ? parseInt(c[2], 10) : 0;
    const ap = (c[3] || '').toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (h <= 23 && min <= 59) sig.resetClock = { h, min, raw: c[0] };
  }
  const r = t.match(RESET_REL);
  if (r && (r[1] || r[2])) {
    sig.resetRel = {
      h: r[1] ? parseInt(r[1], 10) : 0,
      m: r[2] ? parseInt(r[2], 10) : 0,
      raw: r[0],
    };
  }
  return sig;
}

// ADP-938 — WINDOWS root cause #2. `new Intl.DateTimeFormat(_, {timeZone})` does NOT
// silently fall back to UTC when the zone is unknown — per ECMA-402 it THROWS
// RangeError (MEASURED: 'Mars/Olympus' → "RangeError: Invalid time zone specified").
// That throw used to escape parseResetAt → observe() → the daemon's pollOnce loop
// (MEASURED: core.observe on a limit line with a bogus "(Area/City)" annotation threw),
// which kills the whole poll TICK — every other pane in that tick goes unobserved and
// the limit is never queued. The tz string is attacker-free but NOT trustworthy: it is
// scraped off a re-rendered terminal, and ConPTY noise truncates it ("Europe/Istan").
// So: probe the zone once, cache it, and never let Intl throw into the daemon.
const TZ_OK_CACHE = new Map();
function isUsableTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  if (TZ_OK_CACHE.has(tz)) return TZ_OK_CACHE.get(tz);
  let ok = false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz }).format(0);
    ok = true;
  } catch {
    ok = false; // unknown zone, mangled name, or an ICU build without the zone
  }
  TZ_OK_CACHE.set(tz, ok);
  return ok;
}

/**
 * Wall-clock {hour,minute,second} of `now` in `tz`. Returns null (never throws) when
 * the zone is unusable — the caller decides what a missing measurement means. NB the
 * Electron ICU data is byte-identical across win32/darwin (ADP-938 measured on the
 * v42.4.1 artifacts: same sha256 icudtl.dat), so a null here means a BAD ZONE NAME,
 * not a small-icu Windows build.
 */
function zoneClockParts(now, tz) {
  if (!isUsableTimeZone(tz)) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(now));
    const cur = {};
    for (const p of parts) if (p.type !== 'literal') cur[p.type] = parseInt(p.value, 10);
    if (!Number.isFinite(cur.hour) || !Number.isFinite(cur.minute)) return null;
    return {
      hour: cur.hour === 24 ? 0 : cur.hour,
      minute: cur.minute,
      second: Number.isFinite(cur.second) ? cur.second : 0,
    };
  } catch {
    return null;
  }
}

/** Wall-clock parts of `now` in the OS-local zone — no ICU involved (ADP-938 fallback). */
function localClockParts(now) {
  const d = new Date(now);
  return { hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds() };
}

/**
 * LIMIT-RESUME-02 — {year, month(1-12), day} of `now` in `tz` (OS-local when the zone
 * is unusable/absent). Never throws.
 */
function zoneDateParts(now, tz) {
  if (tz && isUsableTimeZone(tz)) {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(new Date(now));
      const cur = {};
      for (const q of parts) if (q.type !== 'literal') cur[q.type] = parseInt(q.value, 10);
      if (Number.isFinite(cur.year) && Number.isFinite(cur.month) && Number.isFinite(cur.day)) {
        return { year: cur.year, month: cur.month, day: cur.day };
      }
    } catch {
      /* fall through to local */
    }
  }
  const d = new Date(now);
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
}

/**
 * LIMIT-RESUME-02 — epoch of wall-clock `year-month-day h:min` in `tz` (OS-local when
 * the zone is unusable/absent). Two fixed-point passes over Intl's own wall clock, so
 * DST is Intl's problem, not ours. Never throws.
 */
function zonedDateEpoch(year, month, day, h, min, tz) {
  if (!tz || !isUsableTimeZone(tz)) return new Date(year, month - 1, day, h, min, 0, 0).getTime();
  const target = Date.UTC(year, month - 1, day, h, min, 0, 0);
  let guess = target;
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    for (let i = 0; i < 2; i++) {
      const cur = {};
      for (const q of fmt.formatToParts(new Date(guess))) {
        if (q.type !== 'literal') cur[q.type] = parseInt(q.value, 10);
      }
      const wall = Date.UTC(cur.year, cur.month - 1, cur.day, cur.hour === 24 ? 0 : cur.hour, cur.minute, 0, 0);
      guess += target - wall;
    }
  } catch {
    return new Date(year, month - 1, day, h, min, 0, 0).getTime();
  }
  return guess;
}

/**
 * LIMIT-RESUME-02 — parse a YEARLESS "Sep 20 at 7pm" reset (claude's weekly-limit
 * form). Returns {month(1-12), day, h, min, raw, tz?} | null — the year is resolved
 * later against `now` (resolveResetAt), because this parser has no clock.
 */
function parseMonthDayReset(text) {
  const t = String(text == null ? '' : text);
  const m = t.match(RESET_MONTHDAY);
  if (!m) return null;
  const mo = MONTHS3.indexOf(m[1].toLowerCase());
  const day = parseInt(m[2], 10);
  let h = parseInt(m[3], 10);
  const min = m[4] ? parseInt(m[4], 10) : 0;
  const ap = m[5].toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (mo < 0 || day < 1 || day > 31 || h > 23 || min > 59) return null;
  const out = { month: mo + 1, day, h, min, raw: m[0] };
  const after = t.slice(m.index + m[0].length, m.index + m[0].length + 40);
  const tzm = after.match(RESET_TZ);
  if (tzm) out.tz = tzm[1];
  return out;
}

// LIMIT-RESUME-02 — a DATED reset (weekly limit) may legitimately be days out; the
// 24h ceiling below exists for the clock-only roll-forward trap, which a printed date
// cannot fall into. Weekly windows are 7 days; anything further is a mis-parse.
const MAX_DATED_RESET_AHEAD_MS = 8 * 24 * 60 * 60_000;

/** True when `at` is a sane future DATED reset instant for `now` (LIMIT-RESUME-02). */
function isSaneDatedResetAt(at, now) {
  return Number.isFinite(at) && at > now && at - now <= MAX_DATED_RESET_AHEAD_MS;
}

/**
 * Both instants a printed wall clock can mean, and which one we had to take:
 *   clockAt    — TODAY's occurrence of `h:min` (may already be in the PAST)
 *   at         — the NEXT occurrence (clockAt, or clockAt + 24h once it passed)
 *   rolledOver — true when `at` had to jump a whole day to stay in the future
 *
 * ADP-938: never throws. When `tz` is unusable the OS-local clock is used instead
 * (Date's own getters — no ICU), which is the right guess in the overwhelming case:
 * the engine prints the reset in the USER's zone, and the user's box is in it. The
 * degradation is reported through `resolveResetAt().source`, so the daemon can be
 * conservative rather than trusting a guessed instant.
 *
 * ADP-947: `rolledOver`/`clockAt` are the MISSING FACT. claude leaves its limit line
 * on the screen after the window renews, so from the printed minute onward every poll
 * re-reads a clock that is now in the past and `at` silently becomes TOMORROW — the
 * daemon then parks a healthy agent ~24h right after its limit came back (MEASURED:
 * "resets 1pm" read at 13:05 → a 1436-minute timer; Eren: "13:00'de yenilendi FAKAT
 * otomatik başlamıyo"). Only the caller can tell "the reset already happened" from
 * "the reset is tomorrow", and it needs these two fields to do it.
 */
function clockEpochs(h, min, now, tz) {
  const cur = zoneClockParts(now, tz) || localClockParts(now);
  const deltaMin = h * 60 + min - (cur.hour * 60 + cur.minute) - cur.second / 60;
  const rolledOver = deltaMin <= 0;
  return {
    at: Math.round(now + (rolledOver ? deltaMin + 24 * 60 : deltaMin) * 60000),
    clockAt: Math.round(now + deltaMin * 60000),
    rolledOver,
  };
}

/** Next epoch (ms) at which wall-clock `h:min` occurs in `tz` (today or tomorrow). */
function nextEpochForClock(h, min, now, tz) {
  return clockEpochs(h, min, now, tz).at;
}

// A reset is always within the next day; anything else is a mis-parse, not a schedule.
const MAX_RESET_AHEAD_MS = 24 * 60 * 60_000 + 60_000;

/** True when `at` is a sane future reset instant for `now` (ADP-938 sanity gate). */
function isSaneResetAt(at, now) {
  return Number.isFinite(at) && at > now && at - now <= MAX_RESET_AHEAD_MS;
}

/**
 * Resolve a LimitSignal's reset time. Returns
 *   { at:number|null, source:'rel'|'clock'|'clock-local-fallback'|null, zone:string|null,
 *     rolledOver:boolean, clockAt:number|null }
 * `source==='clock-local-fallback'` means the printed zone was NOT usable and the
 * instant was guessed from the OS clock — the daemon treats that as lower confidence.
 * `at` is null whenever the result is not a sane future instant (ADP-938): a null is a
 * HONEST "unknown", a wrong number would arm a resume at the wrong minute.
 * `rolledOver`/`clockAt` expose the +24h jump (ADP-947, see clockEpochs).
 *
 * ADP-947 — `tz` now defaults to the OS-LOCAL clock, NOT a hardcoded Europe/Istanbul.
 * The engine prints the reset in the USER's own zone, so a fixed zone shifts every box
 * by its offset from Istanbul. MEASURED with the same "resets 1:20am" line: on a
 * Europe/Berlin box the old default resolved 60 min EARLY (→ we type before the reset,
 * "1:20am yazıyor ama 00:54'te istek attı") and on Asia/Karachi 22h off (→ we are not
 * there when it renews). Both reported symptoms, one default. A zone PRINTED on the
 * limit line still wins over everything, and an explicit `tz` argument is still
 * honoured, so the ADP-217 callers/tests keep their exact behaviour.
 */
function resolveResetAt(signal, now, tz = null) {
  const none = { at: null, source: null, zone: null, rolledOver: false, clockAt: null, via: null };
  if (!signal) return none;
  if (signal.resetRel) {
    const ms = (signal.resetRel.h * 3600 + signal.resetRel.m * 60) * 1000;
    const at = ms > 0 ? now + ms : null;
    return { ...none, at: isSaneResetAt(at, now) ? at : null, source: at == null ? null : 'rel' };
  }
  // CDX-LIMIT-02 — MUTLAK tarih (rel'den sonra, çıplak clock'tan ÖNCE — tarihli
  // saat > çıplak saat; sıra terminalActivity.parseResetAt ile birebir): +24h
  // yuvarlama tuzağı (ADP-947) burada yapısal olarak imkânsız — tarih açık.
  // isSaneResetAt tavanı yine de uygulanır (geçmiş tarih ya da >24h ilerisi →
  // dürüst null; rozet "süre bilinmiyor" der, uydurma saat asla).
  if (signal.resetAbs && Number.isFinite(signal.resetAbs.at)) {
    const at = signal.resetAbs.at;
    return {
      ...none,
      at: isSaneResetAt(at, now) ? at : null,
      source: isSaneResetAt(at, now) ? 'abs' : null,
      clockAt: at,
    };
  }
  // LIMIT-RESUME-02 — YILSIZ ay-gün ("resets Sep 20 at 7pm (Europe/Istanbul)"): bu yıl,
  // geçmişte kaldıysa gelecek yıl. Tarih açık olduğu için +24h yuvarlama tuzağı yok;
  // tavan haftalık pencere (MAX_DATED_RESET_AHEAD_MS). Geçmiş bir tarih → dürüst null
  // (clockAt yine döner ki çağıran "reset OLDU"yu ayırt edebilsin).
  if (signal.resetDate && Number.isFinite(signal.resetDate.day)) {
    const d = signal.resetDate;
    const zone = d.tz || tz || null;
    const cur = zoneDateParts(now, zone);
    let at = zonedDateEpoch(cur.year, d.month, d.day, d.h, d.min, zone);
    if (now - at > MAX_DATED_RESET_AHEAD_MS) {
      at = zonedDateEpoch(cur.year + 1, d.month, d.day, d.h, d.min, zone);
    }
    const sane = isSaneDatedResetAt(at, now);
    return {
      ...none,
      at: sane ? at : null,
      source: sane ? 'date' : null,
      zone,
      clockAt: Number.isFinite(at) ? at : null,
      rolledOver: false,
      via: signal.resetVia || null,
    };
  }
  if (signal.resetClock) {
    // ADP-217 — honor a tz the limit line printed ("resets 11:30am (Asia/Colombo)");
    // ADP-947 — otherwise the caller's zone, and failing that the OS-local clock.
    const zone = signal.resetClock.tz || tz || null;
    // No zone to look up at all → the OS clock is not a degradation, it is the answer.
    const usable = zone == null ? true : isUsableTimeZone(zone);
    const e = clockEpochs(signal.resetClock.h, signal.resetClock.min, now, zone);
    return {
      at: isSaneResetAt(e.at, now) ? e.at : null,
      source: usable ? 'clock' : 'clock-local-fallback',
      zone,
      rolledOver: e.rolledOver,
      clockAt: e.clockAt,
      via: signal.resetVia || null, // LIMIT-RESUME-02 — 'cli-band' when the CLI's own band said it
    };
  }
  return none;
}

/**
 * Resolve a LimitSignal's reset time to an absolute epoch (ms), or null when no
 * time was parsed. Relative is preferred (tz-independent); clock resolves to the
 * next occurrence in `tz` (ADP-947: OS-local by default; DST automatic via Intl).
 * ADP-938 — thin wrapper over resolveResetAt (which never throws).
 */
function parseResetAt(signal, now, tz = null) {
  return resolveResetAt(signal, now, tz).at;
}

// ===========================================================================
// ADP-089 — ROBUST detection layer (incident root-cause fix).
//
// The ADP-088 `detectLimit` above is a LOOSE keyword matcher kept byte-identical
// to terminalActivity.ts (parity lock). It fires on the word "limit" + a reset
// time ANYWHERE in the captured text. That is exactly what caused the incident:
// Optimus's (lead) REPORT prose mentioned "limit … resets … claude --resume …",
// detectLimit said "limit!", and the daemon nearly resumed the wrong session.
//
// The robust layer below is what the DAEMON uses. A capture only counts as a real
// limit when ALL of these hold (defense-in-depth — any one alone is bypassable):
//   G1 tail-only    — look only at the last few lines (the LIVE bottom of the
//                     pane), never the scrollback/report body higher up.
//   G2 not-working  — no active spinner / "esc to interrupt": a working agent is
//                     NOT limited, and a report is produced WHILE working.
//   G3 standalone   — the limit phrase must BEGIN its own status line, not sit
//                     mid-sentence in prose ("…limit yenilenince ajanlar…").
//   G4 anchored     — that standalone line is among the last few non-empty lines
//                     (a report's limit-quote scrolls up behind the input box).
// Plus it classifies the stop: 'plain' status line vs interactive 'prompt'
// (2-option wait/upgrade), and infers the engine (claude vs codex) from phrasing.
// ===========================================================================

// How many trailing lines of the pane are the "live tail" we inspect (G1).
const TAIL_LINES = 14;
// The limit line must be within this many last non-empty lines to count (G4).
const ANCHOR_LINES = 6;

/** Last `maxLines` lines of `text` after ANSI-strip, with trailing blanks dropped. */
function tailText(text, maxLines = TAIL_LINES) {
  // ADP-938 — ROBUST strip (ConPTY finals too), never the parity copy.
  const stripped = stripAnsiRobust(typeof text === 'string' ? text : '');
  const lines = stripped.replace(/\r/g, '').split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.slice(-Math.max(1, maxLines)).join('\n');
}

// G2 — signals that the engine is actively working (so it is NOT limit-stopped).
// Claude Code: "(esc to interrupt)", animated braille spinner, "✻ Thinking…".
// Codex: "Esc to interrupt", "Working", "Thinking".
const BRAILLE_SPINNER = /[⠀-⣿]/; // animated spinner frame glyph
const WORK_GLYPH_WORD = /[✻✽✶✳✢∗]\s*\w+[…]/; // "✻ Crafting…"
function isAgentWorking(tail) {
  const t = typeof tail === 'string' ? tail : '';
  if (/esc to interrupt/i.test(t)) return true;
  if (BRAILLE_SPINNER.test(t)) return true;
  if (WORK_GLYPH_WORD.test(t)) return true;
  return false;
}

// G3 — a STANDALONE limit status line: the limit phrase begins the line (after
// optional box-draw / bullet / quote-cursor noise). Anchored with ^ so the same
// words buried in a prose sentence ("…limit yenilenince…") never match.
// CDX-LIMIT-02 (BUG-R3 #4 kök 1) — codex hata/uyarı satırlarını `■` (U+25A0) ile
// başlatır ("■ You've hit your usage limit…"). Sınıfta olmayınca G3 "satır başında"
// kapısı düşüyordu ve dört codex pane'i bütün gece sessiz bekledi (ÖLÇÜLDÜ:
// BUG-R3-evidence/limit-probe2 — aynı satır "■ " ile null, öneksiz plain). ▪▫□
// aynı glif ailesinin öteki üyeleri (ihtiyat). Düzyazı koruması durur: ■'den
// sonra da LIMIT_LINE cümlesi satırın BAŞINDA başlamak zorundadır.
const LEAD_NOISE = "^[\\s>│|*•▌▏◆●·∙■▪▫□\\-]*";
const LIMIT_LINE = new RegExp(
  LEAD_NOISE +
    '(?:' +
    "claude (?:ai )?usage limit reached|" +
    "you'?ve (?:reached|hit) your (?:\\d+-?\\s*hour |session |usage |5-?hour |weekly )*(?:message |usage )?limit|" +
    "(?:\\d+-?\\s*hour|usage|session|weekly|rate|message) limit (?:reached|exceeded|resets?)|" +
    "(?:\\d+-?\\s*hour) limit resets|" +
    // ADP-180 — the CURRENT extra-usage exhaustion line Claude Code prints (research:
    // "You're out of extra usage · resets 11:30am (Asia/Colombo)"). Was unmatched.
    "you'?re out of (?:extra )?usage|" +
    "out of (?:extra )?usage(?:\\s*[·∙•-]|\\s+resets?)" +
    ')',
  'i',
);

// A numbered option line in an interactive prompt ("❯ 1. Wait for reset").
// ADP-098: the lead-noise class now also eats box-draw verticals (│ |) and a few
// more bullet glyphs so a BOXED select menu ("│ ❯ 1. Stop and wait …") still
// matches — the real Claude /rate-limit-options prompt renders inside a box, and
// the un-boxed class silently dropped every option line (prod-miss root cause #2).
// CDX-LIMIT-02 — `›»` eklendi: codex vurgulu seçeneği `› 1. …` ile basar (PDF s.6
// ekranı); sınıfta olmayınca vurgulu satır parser'a hiç görünmüyordu.
const OPTION_LINE = /^[\s│|❯›»>►▶○●◆◇▪▫•*\-]*\s*(\d)[.)]\s+(\S.*)$/;

// ADP-098 — markers of Claude Code's interactive rate-limit prompt (Format A).
// `/rate-limit-options` is the slash-command label Claude prints; `/upgrade` is the
// plain-text Format-B hint. Either is an unambiguous, prose-proof limit signal.
const SLASH_LIMIT_MARKER = /\/rate-?limit-?options|\/upgrade\b/i;
// "What do you want to do?" / "How do you want to proceed?" question header.
const PROMPT_QUESTION = /\b(?:what|how)\b.{0,40}\b(?:do|would|to)\b.{0,30}\b(?:do|proceed|continue)\b/i;

// ADP-217 — incident heal for the DAEMON's robust reset extraction ONLY.
//
// THE incident (2 panes idle ~all night): a real "resets 5:50am" session-limit line
// parsed to {h:5, min:0} — the MINUTES were dropped — so the reset resolved to 05:00,
// which (seen at 05:44) was already PAST → nextEpochForClock bumped it +24h → a ~23h
// "02:00:00" stall instead of a 6-minute wait. The captured pane text drops the
// minutes whenever the ":" is not a plain adjacent ASCII colon, which is exactly what
// a boxed/narrow Claude prompt produces:
//   • a line/box WRAP splits the time     → "resets 5:\n50am"
//   • a unicode/full-width colon glyph     → "resets 5∶50am" / "5：50am"
//   • stray padding spaces around the ":"  → "resets 5 : 50am"
// All of these made the parity RESET_CLOCK's optional minute group fail silently.
//
// We heal the TEXT (collapse those colon variants back to "H:MM") before the SAME
// RESET_CLOCK runs, so the daemon recovers the minutes. The parity-locked detectLimit
// path above is left byte-identical to terminalActivity.ts on purpose — only the
// robust daemon layer (extractReset) normalizes.
const UNICODE_COLONS = /[∶：︓﹕꞉]/g; // ∶ ： ﹓ ﹕ ꞉ → ":"
function healClockText(text) {
  return String(text == null ? '' : text)
    .replace(UNICODE_COLONS, ':')
    // "H:<wrap/box/space>MM" → "H:MM": a digit, a colon, then whitespace (incl. the
    // newline a wrap inserts) AND any box-border/lead-noise the next boxed line
    // begins with (│ | > • ▏▌ etc.), before the 2 minute digits. The 2-digit floor +
    // the (?!\d) tail keep this from gluing an unrelated number onto the hour. NB: a
    // plain \b here would FAIL on the common "...50am" (no boundary between 0 and a),
    // which is exactly the wrapped form that caused the incident.
    .replace(/(\d{1,2})\s*:[\s│|>•▏▌·∙]*(\d{2})(?!\d)/g, '$1:$2');
}

// ADP-217 — a "(Area/City)" tz annotation Claude prints right after the clock
// ("resets 11:30am (Asia/Colombo)"). When present the clock is in THAT tz, so the
// daemon resolves the epoch there instead of assuming Europe/Istanbul (tz tolerance).
const RESET_TZ = /\(([A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+)\)/;

/**
 * Parse reset clock/relative parts from text using the SAME RESET_CLOCK/RESET_REL
 * regexes as detectLimit — but WITHOUT the narrow LIMIT_HIT gate, so codex's
 * "…reached your 5-hour message limit. Try again in 3h 42m." (which LIMIT_HIT does
 * not match, by parity lock) still yields its relative reset for the robust layer.
 *
 * ADP-217: first heals wrapped/unicode/spaced colons (see healClockText) so the
 * minutes survive, and captures an optional printed tz so the clock resolves in the
 * zone it was shown in.
 */
function extractReset(text) {
  const t = healClockText(text);
  const out = { resetClock: null, resetRel: null, resetAbs: parseAbsReset(t), resetDate: null, resetVia: null };
  // LIMIT-RESUME-02 — the CLI's OWN band / /rate-limit-options output names the instant
  // it will continue at ("continuing automatically at 2:30am", "…at Sep 20 at 7pm").
  // That is the server-known reset spoken by the party that will act on it, so it
  // beats the 429 line's "resets …" when both are present. Same clock/month-day
  // grammar as the 429 line, just a different prefix.
  const band = t.match(CONTINUE_AT);
  if (band) {
    const after = t.slice(band.index + band[0].length, band.index + band[0].length + 60);
    const md = parseMonthDayReset(after);
    if (md) {
      out.resetDate = md;
      out.resetVia = 'cli-band';
    } else {
      const c = after.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap]m)?/i);
      if (c && (c[2] || c[3])) {
        let h = parseInt(c[1], 10);
        const min = c[2] ? parseInt(c[2], 10) : 0;
        const ap = (c[3] || '').toLowerCase();
        if (ap === 'pm' && h < 12) h += 12;
        if (ap === 'am' && h === 12) h = 0;
        if (h <= 23 && min <= 59) {
          const clock = { h, min, raw: band[0] + c[0] };
          const tzm = after.slice(c[0].length, c[0].length + 40).match(RESET_TZ);
          if (tzm) clock.tz = tzm[1];
          out.resetClock = clock;
          out.resetVia = 'cli-band';
        }
      }
    }
    if (out.resetVia) return out;
  }
  // LIMIT-RESUME-02 — yearless month-day form of the 429 line ("resets Sep 20 at 7pm").
  // Checked before the bare clock: "at 7pm" inside it would otherwise be read by
  // RESET_CLOCK_ALL as a clock for TODAY (a dated instant beats a bare one).
  const dated = /resets?(?:\s+at)?\s+(?=[a-z]{3})/i.exec(t);
  if (dated) {
    const md = parseMonthDayReset(t.slice(dated.index + dated[0].length, dated.index + dated[0].length + 60));
    if (md) {
      out.resetDate = md;
      return out;
    }
  }
  // RES-03 (D6) — walk EVERY candidate, take the first that clears the ADP-288
  // gate. The old `t.match` stopped at candidate #1, so one menu option ending in
  // "…wait for the limit to reset" followed by a line starting "2." consumed the
  // only look we ever took: the gate rejected "reset 2" (correctly) and the REAL
  // "resets 7:30am" two lines below was never seen. MEASURED on the untouched
  // detector: the announcement is IN the text and extractReset returns null.
  // The gate itself is unchanged — a bare "reset <n>" is still not a clock.
  for (const c of t.matchAll(RESET_CLOCK_ALL)) {
    if (!c[2] && !c[3]) continue; // ADP-288 — dakikasız + am/pm'siz = saat DEĞİL
    let h = parseInt(c[1], 10);
    const min = c[2] ? parseInt(c[2], 10) : 0;
    const ap = (c[3] || '').toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (h > 23 || min > 59) continue;
    const clock = { h, min, raw: c[0] };
    // tz only from the text right AFTER the clock (avoid grabbing an unrelated
    // parenthetical elsewhere in the tail).
    const after = t.slice(c.index + c[0].length, c.index + c[0].length + 40);
    const tzm = after.match(RESET_TZ);
    if (tzm) clock.tz = tzm[1];
    out.resetClock = clock;
    break;
  }
  const r = t.match(RESET_REL);
  if (r && (r[1] || r[2])) {
    out.resetRel = {
      h: r[1] ? parseInt(r[1], 10) : 0,
      m: r[2] ? parseInt(r[2], 10) : 0,
      raw: r[0],
    };
  }
  return out;
}

// RES-03 (D2) — how many trailing lines the RESET EXTRACTION may look at. This is
// DELIBERATELY wider than TAIL_LINES (the DETECTION window) and the split is the
// whole point of the fix:
//
//   • DETECTION must stay narrow. G1/G3/G4 are the false-positive guards that keep
//     a report QUOTING a limit ("…limit yenilenince ajanlar…") from arming a resume
//     — the ADP-089 incident. Widening them would re-open it, so they do not move.
//   • EXTRACTION has no such risk. Once detection has already CONFIRMED a live
//     limit, reading the clock from further up the same pane cannot invent a limit
//     that is not there; the worst case is an older reset time, and a limit-line-
//     first scan (below) picks the newest announcement anyway.
//
// The regression this closes: tmux's capture-pane returned the DRAWN screen, so the
// announcement stayed on line ~3 and the clock was read (RES-01 §3b). The pty
// buffer is the RAW stream where every `\r` menu redraw becomes its own line, so
// the announcement is pushed out of the 14-line window — MEASURED: 9 of 9 real
// limit events logged "~5dk fallback" while "resets 7:30am (Europe/Istanbul)" was
// on screen the whole time, and the resume fired 1h20m–4h17m EARLY.
const RESET_SCAN_LINES = 80;

/**
 * RES-03 — read the reset time from a WIDER window than detection used, newest
 * announcement first. Order matters: the line that matches LIMIT_LINE is the
 * engine's own announcement, so its clock beats any other number in the tail.
 * Scanned bottom-up so a fresh limit wins over a stale one still in the buffer.
 * The clock may wrap onto the following line (ADP-217), hence the small context.
 */
function extractResetWide(rawTail, maxLines = RESET_SCAN_LINES) {
  const wide = tailText(rawTail, Math.max(TAIL_LINES, maxLines));
  const lines = wide.split('\n').filter((l) => l.trim());
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!LIMIT_LINE.test(lines[k])) continue;
    const got = extractReset(lines.slice(k, k + 3).join('\n'));
    if (got.resetClock || got.resetRel || got.resetAbs || got.resetDate) return got;
  }
  return extractReset(wide);
}

// RES-02 (D7) — how many trailing lines count as "the last redraw frame".
const LAST_FRAME_LINES = 6;

/**
 * RES-02 — the LIVE BOTTOM of the pane: the last redraw frame only.
 *
 * `isAgentWorking` over the full 14-line tail was a false-success path: the pty
 * buffer keeps EVERY redraw frame, so a spinner printed before the limit hit is
 * still sitting in the window minutes later and reads as "the agent is working".
 * That is one of the two ways the daemon declared a failed resume successful
 * (the other is the transcript, see resumeDaemonCore._activityEvidence). A live
 * TUI repaints its bottom rows continuously, so real work is always visible in
 * the last frame — restricting the look loses nothing and drops the stale ones.
 */
function lastFrameText(text, lines = LAST_FRAME_LINES) {
  return tailText(text, lines);
}

/**
 * RES-02 (D1) — does this text CONTAIN the engine's own limit announcement?
 *
 * Used on the assistant's ANSWER to our "devam et" nudge (a transcript line, not a
 * pane capture), so the tail/anchor gates do not apply — the answer is the whole
 * message. G3's standalone rule is kept (the phrase must begin its line) so a
 * report body that merely mentions a limit still does not count.
 */
function looksLikeLimitText(text) {
  const t = stripAnsiRobust(typeof text === 'string' ? text : '');
  if (!t.trim()) return false;
  return t.split('\n').some((l) => LIMIT_LINE.test(l));
}

/**
 * ENG-01 (ENG-R3 §10.2 sıra-3) — MOTOR: ÖNCE KAYIT, SONRA metin.
 *
 * `inferEngine` bir İNGİLİZCE CÜMLE tahminidir ("try again in" → codex). Pane'in
 * gerçek motoru zaten KAYITLI: livePaneRegistry.normalize() her kayda
 * `engine: 'codex'|'claude'` yazar (canonical alan). Tahmin bunun yerine geçtiğinde
 * iki hata sınıfı doğar: (a) motorun dili değişince/lokalize olunca sessizce yanlış
 * motor, (b) yeni bir motor eklendiğinde cümle hiçbir dala uymaz → null → çağıran
 * 'claude'a düşer (ENG-R1 §2.3'ün ölçtüğü SESSİZ DÜŞÜŞ sınıfı).
 *
 * Bu yüzden kayıt verisi varsa metin HİÇ okunmaz; metin yalnız FALLBACK'tir.
 * Bilinmeyen/boş değer kayıt sayılmaz (uydurma motor adı sızdırmayalım) → fallback.
 *
 * @param {string|null|undefined} paneEngine livePaneRegistry kaydındaki `engine`
 * @param {string} tail  pane kuyruğu (yalnız kayıt yoksa okunur)
 */
function resolveEngine(paneEngine, tail) {
  if (paneEngine === 'codex' || paneEngine === 'claude') return paneEngine;
  return inferEngine(tail);
}

/** Heuristic engine inference from limit phrasing; null when unsure (registry/opts.engine overrides). */
function inferEngine(tail) {
  const t = (typeof tail === 'string' ? tail : '').toLowerCase();
  if (/message limit|try again (?:in|at)|\bcodex\b/.test(t)) return 'codex';
  if (/usage credits|session limit|claude (?:ai )?usage limit|out of (?:extra )?usage|\d-?\s*hour limit (?:reached|resets)/.test(t)) {
    return 'claude';
  }
  return null;
}

// A line that may legitimately trail a LIVE rate-limit select menu: blank, a
// box border, or a known footer ("Enter to confirm · Esc to cancel", "? for
// shortcuts", arrow-key hints). Anything else after the options (prose, or an
// input-box cursor `│ > │`) means the menu is NOT live — it's a report quoting it,
// so we reject. This is the ADP-098 guard that keeps the incident class out.
function isLiveMenuTrailing(line) {
  const t = String(line || '').trim();
  if (!t) return true;
  if (/^[╭╮╰╯─━│|┃\s]+$/.test(t)) return true; // box border / blank-in-box (no cursor)
  if (
    /enter to (?:confirm|select|continue)|esc to (?:cancel|exit|interrupt|go back)|press enter|arrow keys|↑.?↓|to (?:select|navigate)|\? for shortcuts|use .* to (?:select|move)/i.test(
      t,
    )
  ) {
    return true;
  }
  return false;
}

/** Classify a prompt option label as the graceful 'wait', the 'upgrade', or 'other'. */
function classifyOption(label) {
  const lc = String(label || '').toLowerCase();
  // CDX-LIMIT-02 — "Switch to <model>" ASLA zarif bekleme değildir (kart kuralı:
  // limiti aşmak için model/hesap değiştiren gizli yol YOK). Önce elenir ki
  // "switch and wait" gibi bir yazım wait sınıfına sızamasın.
  if (/switch\s+to/.test(lc)) return 'upgrade';
  // "Keep current model" = mevcut modelde kal ve bekle — codex'in "Approaching
  // rate limits" menüsündeki zarif seçenek (BUG-R3 #4 ekranı, seçenek 2).
  if (/wait|stop|reset|later|pause|don'?t|no\b|keep current/.test(lc)) return 'wait';
  if (/credit|upgrade|continue|keep|switch|yes\b/.test(lc)) return 'upgrade';
  return 'other';
}

/**
 * ADP-098 — detect Claude Code's INTERACTIVE rate-limit prompt (Format A) by its
 * OWN anchored markers, not by the "You've hit your limit" line.
 *
 * WHY a separate path: in the real prompt the limit announcement scrolls up behind
 * a boxed select menu, so it is > ANCHOR_LINES from the bottom and the standalone
 * G3/G4 plain detector (below) rejects it — the prod-miss root cause #1. The live
 * select block (numbered options + "/rate-limit-options" + "What do you want to
 * do?") IS at the bottom, so we anchor on THAT. Returns the same shape as
 * detectLimitState (kind:'prompt'), or null.
 *
 * False-positive guard kept: requires ≥2 numbered options whose LAST one is within
 * `anchorLines` of the bottom (a report quoting the prompt has the input box, not
 * a live menu, at the very bottom) AND a hard rate-limit marker (the slash command,
 * or a "limit" word paired with a wait option). G2 (not-working) runs before this.
 */
function detectRateLimitPrompt(nonEmpty, anchorLines, paneEngine = null) {
  const opts = [];
  for (let i = 0; i < nonEmpty.length; i++) {
    const m = nonEmpty[i].match(OPTION_LINE);
    if (m) opts.push({ i, n: parseInt(m[1], 10), label: m[2].replace(/[\s│|]+$/, '').trim() });
  }
  if (opts.length < 2) return null;
  // Anchored: the last option must sit at the LIVE bottom (not a scrolled report).
  const lastOptIdx = opts[opts.length - 1].i;
  if (nonEmpty.length - 1 - lastOptIdx > anchorLines) return null;
  // …and nothing but blank/box/footer may follow it. A prose sentence or an input
  // cursor below the menu = a report quoting the prompt, not a live menu → reject.
  if (!nonEmpty.slice(lastOptIdx + 1).every(isLiveMenuTrailing)) return null;

  const promptOptions = opts.map((o) => ({ n: o.n, label: o.label, kind: classifyOption(o.label) }));
  const hasWait = promptOptions.some((o) => o.kind === 'wait');
  const hasUpgrade = promptOptions.some((o) => o.kind === 'upgrade');

  // Context = a few lines above the first option down to the bottom (covers the
  // limit announcement + question header + the menu itself).
  const ctxStart = Math.max(0, opts[0].i - 4);
  const ctx = nonEmpty.slice(ctxStart).join('\n');
  const ctxLc = ctx.toLowerCase();

  // Hard rate-limit context (prose-proof). Any one of:
  //  • the /rate-limit-options or /upgrade slash marker, OR
  //  • a real "limit" word AND a graceful wait option, OR
  //  • the classic wait+upgrade option pair next to a reset/usage/credit word.
  // CDX-LIMIT-02 — `limits?`: codex başlığı ÇOĞUL basar ("Approaching rate
  // limits"); tekil \blimit\b "limits"e uymaz (b sınırı s'de düşer). Menü çapası +
  // wait seçeneği kapıları aynen durduğu için düzyazı koruması gevşemez.
  const isLimitPrompt =
    SLASH_LIMIT_MARKER.test(ctx) ||
    (/\blimits?\b/.test(ctxLc) && hasWait) ||
    (hasWait && hasUpgrade && /reset|usage|credit|upgrade|plan/.test(ctxLc));
  if (!isLimitPrompt) return null;

  // Reset time can be parsed from the whole tail now that this is a CONFIRMED
  // limit prompt (the announcement may be several lines above the menu).
  const base = extractReset(nonEmpty.join('\n'));
  const wait = promptOptions.find((o) => o.kind === 'wait');
  // CDX-LIMIT-02 — 'wait' yoksa KÖR basış YOK: eski fallback (ilk seçenek) codex
  // menüsünde "1. Switch to gpt-5.6-luna"yı seçerdi = yasak model geçişi. null →
  // _handlePrompt 'no-stop-option' yolundan BİLDİRİR ve hiçbir tuşa basmaz.
  const stopOption = wait ? wait.n : null;
  // raw = the limit announcement line if present, else the prompt question/first option.
  const rawLine =
    nonEmpty.slice(ctxStart).find((l) => LIMIT_LINE.test(l) || /\blimit\b/i.test(l)) ||
    nonEmpty.slice(ctxStart).find((l) => PROMPT_QUESTION.test(l)) ||
    opts[0].label;

  return {
    kind: 'prompt',
    raw: String(rawLine).trim(),
    resetClock: base.resetClock || null,
    resetRel: base.resetRel || null,
    resetAbs: base.resetAbs || null,
    resetDate: base.resetDate || null, // LIMIT-RESUME-02
    resetVia: base.resetVia || null, // LIMIT-RESUME-02
    engine: resolveEngine(paneEngine, nonEmpty.join('\n')),
    promptOptions,
    stopOption,
  };
}

/**
 * Robust limit detection for the daemon (ADP-089/098). Returns null unless the
 * live tail shows a genuine, stopped limit. On a hit returns:
 *   { kind:'plain'|'prompt', raw, resetClock, resetRel, engine,
 *     promptOptions:[{n,label,kind:'wait'|'upgrade'|'other'}], stopOption:n|null }
 * `stopOption` is the graceful "wait for reset" choice to select (preserve work,
 * don't burn credits). resetClock/resetRel feed the existing parseResetAt.
 *
 * Two paths (ADP-098): the INTERACTIVE rate-limit prompt (Format A) is detected
 * first by its anchored select block; failing that, a PLAIN standalone limit
 * status line (Format B + non-prompt plain text) via the G3/G4 gates.
 */
function detectLimitState(rawTail, opts = {}) {
  const maxLines = Number.isInteger(opts.maxLines) ? opts.maxLines : TAIL_LINES;
  const anchorLines = Number.isInteger(opts.anchorLines) ? opts.anchorLines : ANCHOR_LINES;
  // RES-03 — reset extraction gets its OWN, wider window (see RESET_SCAN_LINES).
  const resetMaxLines = Number.isInteger(opts.resetMaxLines)
    ? opts.resetMaxLines
    : Math.max(maxLines, RESET_SCAN_LINES);
  // ENG-01 — pane KAYDININ motoru (livePaneRegistry `engine` alanı). Verilirse
  // metin-tahmini HİÇ koşmaz; verilmezse bugünkü davranış (tahmin) aynen sürer.
  const paneEngine = opts.engine === 'codex' || opts.engine === 'claude' ? opts.engine : null;
  const tail = tailText(rawTail, maxLines);
  if (!tail) return null;
  if (isAgentWorking(tail)) return null; // G2

  const nonEmpty = tail
    .split('\n')
    .map((l) => l)
    .filter((l) => l.trim());

  // RES-03 — the clock, read from the WIDE window. Only ever consulted AFTER one
  // of the (unchanged) detection gates below has confirmed a real limit, so it
  // cannot manufacture a limit; it can only stop us losing the time we were shown.
  const wide = extractResetWide(rawTail, resetMaxLines);

  // (A) Format A — interactive /rate-limit-options prompt (anchored on the menu).
  const prompt = detectRateLimitPrompt(nonEmpty, anchorLines, paneEngine);
  if (prompt) {
    return {
      ...prompt,
      resetClock: wide.resetClock || prompt.resetClock,
      resetRel: wide.resetRel || prompt.resetRel,
      resetAbs: wide.resetAbs || prompt.resetAbs,
      resetDate: wide.resetDate || prompt.resetDate || null, // LIMIT-RESUME-02
      resetVia: wide.resetVia || prompt.resetVia || null, // LIMIT-RESUME-02
    };
  }

  // (B) Format B / plain — G3 standalone limit line, G4 anchored near the bottom.
  let hitIdx = -1;
  let hitLine = null;
  for (let k = nonEmpty.length - 1; k >= 0; k--) {
    if (LIMIT_LINE.test(nonEmpty[k])) {
      hitIdx = k;
      hitLine = nonEmpty[k];
      break;
    }
  }
  if (hitIdx === -1) return null;
  // G4 — the limit line must be near the bottom, not scrolled up behind output.
  if (nonEmpty.length - 1 - hitIdx > anchorLines) return null;

  // Parse reset time from the limit line + following context (engine-agnostic).
  const ctx = nonEmpty.slice(hitIdx).join('\n');
  const base = extractReset(ctx);

  return {
    kind: 'plain',
    raw: hitLine.trim(),
    resetClock: wide.resetClock || base.resetClock || null,
    resetRel: wide.resetRel || base.resetRel || null,
    resetAbs: wide.resetAbs || base.resetAbs || null,
    resetDate: wide.resetDate || base.resetDate || null, // LIMIT-RESUME-02
    resetVia: wide.resetVia || base.resetVia || null, // LIMIT-RESUME-02
    engine: resolveEngine(paneEngine, tail),
    promptOptions: [],
    stopOption: null,
  };
}

/**
 * LIMIT-RESUME-02 — which PHASE of Claude Code's own auto-continue the live tail
 * shows, or null. Read from the last `maxLines` lines (the live bottom), standalone
 * lines only (LEAD_NOISE-anchored, like G3) so a report quoting the band does not
 * count. NOT a limit detector: `stale`/`cancelled` are exactly the screens where
 * detectLimitState is silent (measured, RESEARCH-ACCT-01 §4.2) and the pane would
 * otherwise wait for a human Enter forever.
 *   { phase:'armed'|'stale'|'cancelled'|'again', raw }
 * Priority when several bands are on screen: the LOWEST one wins (newest state).
 */
function detectNativeContinueState(rawTail, opts = {}) {
  const maxLines = Number.isInteger(opts.maxLines) ? opts.maxLines : TAIL_LINES;
  const anchorLines = Number.isInteger(opts.anchorLines) ? opts.anchorLines : ANCHOR_LINES;
  const tail = tailText(rawTail, maxLines);
  if (!tail) return null;
  const lines = tail.split('\n').filter((l) => l.trim());
  const lead = new RegExp(LEAD_NOISE);
  // G4 — the band sits at the live bottom (above the input box), never scrolled up.
  for (let k = lines.length - 1; k >= Math.max(0, lines.length - 1 - anchorLines); k--) {
    const line = lines[k].replace(lead, '');
    let phase = null;
    if (NATIVE_AGAIN.test(line)) phase = 'again';
    else if (NATIVE_STALE.test(line)) phase = 'stale';
    else if (NATIVE_CANCELLED.test(line)) phase = 'cancelled';
    else if (NATIVE_ARMED.test(line)) phase = 'armed';
    if (phase) {
      // The armed band names the instant the CLI will act on — hand it up so the
      // daemon can arm its OWN clock from the party that actually knows it.
      const got = extractReset(lines.slice(k, k + 3).join('\n'));
      return {
        phase,
        raw: line.trim(),
        resetClock: got.resetClock || null,
        resetDate: got.resetDate || null,
        resetRel: got.resetRel || null,
        resetAbs: got.resetAbs || null,
        resetVia: got.resetVia || (got.resetClock || got.resetDate ? 'cli-band' : null),
      };
    }
  }
  return null;
}

module.exports = {
  stripAnsi,
  detectLimit,
  parseResetAt,
  nextEpochForClock,
  clockEpochs, // ADP-947 — rolledOver/clockAt (the +24h roll-forward trap)
  // ADP-938 — ICU-safe reset resolution + ConPTY-proof strip
  stripAnsiRobust,
  isUsableTimeZone,
  zoneClockParts,
  isSaneResetAt,
  resolveResetAt,
  MAX_RESET_AHEAD_MS,
  // ADP-089 robust layer
  TAIL_LINES,
  ANCHOR_LINES,
  tailText,
  // RES-02/03 — reset extraction window + live-bottom + answer classifier
  RESET_SCAN_LINES,
  LAST_FRAME_LINES,
  extractResetWide,
  lastFrameText,
  looksLikeLimitText,
  isAgentWorking,
  inferEngine,
  resolveEngine, // ENG-01 — kayıt önce, metin fallback
  healClockText,
  extractReset,
  parseAbsReset, // CDX-LIMIT-02 — codex'in mutlak reset tarihi ("Aug 30th, 2026 2:24 AM")
  // LIMIT-RESUME-02 — yılsız ay-gün, CLI bandı, otomatik-devam fazları
  parseMonthDayReset,
  zonedDateEpoch,
  isSaneDatedResetAt,
  MAX_DATED_RESET_AHEAD_MS,
  detectNativeContinueState,
  classifyOption,
  isLiveMenuTrailing,
  detectRateLimitPrompt,
  detectLimitState,
};
