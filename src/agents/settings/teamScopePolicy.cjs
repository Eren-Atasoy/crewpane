// CrewPane — Team scope policy mandate and grant management.
'use strict';

const teamScope = require('../teamScope.cjs');

let _pkgVersion;
function packagedVersion() {
  if (_pkgVersion !== undefined) return _pkgVersion;
  try {
    _pkgVersion = String(require('../../../package.json').version || '') || null;
  } catch {
    _pkgVersion = null;
  }
  return _pkgVersion;
}

/**
 * ADP-717 §3.5 — kuralın YÜRÜRLÜK ANINI bir kez diske çiviler ve teamScope ayarını döner.
 * @param {string} [appVersion] mandalı çakan sürüm (main: app.getVersion()).
 */
function ensureTeamScopeMandate(appVersion) {
  const { readSettings, writeSettings } = require('./settingsStore.cjs');
  const cur = teamScope.sanitizeTeamScope(readSettings().teamScope);
  if (teamScope.mandateArmed(cur)) return cur;
  const by = (typeof appVersion === 'string' && appVersion.trim()) || packagedVersion() || 'unknown';
  return teamScope.sanitizeTeamScope(
    writeSettings({
      teamScope: { ...cur, enforcedSince: new Date().toISOString(), enforcedBy: by },
    }).teamScope,
  );
}

/**
 * ADP-717 — güncel takım-kapsamı politikası (teamScope.authorize'a verilen `policy`).
 */
function teamScopePolicy(appVersion) {
  return ensureTeamScopeMandate(appVersion);
}

/**
 * ADP-737 — İZİN VER (sahibin onay akışının yazma ucu).
 * @returns {{ok:boolean, policy:object}}
 */
function grantTeamScope({ leaderId, scopes, mode, expiresAt, origin } = {}) {
  const { writeSettings } = require('./settingsStore.cjs');
  const policy = teamScopePolicy();
  const res = teamScope.addGrant(policy.grants, {
    leaderId,
    scopes,
    mode,
    expiresAt: expiresAt || null,
    origin: origin === 'system' ? 'system' : 'user',
  });
  if (!res.changed) return { ok: false, policy };
  const saved = writeSettings({ teamScope: { ...policy, grants: res.grants } });
  return { ok: true, policy: teamScope.sanitizeTeamScope(saved.teamScope) };
}

/**
 * TC-05 — İZNİ GERİ AL (`grantTeamScope`ın tersi).
 * @returns {{ok:boolean, policy:object}}
 */
function revokeTeamScope({ leaderId, scope, origin } = {}) {
  const { writeSettings } = require('./settingsStore.cjs');
  const policy = teamScopePolicy();
  const res = teamScope.revokeGrant(policy.grants, { leaderId, scope, origin });
  if (!res.changed) return { ok: false, policy };
  const saved = writeSettings({ teamScope: { ...policy, grants: res.grants } });
  return { ok: true, policy: teamScope.sanitizeTeamScope(saved.teamScope) };
}

module.exports = {
  packagedVersion,
  ensureTeamScopeMandate,
  teamScopePolicy,
  grantTeamScope,
  revokeTeamScope,
};
