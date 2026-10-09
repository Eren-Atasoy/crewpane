'use strict';

const path = require('node:path');
const instancePaths = require('../../config/instancePaths.cjs');

const MAX_BODY_BYTES = 256 * 1024;
const IPC_TIMEOUT_MS = 15000;
const HANDSHAKE_RETRY_DELAYS_MS = [250, 1000, 4000];
const HANDSHAKE_REFRESH_MS = 30_000;
const HANDSHAKE_STALE_MS = 3 * HANDSHAKE_REFRESH_MS;
const HANDSHAKE_STARTED_AT = new Date().toISOString();

/** ENV-08 — `kill(pid,0)` varlık sorusu; EPERM = var ama bizim değil → CANLI. */
function handshakeOwnerAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !!e && e.code === 'EPERM';
  }
}

const BROWSER_APPROVAL_TIMEOUT_MS = 120000;
const BRIDGE_DIR = instancePaths.instanceHome();
const BRIDGE_FILE = path.join(BRIDGE_DIR, 'bridge.json');

const MAX_REPORT_SUMMARY_LEN = 4000;
const SHOT_PROMPT_MAX_CHARS = 2000;
const SHOT_MAX_PATHS = 10;
const ATTACH_MAX_PATHS = 8;
const TELEMETRY_BUMP_KEYS = new Set(['tasks_created']);

module.exports = {
  MAX_BODY_BYTES,
  IPC_TIMEOUT_MS,
  HANDSHAKE_RETRY_DELAYS_MS,
  HANDSHAKE_REFRESH_MS,
  HANDSHAKE_STALE_MS,
  HANDSHAKE_STARTED_AT,
  handshakeOwnerAlive,
  BROWSER_APPROVAL_TIMEOUT_MS,
  BRIDGE_DIR,
  BRIDGE_FILE,
  MAX_REPORT_SUMMARY_LEN,
  SHOT_PROMPT_MAX_CHARS,
  SHOT_MAX_PATHS,
  ATTACH_MAX_PATHS,
  TELEMETRY_BUMP_KEYS,
};
