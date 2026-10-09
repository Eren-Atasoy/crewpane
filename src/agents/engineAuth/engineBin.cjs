// CrewPane — Engine Binary Resolution and Process Invocation Helpers.
'use strict';

const engineCheck = require('../engineCheck.cjs');
const engineInstall = require('../engineInstall.cjs');
const envPath = require('../../../platform/envPath.cjs');

/**
 * Motorun ikilisini KULLANICININ LOGIN SHELL'i üzerinden çözer.
 */
function resolveBin(engine, deps = {}) {
  const env = deps.env || process.env;
  if (env.CREWPANE_FAKE_ENGINE_BIN === '1') {
    const override = env[`CREWPANE_ENGINE_BIN_${String(engine).toUpperCase()}`];
    if (typeof override === 'string' && override.trim()) {
      return Promise.resolve({ found: true, path: override.trim(), state: 'present' });
    }
  }
  if (deps.resolveBin) return Promise.resolve(deps.resolveBin(engine));
  return engineCheck.probeOne(engine, deps);
}

/**
 * ENG-ACC-P1 — MOTOR KOMUTLARININ KOŞACAĞI ENV.
 */
function execEnv(deps = {}) {
  return envPath.withAugmentedPath(deps.env || process.env, {
    platform: deps.platform || process.platform,
    home: deps.home,
  });
}

/**
 * ADP-833 (ADR-W7) — probe sonucu ÜÇ-DURUMLU: "yok" ile "ölçemedim" ayrı hatalardır.
 */
function binErrorFor(bin) {
  return bin && bin.state === 'unknown' ? 'check-failed' : 'not-installed';
}

/**
 * Çözülmüş ikiliyi çalıştırmak için (file, argv).
 */
function execTarget(bin, argv, deps = {}) {
  return engineInstall.execArgs(bin.path, argv, { platform: deps.platform || process.platform, env: deps.env || process.env });
}

/**
 * ADP-893 — Windows verbatim arguments bayrağı.
 */
function withVerbatim(target, opts) {
  return target && target.windowsVerbatimArguments === true
    ? { ...opts, windowsVerbatimArguments: true }
    : opts;
}

/**
 * Motorun tarayıcıyı KENDİSİNİN açmasını engelleyen no-op `BROWSER` değeri.
 */
function noopBrowserFor(deps = {}) {
  if (deps.noopBrowser !== undefined) return deps.noopBrowser;
  return (deps.platform || process.platform) === 'win32' ? null : '/usr/bin/true';
}

module.exports = {
  resolveBin,
  execEnv,
  binErrorFor,
  execTarget,
  withVerbatim,
  noopBrowserFor,
};
