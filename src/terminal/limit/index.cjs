// CrewPane — Terminal Limit Detection Module Aggregator (Phase 4.11)
'use strict';

const {
  stripAnsi,
  stripAnsiRobust,
  MAX_RESET_AHEAD_MS,
  TAIL_LINES,
  ANCHOR_LINES,
  RESET_SCAN_LINES,
  LAST_FRAME_LINES,
  MAX_DATED_RESET_AHEAD_MS,
} = require('./constants.cjs');

const {
  parseAbsReset,
  isUsableTimeZone,
  zoneClockParts,
  zonedDateEpoch,
  parseMonthDayReset,
  isSaneDatedResetAt,
  clockEpochs,
  nextEpochForClock,
  isSaneResetAt,
  resolveResetAt,
  parseResetAt,
} = require('./timeResolver.cjs');

const {
  tailText,
  isAgentWorking,
  healClockText,
  extractReset,
  extractResetWide,
  lastFrameText,
  looksLikeLimitText,
  inferEngine,
  resolveEngine,
} = require('./textScanner.cjs');

const {
  isLiveMenuTrailing,
  classifyOption,
  detectRateLimitPrompt,
  detectNativeContinueState,
} = require('./nativeState.cjs');

const {
  detectLimit,
  detectLimitState,
} = require('./limitDetector.cjs');

module.exports = {
  stripAnsi,
  detectLimit,
  parseResetAt,
  nextEpochForClock,
  clockEpochs,
  stripAnsiRobust,
  isUsableTimeZone,
  zoneClockParts,
  isSaneResetAt,
  resolveResetAt,
  MAX_RESET_AHEAD_MS,
  TAIL_LINES,
  ANCHOR_LINES,
  tailText,
  RESET_SCAN_LINES,
  LAST_FRAME_LINES,
  extractResetWide,
  lastFrameText,
  looksLikeLimitText,
  isAgentWorking,
  inferEngine,
  resolveEngine,
  healClockText,
  extractReset,
  parseAbsReset,
  parseMonthDayReset,
  zonedDateEpoch,
  isSaneDatedResetAt,
  MAX_DATED_RESET_AHEAD_MS,
  detectNativeContinueState,
  classifyOption,
  isLiveMenuTrailing,
  detectRateLimitPrompt,
  detectLimitState,
};
