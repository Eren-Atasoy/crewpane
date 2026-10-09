// CrewPane — Engine API Key Verification, Storage, and Lifecycle Actions.
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { STATUS_TIMEOUT_MS, maskSecrets } = require('./constants.cjs');
const { authDescriptor } = require('./descriptors.cjs');
const { apiKeyStoreOf, apiKeyEnvFor } = require('./apiKeyVault.cjs');
const { resolveBin, binErrorFor, execTarget, withVerbatim, execEnv } = require('./engineBin.cjs');
const { readStatus } = require('./statusProber.cjs');

/**
 * ENG-CURSOR-APIKEY-01 — motorun KENDİ ret cümlesini kullanıcıya taşınabilir hâle getirir.
 */
function engineMessageOf(output) {
  const lines = String(output || '')
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^[\s⚠✗✓×!•·-]+/u, '').replace(/^(warning|error)\s*:\s*/i, '').trim())
    .filter(Boolean);
  if (!lines.length) return null;
  const first = lines[0];
  return first.length > 160 ? `${first.slice(0, 157)}…` : first;
}

/**
 * ENG-CURSOR-APIKEY-01 — anahtarı motorun `apiKeyVerifyArgv` komutuyla DOĞRULAR.
 */
async function verifyApiKey(engine, deps = {}) {
  const desc = authDescriptor(engine, deps);
  if (!desc || !desc.apiKey || !desc.apiKeyVerifyArgv) return null;
  const bin = await resolveBin(engine, deps);
  if (!bin || !bin.found) return { ok: false, code: null, message: null, error: binErrorFor(bin) };
  const exec = deps.execFile || execFile;
  const target = execTarget(bin, [...desc.apiKeyVerifyArgv], deps);
  const env = { ...execEnv(deps), ...apiKeyEnvFor(engine, deps) };
  const timeoutMs = deps.verifyTimeoutMs || deps.timeoutMs || STATUS_TIMEOUT_MS;
  const result = await new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => done({ err: new Error('timeout'), stdout: '', code: null }), timeoutMs);
    try {
      exec(target.file, target.argv, withVerbatim(target, { timeout: timeoutMs, env }), (err, stdout, stderr) => {
        clearTimeout(timer);
        done({ err, stdout: `${stdout || ''}${stderr || ''}`, code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0) });
      });
    } catch (e) {
      clearTimeout(timer);
      done({ err: e, stdout: '', code: null });
    }
  });
  if (result.code === null) return { ok: false, code: null, message: null, error: 'probe-failed' };
  const message = result.code === 0 ? null : maskSecrets(engineMessageOf(result.stdout) || '') || null;
  return { ok: result.code === 0, code: result.code, message, error: result.code === 0 ? null : 'key-rejected' };
}

/**
 * Motorun API anahtarını KAYDEDER ve SONUCU DOĞRULAR.
 */
async function setApiKey(engine, key, deps = {}) {
  const desc = authDescriptor(engine, deps);
  const log = deps.log || (() => {});
  if (!desc) return { ok: false, error: 'unsupported-engine', status: null };
  if (!desc.apiKey) return { ok: false, error: 'no-api-key-flow', status: null };
  const clean = typeof key === 'string' ? key.trim() : '';
  if (!clean) return { ok: false, error: 'empty-key', status: null };
  const store = apiKeyStoreOf(deps);
  if (!store) return { ok: false, error: 'vault-unavailable', status: null };

  const service = desc.apiKey.vaultService;
  const previous = store.readKey(service);
  const saved = await store.saveKey(service, clean, { keyLabel: desc.apiKey.keyLabel || desc.label });
  if (!saved.ok) return { ok: false, error: saved.error || 'vault-write-failed', status: null };

  const verify = await verifyApiKey(engine, deps);
  if (verify && !verify.ok) {
    if (previous) await store.saveKey(service, previous, { keyLabel: desc.apiKey.keyLabel || desc.label });
    else await store.clearKey(service);
    log(maskSecrets(`engineAuth ${engine} api-key DOĞRULANAMADI (${verify.error}, rc=${verify.code}) → geri alındı`));
    return { ok: false, error: verify.error, engineMessage: verify.message, status: await readStatus(engine, deps) };
  }

  const status = await readStatus(engine, deps);
  if (status.loggedIn || (verify && verify.ok)) {
    log(maskSecrets(`engineAuth ${engine} api-key kaydedildi ve doğrulandı (env=${desc.apiKey.env})`));

    // F8: Antigravity — settings.json'a modelProvider yazması gerekli
    if (engine === 'antigravity') {
      const home = process.env.HOME || process.env.USERPROFILE || '';
      const configDir = path.join(home, '.gemini', 'antigravity-cli');
      const configFile = path.join(configDir, 'settings.json');
      try {
        await fs.mkdir(configDir, { recursive: true });
        const settings = { modelProvider: 'gemini' };
        await fs.writeFile(configFile, JSON.stringify(settings, null, 2), 'utf8');
        log(`antigravity settings.json yazıldı: ${configFile}`);
      } catch (e) {
        log(`antigravity settings.json yazma hatası: ${e.message}`);
      }
    }

    return { ok: true, status };
  }

  if (previous) await store.saveKey(service, previous, { keyLabel: desc.apiKey.keyLabel || desc.label });
  else await store.clearKey(service);
  log(maskSecrets(`engineAuth ${engine} api-key DOĞRULANAMADI → geri alındı`));
  return { ok: false, error: status.error || 'key-rejected', engineMessage: null, status: await readStatus(engine, deps) };
}

/** Kayıtlı API anahtarını siler ve sonucu motorun durum komutuyla DOĞRULAR. */
async function clearApiKey(engine, deps = {}) {
  const desc = authDescriptor(engine, deps);
  if (!desc) return { ok: false, error: 'unsupported-engine', status: null };
  if (!desc.apiKey) return { ok: false, error: 'no-api-key-flow', status: null };
  const store = apiKeyStoreOf(deps);
  if (!store) return { ok: false, error: 'vault-unavailable', status: null };
  const r = await store.clearKey(desc.apiKey.vaultService);
  const status = await readStatus(engine, deps);
  return { ok: r.ok, error: r.ok ? null : r.error, status };
}

module.exports = {
  engineMessageOf,
  verifyApiKey,
  setApiKey,
  clearApiKey,
};
