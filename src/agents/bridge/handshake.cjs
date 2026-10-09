'use strict';

const fs = require('node:fs');
const path = require('node:path');
const instancePaths = require('../../config/instancePaths.cjs');
const { writeJsonAtomic } = require('../agentRunner.js');
const {
  BRIDGE_FILE,
  HANDSHAKE_STALE_MS,
  HANDSHAKE_STARTED_AT,
  handshakeOwnerAlive,
} = require('./constants.cjs');

/**
 * Persist port+token for the MCP server (ADP-051/052) to discover. 0600.
 */
function writeHandshake(port, token, log, file = BRIDGE_FILE, opts = {}) {
  const alive = opts.alive || handshakeOwnerAlive;
  try {
    let owner = null;
    try { owner = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* yok/bozuk → yazılabilir */ }
    if (owner && Number.isInteger(owner.pid) && owner.pid !== process.pid && alive(owner.pid)) {
      const age = Date.now() - (Number.isFinite(owner.updatedAt) ? owner.updatedAt : 0);
      if (age < HANDSHAKE_STALE_MS) {
        const msg = `bridge handshake NOT overwritten — live foreign owner pid=${owner.pid} instance=${owner.instance || '?'} (${file})`;
        log(msg);
        console.error(`[delegation-bridge] ${msg}`);
        return false;
      }
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeJsonAtomic(file, {
      port,
      token,
      pid: process.pid,
      host: '127.0.0.1',
      instance: instancePaths.instanceId(),
      startedAt: HANDSHAKE_STARTED_AT,
      updatedAt: Date.now(),
    });
    return true;
  } catch (err) {
    log(`bridge handshake write failed: ${err.message}`);
    console.error(`[delegation-bridge] handshake write FAILED (${file}): ${(err && err.message) || err}`);
    return false;
  }
}

/**
 * ADP-226 — remove the handshake ONLY if this process wrote it (`pid` match).
 */
function removeHandshake(log, file = BRIDGE_FILE) {
  let owner;
  try {
    owner = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return false; // missing or unreadable → nothing of OURS to remove
  }
  if (!owner || owner.pid !== process.pid) {
    log(`bridge handshake kept on stop (owner pid=${owner && owner.pid}, ours=${process.pid})`);
    return false;
  }
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false; /* already gone */
  }
}

module.exports = {
  writeHandshake,
  removeHandshake,
};
