'use strict';

const crypto = require('node:crypto');
const modelCatalog = require('../modelCatalog.cjs');
const providers = require('../providers.cjs');
const { sanitizeModel } = require('./commandWhitelist.cjs');
const { engineCapability } = require('./registryBridge.cjs');
const { applyArgs, repeatFlagArgs, tomlBasicString } = require('./spawnArgs.cjs');
const { leaderSignal, isLeaderSpawn } = require('./leaderDetector.cjs');

function withModel(argv, commandKey, model) {
  const m = sanitizeModel(model, commandKey);
  if (!m) return argv;
  const d = engineCapability(commandKey, 'model');
  if (!d || d.kind !== 'flag' || !d.flag) return argv;
  return applyArgs(argv, [d.flag, m], d.position);
}

function sanitizeEffort(value, descriptor) {
  if (typeof value !== 'string') return null;
  const t = value.trim().toLowerCase();
  if (!t) return null;
  const values = descriptor && Array.isArray(descriptor.values) ? descriptor.values : [];
  return values.find((v) => typeof v === 'string' && v.toLowerCase() === t) || null;
}

function resolveEffort(commandKey, effort, model) {
  const d = engineCapability(commandKey, 'effort');
  const v = sanitizeEffort(effort, d);
  if (!v) return null;
  if (!d.catalog) return v;
  const allowed = modelCatalog.effortValuesFor(commandKey, sanitizeModel(model, commandKey), d.values);
  return allowed.some((a) => a.toLowerCase() === v.toLowerCase()) ? v : null;
}

function withEffort(argv, commandKey, effort, model) {
  const d = engineCapability(commandKey, 'effort');
  if (!d || !d.flag) return argv;
  const v = resolveEffort(commandKey, effort, model);
  if (!v) return argv;
  if (d.kind === 'cli-override') {
    if (!d.key) return argv;
    return applyArgs(argv, [d.flag, `${d.key}=${tomlBasicString(v)}`], d.position);
  }
  if (d.kind === 'flag') return applyArgs(argv, [d.flag, v], d.position);
  return argv;
}

function withProvider(argv, commandKey, providerId, model, custom) {
  const d = engineCapability(commandKey, 'provider');
  if (!d || d.kind !== 'cli-overrides') return argv;
  if (!providers.isProvider(providerId, custom)) return argv;
  if (!sanitizeModel(model, commandKey)) return argv;
  return applyArgs(argv, providers.codexProviderArgs(providerId, custom), d.position);
}

function withImages(argv, commandKey, imagePaths) {
  const d = engineCapability(commandKey, 'images');
  if (!d || d.kind !== 'flag' || !d.flag) return argv;
  const flags = repeatFlagArgs(d.flag, imagePaths, d.repeat);
  return flags.length ? applyArgs(argv, flags, d.position) : argv;
}

function terminateImageList(argv, commandKey) {
  const d = engineCapability(commandKey, 'images');
  if (!d || !d.variadic || !d.terminator || !Array.isArray(argv)) return argv;
  if (argv.includes(d.terminator)) return argv;
  const tokens = [d.flag, ...(Array.isArray(d.aliases) ? d.aliases : [])];
  let last = -1;
  for (let i = 0; i < argv.length; i += 1) {
    if (tokens.includes(argv[i])) last = i;
  }
  if (last < 0) return argv;
  const after = last + 2;
  if (after >= argv.length) return argv;
  const next = argv[after];
  if (typeof next === 'string' && next.startsWith('-')) return argv;
  return [...argv.slice(0, after), d.terminator, ...argv.slice(after)];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DISABLE_SESSION_ID_ENV = 'CREWPANE_DISABLE_SESSION_ID';

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function withSessionId(argv, commandKey, opts, env) {
  const d = engineCapability(commandKey, 'session');
  if (!d || d.mint !== 'uuid' || !d.flag) return { argv, sessionId: null };
  const e = env || process.env;
  const killSwitch = d.killSwitchEnv || DISABLE_SESSION_ID_ENV;
  if (e && e[killSwitch]) return { argv, sessionId: null };
  const provided = opts && isUuid(opts.sessionId) ? opts.sessionId : null;
  const sessionId = provided || crypto.randomUUID();
  return { argv: [...argv, d.flag, sessionId], sessionId };
}

function isResumeSpawn(opts, commandKey) {
  if (!opts || opts.resume !== true) return false;
  const r = (engineCapability(commandKey, 'session') || {}).resume;
  if (!r) return false;
  if (r.idShape === 'uuid') return isUuid(opts.sessionId);
  return typeof opts.sessionId === 'string' && opts.sessionId.length > 0;
}

const DEAD_SESSION_SIGNATURE = /no conversation found/i;
const DEAD_SESSION_WINDOW_MS = 60_000;

function isDeadSessionExit({ buffer, exitCode, uptimeMs }) {
  if (!exitCode) return false;
  if (!Number.isFinite(uptimeMs) || uptimeMs > DEAD_SESSION_WINDOW_MS) return false;
  return DEAD_SESSION_SIGNATURE.test(typeof buffer === 'string' ? buffer : '');
}

function appendResume(argv, commandKey, sessionId) {
  const r = (engineCapability(commandKey, 'session') || {}).resume;
  if (!r) return argv;
  if (r.form === 'subcommand') {
    const id = typeof sessionId === 'string' ? sessionId.replace(/[^A-Za-z0-9_-]/g, '') : '';
    if (id) return [r.subcommand, id, ...argv];
    return [...(r.lastFallback || [r.subcommand]), ...argv];
  }
  return applyArgs(argv, r.idFlag ? [r.flag, r.idFlag, sessionId] : [r.flag, sessionId], 'append');
}

module.exports = {
  withModel,
  sanitizeEffort,
  resolveEffort,
  withEffort,
  withProvider,
  withImages,
  terminateImageList,
  UUID_RE,
  DISABLE_SESSION_ID_ENV,
  isUuid,
  withSessionId,
  isResumeSpawn,
  DEAD_SESSION_SIGNATURE,
  DEAD_SESSION_WINDOW_MS,
  isDeadSessionExit,
  appendResume,
  leaderSignal,
  isLeaderSpawn,
};
