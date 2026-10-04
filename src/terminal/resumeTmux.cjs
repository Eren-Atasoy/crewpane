// CrewPane — ADP-088 (ADR-007 Faz 2) tmux resume adapter.
//
// The tmux side of the resume-core / two-adapter split (ADR §6). The autopilot
// workers Optimus actually runs live in tmux panes (spawn-worker), so this is the
// URGENT runtime. It turns a queue entry into the concrete `claude --resume
// <uuid>` continuation and drives it via tmux capture-pane / send-keys.
//
//   • PURE builders (buildResumeCommand, encodeCwd, claudeProjectsDir, …) → unit
//     tested with no tmux/claude (resumeTmux.test.cjs).
//   • Side-effect wrappers (capturePane, sendResume, paneCurrentCommand) → thin
//     child_process shells; the tmux/claude binaries are env-overridable
//     (CREWPANE_TMUX_BIN) so the e2e fixture can drive a real flow without a
//     real limit (ADR §9 / verification-must-be-interactive).
//
// Resume is `claude --resume <uuid>` — a CONTINUE in the SAME pane (ADR §5.1):
// context preserved, half-done work is NOT restarted. The session id is the one
// minted at spawn (pty path) or, for a tmux worker spawn-worker did not mint,
// resolved from the newest `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`
// filename (ADR §4 YEDEK source, POC-verified).

'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a canonical v4-shaped UUID string. */
function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Resolve the tmux binary (env override lets the e2e fixture inject a fake). */
function tmuxBin() {
  return process.env.CREWPANE_TMUX_BIN || 'tmux';
}

/**
 * Encode an absolute cwd to claude's projects-dir folder name: every '/' and ' '
 * becomes '-' (ADR §4, POC-verified: ".../CrewPane Apps/crewpane" →
 * "-Users-…-CrewPane-Apps-crewpane").
 */
function encodeCwd(cwd) {
  return String(cwd || '').replace(/[/ ]/g, '-');
}

/** ~/.claude/projects/<encoded-cwd> — where claude stores this cwd's sessions. */
function claudeProjectsDir(cwd, homedir) {
  return path.join(homedir || os.homedir(), '.claude', 'projects', encodeCwd(cwd));
}

// ADP-089: two jsonl sessions touched within this window of `now` in the SAME cwd
// = ambiguous (e.g. lead + worker both in crewpane/). Refuse to guess (return
// null) so the daemon skips + notifies rather than resuming the wrong session.
const SESSION_AMBIGUITY_MS = 10 * 60_000;

/**
 * The id of the most-recently-active claude session for `cwd` = the newest
 * `<uuid>.jsonl` filename in its projects dir (ADR §4: filename == sessionId,
 * POC-verified). The YEDEK source for a tmux worker whose spawn did not mint a
 * session id. Returns null if the dir/file is missing.
 *
 * ADP-089 cross-pane isolation: if TWO+ sessions for this cwd were modified within
 * SESSION_AMBIGUITY_MS of `now`, we cannot safely attribute one to this pane (the
 * incident: lead + worker share cwd) → return null instead of risking the wrong
 * session. An authoritative registry sessionId (resumePaneRegistry) bypasses this.
 * @param {object} [opts] { now, ambiguityMs }
 */
function resolveSessionIdFromJsonl(cwd, homedir, opts = {}) {
  try {
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const ambiguityMs = Number.isFinite(opts.ambiguityMs) ? opts.ambiguityMs : SESSION_AMBIGUITY_MS;
    const dir = claudeProjectsDir(cwd, homedir);
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl') && isUuid(f.slice(0, -'.jsonl'.length)))
      .map((f) => ({ id: f.slice(0, -'.jsonl'.length), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (!files.length) return null;
    const recent = files.filter((f) => now - f.mtime <= ambiguityMs);
    if (recent.length >= 2) return null; // ambiguous → caller skips (no cross-pane leak)
    return files[0].id;
  } catch {
    return null;
  }
}

// AD-WIN-02 SÜPÜRMESİ — burada tek tırnak DOĞRUDUR ve öyle KALIYOR: bu metin bir
// tmux pane'ine `send-keys` ile YAZILIYOR, yani onu ayrıştıran şey pane'in POSIX
// kabuğudur. Windows'ta tmux YOKTUR (bu adaptör orada hiç koşmaz), dolayısıyla
// cmd.exe hiçbir zaman bu dizeyi görmez. mcpNode'daki `dual` tırnaklama HOOK
// komutu içindir — oradaki metni claude'un seçtiği kabuk ayrıştırır, bilmediğimiz.
/** Shell-quote a cwd for `cd '<cwd>'` (single-quote is the only metachar that matters). */
function safeCwd(cwd) {
  const c = typeof cwd === 'string' && cwd ? cwd : os.homedir();
  return c.replace(/'/g, `'\\''`);
}

/**
 * The single shell line that resumes an EXITED engine in its pane (ADR §5.1 —
 * continue, not restart). PER-ENGINE (ADP-089 req #4):
 *   claude → `cd '<cwd>' && claude --resume <uuid> --dangerously-skip-permissions`
 *            (needs a real uuid session id; null otherwise → daemon backs off)
 *   codex  → `cd '<cwd>' && codex resume <id>`  (or `codex resume --last` when the
 *            id is unknown — ADR R4 best-effort; codex `resume` verified via CLI)
 * uuid is regex-validated so it cannot inject; codex ids are alnum-sanitized.
 */
function buildResumeCommand(entry) {
  const e = entry && typeof entry === 'object' ? entry : {};
  const cwd = safeCwd(e.cwd);
  if (e.engine === 'codex') {
    const id = typeof e.sessionId === 'string' ? e.sessionId.replace(/[^A-Za-z0-9_-]/g, '') : '';
    return id
      ? `cd '${cwd}' && codex resume ${id}`
      : `cd '${cwd}' && codex resume --last`;
  }
  if (!isUuid(e.sessionId)) return null;
  return `cd '${cwd}' && claude --resume ${e.sessionId} --dangerously-skip-permissions`;
}

/**
 * Text to TYPE into a still-LIVE engine TUI to nudge it to continue after a limit
 * pause (ADR §5.2 / ADP-089 continue-vs-resume). When the engine never exited
 * (pane still in claude/codex), we don't re-launch — we just type a continue
 * message at its prompt. Kept Turkish to match how Optimus drives workers.
 */
function buildContinueText() {
  return 'devam et — limit yenilendi, kaldığın yerden sürdür';
}

/** Commands that mean a pane is still busy running an engine (spawn-worker §205). */
const BUSY_COMMANDS = Object.freeze(['claude', 'codex', 'node', 'python']);

/** Shells — a pane sitting at one of these means the engine has EXITED (→ --resume). */
const SHELL_COMMANDS = Object.freeze(['zsh', '-zsh', 'bash', '-bash', 'sh', '-sh', 'fish']);

// ADP-180 — the PROVEN prod root-cause: a LIVE `claude` pane reports its
// `pane_current_command` as its VERSION (e.g. "2.1.185"), NOT "claude" — claude
// renames its own process. So the old BUSY_COMMANDS-only check classified every
// live claude pane as 'other'→'shell'→`--resume` (which needs a uuid it couldn't
// resolve) → the reset-time continue NEVER landed. A bare "x.y" / "x.y.z" command
// name is therefore treated as a live engine.
const VERSION_COMMAND = /^\d+\.\d+(?:\.\d+)?$/;

/**
 * Liveness of the limited engine in a pane (ADP-089 continue-vs-resume):
 *   'live'  → engine TUI still attached (claude/codex/node, or claude's version-
 *             named process) → type a continue nudge
 *   'shell' → back at a shell prompt (engine exited)         → run `--resume`
 *   'other' → unknown command
 * ADP-180: prefer CONTENT (`text`) when supplied — the captured pane showing the
 * engine's TUI is a far more robust signal than the (version-renamed) process name.
 */
function paneLiveness(paneRef, text) {
  if (typeof text === 'string' && text.trim()) {
    const byText = livenessFromText(text);
    if (byText !== 'other') return byText;
  }
  const cmd = paneCurrentCommand(paneRef);
  if (BUSY_COMMANDS.includes(cmd) || VERSION_COMMAND.test(cmd)) return 'live';
  if (SHELL_COMMANDS.includes(cmd)) return 'shell';
  return 'other';
}

// ADP-180 — TUI markers proving an engine (claude/codex) is still attached in the
// pane, even sitting at a limit/rate-limit prompt: the bypass-permissions footer,
// the interrupt hint, the rate-limit slash commands, the boxed input border + the
// prompt cursor. These survive the version-named-process problem entirely.
const ENGINE_TUI_MARKER = new RegExp(
  [
    '⏵⏵',
    'bypass permissions on',
    'esc to interrupt',
    'shift\\+tab to cycle',
    '\\? for shortcuts',
    '/rate-?limit-?options',
    '/upgrade\\b',
    'to manage\\b',
  ].join('|'),
  'i',
);
// A boxed TUI input row: a vertical border next to the prompt cursor.
const BOXED_PROMPT = /[│┃|]\s*[❯>]/;
// The LAST non-empty line is a bare shell prompt → the engine exited to the shell.
// Either ENDS in a prompt sigil (%, $, #, ➜, ») — bash/zsh "user@host % " — or
// STARTS with an arrow sigil (➜/») — oh-my-zsh "➜  repo git:(dev) ".
const SHELL_PROMPT_LINE = /[%$#➜»]\s*▌?\s*$|^[➜»]\s/;

/**
 * ADP-180 — classify pane liveness from its CAPTURED CONTENT (robust to claude
 * renaming its process to its version). Returns 'live' | 'shell' | 'other'.
 * 'other' (no decisive signal) lets the caller fall back to the process-name check.
 */
function livenessFromText(text) {
  const t = typeof text === 'string' ? text : '';
  if (!t.trim()) return 'other';
  if (ENGINE_TUI_MARKER.test(t) || BOXED_PROMPT.test(t)) return 'live';
  const lastLine =
    t
      .replace(/\r/g, '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .pop() || '';
  if (SHELL_PROMPT_LINE.test(lastLine)) return 'shell';
  return 'other';
}

/**
 * Select an option in a live 2-option limit prompt (ADP-089 req #2): send the
 * digit then Enter. We pick the graceful "wait/stop" option so the session/work
 * is preserved and credits aren't burned. Returns true on success.
 */
function selectOption(paneRef, n) {
  if (typeof paneRef !== 'string' || !paneRef) return false;
  if (!Number.isInteger(n) || n < 1 || n > 9) return false;
  return sendKeys(paneRef, String(n));
}

/** `pane_current_command` for a tmux target, or '' on any error. */
function paneCurrentCommand(paneRef) {
  try {
    const r = spawnSync(
      tmuxBin(),
      ['display-message', '-p', '-t', paneRef, '#{pane_current_command}'],
      { encoding: 'utf8' },
    );
    return (r.stdout || '').trim();
  } catch {
    return '';
  }
}

/** True if the pane still has an engine/process attached (resume must wait/clear). */
function isPaneBusy(paneRef) {
  return BUSY_COMMANDS.includes(paneCurrentCommand(paneRef));
}

/** Capture the visible pane contents (the daemon's detect/verify input). '' on error. */
function capturePane(paneRef) {
  try {
    const r = spawnSync(tmuxBin(), ['capture-pane', '-p', '-t', paneRef], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout || '' : '';
  } catch {
    return '';
  }
}

/** Send a literal command + Enter to a pane (tmux send-keys). Returns true on success. */
function sendKeys(paneRef, text) {
  try {
    const r = spawnSync(tmuxBin(), ['send-keys', '-t', paneRef, text, 'Enter'], { encoding: 'utf8' });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Fire the resume for an entry in its tmux pane (ADR §5.2 pane reuse, ADP-089
 * continue-vs-resume). Liveness decides the action:
 *   • engine still LIVE in the TUI → type a continue nudge at its prompt (no
 *     relaunch; context is already in RAM). mode='continue'.
 *   • engine EXITED (shell)        → run `<engine> --resume <id>` (mode='resume').
 * Returns { ok, command, mode }. ok=false → nothing usable to run (e.g. resume
 * needs a session id we don't have → daemon backs off / notifies).
 * @param {object} [opts] { liveness } override (tests inject; default: detect)
 */
function sendResume(entry, opts = {}) {
  const e = entry && typeof entry === 'object' ? entry : {};
  const paneRef = e.paneRef;
  if (typeof paneRef !== 'string' || !paneRef) return { ok: false, command: null, mode: null };

  const liveness = opts.liveness || paneLiveness(paneRef);
  if (liveness === 'live') {
    // Engine TUI still attached → just nudge it to continue (ADR §5.2).
    const text = buildContinueText();
    const ok = sendKeys(paneRef, text);
    return { ok, command: text, mode: 'continue' };
  }

  // Engine exited → relaunch with full context via --resume.
  const command = buildResumeCommand(e);
  if (!command) return { ok: false, command: null, mode: 'resume' };
  if (opts.clearIfBusy !== false && isPaneBusy(paneRef)) {
    // Ctrl-C any lingering process, then the resume command at a fresh prompt.
    try {
      spawnSync(tmuxBin(), ['send-keys', '-t', paneRef, 'C-c'], { encoding: 'utf8' });
    } catch {
      /* best-effort */
    }
  }
  const ok = sendKeys(paneRef, command);
  return { ok, command, mode: 'resume' };
}

module.exports = {
  isUuid,
  tmuxBin,
  encodeCwd,
  claudeProjectsDir,
  SESSION_AMBIGUITY_MS,
  resolveSessionIdFromJsonl,
  safeCwd,
  buildResumeCommand,
  buildContinueText,
  BUSY_COMMANDS,
  SHELL_COMMANDS,
  paneCurrentCommand,
  isPaneBusy,
  paneLiveness,
  livenessFromText,
  selectOption,
  capturePane,
  sendKeys,
  sendResume,
};
