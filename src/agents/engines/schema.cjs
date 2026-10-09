// ENG-04 (SPRINT-ENGINE-03) — Motor Tanımlayıcısı Şeması ve Sabitleri
'use strict';

/** Bir kaydın taşıyabileceği yetenek alanları (hepsi `null` olabilir = beyan). */
const CAPABILITY_KEYS = Object.freeze([
  'identity',
  'model',
  'effort',
  'images',
  'provider',
  'session',
  'subagentBlock',
  'contextScope',
  'trust',
  'reset',
  'tui',
  'mcp',
  'hooks',
  'extraRoots',
  'skillsDir',
  'identityEnv',
  'auth',
  'usage',
  'output',
  'install',
]);

/** Yetenek dışı zorunlu kimlik alanları. */
const REQUIRED_KEYS = Object.freeze(['id', 'label', 'bin', 'defaultArgs']);

/** Kaybı GÜVENLİK sorunu olan yetenekler. */
const SECURITY_CRITICAL_CAPABILITIES = Object.freeze(['identity', 'subagentBlock', 'mcp', 'trust']);

/** `verification` kanalları (ENG-R3 §14-R7). */
const VERIFICATION_CHANNELS = Object.freeze(['measured', 'source', 'doc', 'unverified']);

/** ENG-20 — Otonomi seviyeleri ve uygulama kanalları. */
const AUTONOMY_LEVELS = Object.freeze(['full', 'partial', 'unknown']);
const AUTONOMY_CHANNELS = Object.freeze(['argv', 'env', 'config', null]);

/** Taşıyıcı ve yetenek enum'ları (ENG-R2 §9-2). */
const IDENTITY_KINDS = Object.freeze(['flag', 'flag-dir', 'env-file', 'project-file', 'positional', 'none']);
const MCP_KINDS = Object.freeze([
  'config-file',
  'config-profile',
  'cli-overrides',
  'cli-command',
  'workspace-plugin',
  'config-only',
  'env-config',
  'env-config-dir',
  'none',
]);
const IDENTITY_ENV_TARGETS = Object.freeze(['dir', 'file', 'json-config', 'json-config-dir']);
const OUTPUT_KINDS = Object.freeze(['json', 'jsonl', 'text']);
const OUTPUT_STDIN_MODES = Object.freeze(['ignore', 'pipe']);
const EFFORT_KINDS = Object.freeze(['flag', 'cli-override']);
const BASE_PROMPT_KINDS = Object.freeze(['self-dump', 'ledger-dump']);
const BASE_PROMPT_FAILURE_MODES = Object.freeze(['skip-identity']);
const AUTH_FLOWS = Object.freeze(['oauth-code', 'oauth-callback', 'api-key', 'external', 'device-code']);
const STATUS_PARSERS = Object.freeze(['json', 'text', 'exit-code']);
const USAGE_KINDS = Object.freeze(['session-ledger', 'time-window', 'cli-report', 'run-envelope', 'none']);
const USAGE_LEVELS = Object.freeze(['exact', 'approx', 'reported', 'none']);
const USAGE_CONTENTS = Object.freeze(['transcript', 'counters']);
const BILLING_MODES = Object.freeze(['subscription', 'api', 'vendor-hosted', 'unknown']);
const VENDOR_GATE_POLICIES = Object.freeze(['allow', 'block']);
const VENDOR_HOSTED_DETECTORS = Object.freeze(['credentials-file']);
const ISOLATION_KINDS = Object.freeze(['pane-file', 'pane-dir']);

module.exports = {
  CAPABILITY_KEYS,
  REQUIRED_KEYS,
  SECURITY_CRITICAL_CAPABILITIES,
  VERIFICATION_CHANNELS,
  AUTONOMY_LEVELS,
  AUTONOMY_CHANNELS,
  IDENTITY_KINDS,
  MCP_KINDS,
  IDENTITY_ENV_TARGETS,
  OUTPUT_KINDS,
  OUTPUT_STDIN_MODES,
  EFFORT_KINDS,
  BASE_PROMPT_KINDS,
  BASE_PROMPT_FAILURE_MODES,
  AUTH_FLOWS,
  STATUS_PARSERS,
  USAGE_KINDS,
  USAGE_LEVELS,
  USAGE_CONTENTS,
  BILLING_MODES,
  VENDOR_GATE_POLICIES,
  VENDOR_HOSTED_DETECTORS,
  ISOLATION_KINDS,
};
