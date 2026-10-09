// CrewPane — Workspace root probing and resolution.
'use strict';

const fs = require('fs');
const crewpaneEnv = require('../../config/crewpaneEnv.cjs');
const buildChannel = require('../../config/buildChannel.cjs');
const { DENIED_CODES } = require('./constants.cjs');

/**
 * @returns {{ ok: boolean, reason: 'ok'|'unset'|'missing'|'denied'|'not-a-directory', code?: string }}
 */
function probeDir(p) {
  if (typeof p !== 'string' || p.length === 0) return { ok: false, reason: 'unset' };
  try {
    return fs.statSync(p).isDirectory()
      ? { ok: true, reason: 'ok' }
      : { ok: false, reason: 'not-a-directory' };
  } catch (e) {
    const code = (e && e.code) || 'ERR';
    if (DENIED_CODES.has(code)) return { ok: false, reason: 'denied', code };
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, reason: 'missing', code };
    return { ok: false, reason: 'denied', code };
  }
}

/** Validate a dir path; return it only if it exists and is a directory. */
function isDir(p) {
  return probeDir(p).ok;
}

/**
 * ADP-852 v3 — İKİ EKRANIN PAYLAŞTIĞI TEK GERÇEK.
 */
function configuredWorkspaceRootStatus() {
  const env = buildChannel.escapesAllowed()
    ? crewpaneEnv.readEnv('WORKSPACE_ROOT')
    : undefined;
  const envProbe = probeDir(env);
  if (envProbe.ok) return { root: env, configured: env, source: 'env', reason: 'ok' };

  // Lazy-require readSettings to keep settingsStore as the owner of cache
  const { readSettings } = require('./settingsStore.cjs');
  const fromSettings = readSettings().workspaceRoot;
  const setProbe = probeDir(fromSettings);
  if (setProbe.ok) return { root: fromSettings, configured: fromSettings, source: 'settings', reason: 'ok' };

  if (typeof fromSettings === 'string' && fromSettings) {
    return { root: null, configured: fromSettings, source: 'settings', reason: setProbe.reason, code: setProbe.code };
  }
  if (typeof env === 'string' && env) {
    return { root: null, configured: env, source: 'env', reason: envProbe.reason, code: envProbe.code };
  }
  return { root: null, configured: null, source: null, reason: 'unset' };
}

/**
 * ADP-232-C — the EXPLICITLY configured workspace root (env override →
 * settings.workspaceRoot), or null when neither points at a real directory.
 */
function configuredWorkspaceRoot() {
  return configuredWorkspaceRootStatus().root;
}

/**
 * Resolve the AGENT workspace root: env override → settings.workspaceRoot → fallback.
 */
function resolveWorkspaceRoot(fallback) {
  return configuredWorkspaceRoot() || fallback;
}

module.exports = {
  probeDir,
  isDir,
  configuredWorkspaceRootStatus,
  configuredWorkspaceRoot,
  resolveWorkspaceRoot,
};
