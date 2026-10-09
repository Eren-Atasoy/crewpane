'use strict';

const {
  HANDSHAKE_REFRESH_MS,
  BRIDGE_FILE,
  BRIDGE_DIR,
  ATTACH_MAX_PATHS,
  SHOT_PROMPT_MAX_CHARS,
} = require('./constants.cjs');

const {
  mintToken,
  checkToken,
  declaredIdentity,
  paneRecordForAgent,
  authorizeDelegateCaller,
} = require('./securityToken.cjs');

const {
  validateDelegatePayload,
  validateComposePayload,
  validateReportPayload,
  validateRecyclePayload,
  validatePaneClosePayload,
  validateShotPayload,
  validateTaskAttachmentPayload,
  validateSprintPayload,
  validateSprintStopPayload,
} = require('./payloadValidators.cjs');

const {
  defaultResultsDir,
  writeReportFile,
} = require('./reportWriter.cjs');

const {
  stripAnsi,
  cleanPaneTail,
  paneHasApiError,
  enrichDelegationSnapshot,
} = require('./snapshotEnrich.cjs');

const {
  writeHandshake,
  removeHandshake,
} = require('./handshake.cjs');

const {
  startDelegationBridge,
} = require('./bridgeServer.cjs');

module.exports = {
  startDelegationBridge,
  validateComposePayload,
  mintToken,
  checkToken,
  validateDelegatePayload,
  authorizeDelegateCaller,
  declaredIdentity,
  paneRecordForAgent,
  validateReportPayload,
  writeReportFile,
  defaultResultsDir,
  validateRecyclePayload,
  validatePaneClosePayload,
  validateShotPayload,
  validateTaskAttachmentPayload,
  ATTACH_MAX_PATHS,
  SHOT_PROMPT_MAX_CHARS,
  validateSprintPayload,
  validateSprintStopPayload,
  stripAnsi,
  cleanPaneTail,
  paneHasApiError,
  enrichDelegationSnapshot,
  writeHandshake,
  removeHandshake,
  HANDSHAKE_REFRESH_MS,
  BRIDGE_FILE,
  BRIDGE_DIR,
};
