'use strict';

const holderShell = require('../../../platform/holderShell.cjs');
const systemPromptCap = require('../../../platform/systemPromptCap.cjs');
const engineRegistryModule = require('../engineRegistry.cjs');
const { getEngineRegistry, engineCapability } = require('./registryBridge.cjs');

const ALLOWED_COMMANDS = Object.freeze({
  shell: null, // → $SHELL, today's ADP-003 behavior (backward compatible)
  claude: 'claude',
  codex: 'codex',
  copilot: 'copilot', // ENG-12 — GitHub Copilot CLI (@github/copilot, ölçüldü: 1.0.80)
  goose: 'goose', // ENG-13 — Goose (block/goose, ölçüldü: 1.46.0)
  droid: 'droid', // ENG-13 — Droid / Factory CLI (ölçüldü: 0.197.0)
  gemini: 'gemini', // ENG-14 — Gemini CLI (@google/gemini-cli, ölçüldü: 0.55.1)
  qwen: 'qwen', // ENG-14 — Qwen Code (@qwen-code/qwen-code, ölçüldü: 0.21.13)
  opencode: 'opencode', // ENG-16 — OpenCode (opencode-ai, ölçüldü: 1.18.18)
  amp: 'amp', // ENG-16 — Amp (@ampcode/cli, ölçüldü: 0.0.1786968161-gdd03ae)
  cursor: 'cursor-agent', // ENG-17 — Cursor CLI (ölçüldü: 2026.08.11-e8db854)
  kimi: 'kimi', // ENG-17 — Kimi Code (@moonshot-ai/kimi-code, ölçüldü: 0.36.1)
  crush: 'crush', // ENG-17 — Crush (@charmland/crush, ölçüldü: v0.89.0)
  antigravity: 'agy', // ENG-22 — Antigravity CLI (antigravity.google, ölçüldü: 1.1.14)
  muse: 'muse', // ENGINE-MUSE-02 — Muse Code (dev.meta.ai, ölçüldü: 1.0.3-R2198.1)
});

const DEFAULT_AGENT_ARGS = Object.freeze(
  Object.fromEntries(
    engineRegistryModule
      .engineIds()
      .map((id) => [id, Object.freeze([...(engineRegistryModule.getEngine(id).defaultArgs || [])])]),
  ),
);

/**
 * Bu motorun varsayılan argv'si (çağıran kendi args'ını vermediyse). Defter ENJEKTE
 * edilebildiği için sabit değil FONKSİYON: sahte/eksik motorlu koşuda da doğru cevap.
 */
function defaultArgsFor(commandKey) {
  const reg = getEngineRegistry();
  const d = reg && reg.getEngine ? reg.getEngine(commandKey) : null;
  return d && Array.isArray(d.defaultArgs) ? [...d.defaultArgs] : [];
}

const MAX_SYSTEM_PROMPT_LEN = systemPromptCap.CLI_MAX;

const MAX_ARGS = 64;
const MAX_ARG_LEN = 8192;
const MAX_ENV_KEYS = 64;

const IDLE_AFTER_MS = 4000;

/** True for a command the renderer is allowed to ask for. */
function isAllowedCommand(command) {
  return Object.prototype.hasOwnProperty.call(ALLOWED_COMMANDS, command);
}

/**
 * Resolve a requested command to a spawn target.
 * - undefined/null/'shell' → the login shell (agent=false).
 * - a whitelisted agent key → that binary (agent=true).
 * - anything else → THROW (RCE guard).
 */
function resolveCommand(command, deps = {}) {
  if (command === undefined || command === null || command === 'shell') {
    const platform = deps.platform || process.platform;
    const env = deps.env || process.env;
    if (platform === 'win32') {
      return { key: 'shell', file: holderShell.powershellPath(env), isAgent: false };
    }
    return { key: 'shell', file: env.SHELL || 'zsh', isAgent: false };
  }
  if (typeof command !== 'string' || !isAllowedCommand(command)) {
    throw new Error(`pty:spawn rejected disallowed command: ${JSON.stringify(command)}`);
  }
  return { key: command, file: ALLOWED_COMMANDS[command], isAgent: true };
}

/**
 * Sanitize an agent identity / system-prompt string: must be a non-empty string,
 * trimmed and length-capped. Returns null for anything unusable (→ no injection).
 */
function sanitizeSystemPrompt(text, cap = MAX_SYSTEM_PROMPT_LEN) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  return systemPromptCap.clampSystemPrompt(trimmed, cap);
}

const MAX_MODEL_LEN = 64;

/**
 * Bir model adını/id'sini normalize + biçim-whitelist et.
 */
function sanitizeModel(value, commandKey) {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (!t || t.length > MAX_MODEL_LEN) return null;
  const d = commandKey ? engineCapability(commandKey, 'model') : null;
  const pattern = d && typeof d.valuePattern === 'string' && d.valuePattern.trim() ? d.valuePattern : null;
  if (pattern) {
    let re;
    try {
      re = new RegExp(pattern);
    } catch {
      return null;
    }
    if (/[\s\u0000-\u001f]/.test(t) || /(^|\/)\.\.(\/|$)/.test(t) || /(^|\/)-/.test(t)) return null;
    return re.test(t) ? t : null;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9]+\])?$/.test(t)) return null;
  return t;
}

/** Accept only a bounded array of plain strings; otherwise null (→ defaults). */
function sanitizeArgs(args) {
  if (!Array.isArray(args)) return null;
  if (args.length > MAX_ARGS) return null;
  for (const a of args) {
    if (typeof a !== 'string' || a.length > MAX_ARG_LEN) return null;
  }
  return args.slice();
}

module.exports = {
  ALLOWED_COMMANDS,
  DEFAULT_AGENT_ARGS,
  defaultArgsFor,
  MAX_SYSTEM_PROMPT_LEN,
  MAX_ARGS,
  MAX_ARG_LEN,
  MAX_ENV_KEYS,
  IDLE_AFTER_MS,
  isAllowedCommand,
  resolveCommand,
  sanitizeSystemPrompt,
  MAX_MODEL_LEN,
  sanitizeModel,
  sanitizeArgs,
};
