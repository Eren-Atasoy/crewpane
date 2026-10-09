// CrewPane — Resume Daemon Core modular public API.
'use strict';

const { ResumeDaemonCore } = require('./daemonCore.cjs');
const {
  DEFAULT_VERIFY_WINDOW_MS,
  VERIFY_RETRY_DELAYS_MS,
  VERIFY_MAX_ATTEMPTS,
  DEFER_PROBE_MS,
  UNKNOWN_MAX_DEFER_MS,
  MAX_TOTAL_DEFER_MS,
  STALE_CLOCK_GRACE_MS,
  WATCHDOG_MIN_GAP_MS,
  PROBE_SETTLE_MS,
  PROBE_RETRY_MS,
  PROBE_MAX_UNKNOWN,
  SENTINEL_GRACE_MS,
  SENTINEL_QUIET_MS,
  SENTINEL_MAX_NUDGES,
} = require('./constants.cjs');
const {
  transcriptInterruptedAfter,
  hasAssistantLineAfter,
  assistantLinesAfter,
  paneSignature,
} = require('./transcriptVerify.cjs');

module.exports = {
  ResumeDaemonCore,
  DEFAULT_VERIFY_WINDOW_MS,
  VERIFY_RETRY_DELAYS_MS,
  VERIFY_MAX_ATTEMPTS,
  DEFER_PROBE_MS,
  UNKNOWN_MAX_DEFER_MS,
  MAX_TOTAL_DEFER_MS,
  STALE_CLOCK_GRACE_MS,
  WATCHDOG_MIN_GAP_MS,
  PROBE_SETTLE_MS,
  PROBE_RETRY_MS,
  PROBE_MAX_UNKNOWN,
  SENTINEL_GRACE_MS,
  SENTINEL_QUIET_MS,
  SENTINEL_MAX_NUDGES,
  transcriptInterruptedAfter,
  hasAssistantLineAfter,
  assistantLinesAfter,
  paneSignature,
};
