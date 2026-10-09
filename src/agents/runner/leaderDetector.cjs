'use strict';

const { LEADER_SLUGS: LEADER_ROLE_SLUGS } = require('../leaderRole.cjs');
const DELEGATE_TOOL_MARKER = 'crewpane_delegate';

/**
 * Raw LEADER signal: the role is a leader slug OR the composed
 * identity carries the ADP-053 `crewpane_delegate` marker.
 */
function leaderSignal(opts) {
  if (!opts || typeof opts !== 'object') return false;
  const role = typeof opts.role === 'string' ? opts.role.trim().toLowerCase() : '';
  if (role && LEADER_ROLE_SLUGS.includes(role)) return true;
  const sp = typeof opts.systemPrompt === 'string' ? opts.systemPrompt : '';
  return sp.includes(DELEGATE_TOOL_MARKER);
}

/**
 * Is this a spawn that should get the LEADER delegation WIRING?
 */
function isLeaderSpawn(opts) {
  return leaderSignal(opts);
}

module.exports = {
  LEADER_ROLE_SLUGS,
  DELEGATE_TOOL_MARKER,
  leaderSignal,
  isLeaderSpawn,
};
