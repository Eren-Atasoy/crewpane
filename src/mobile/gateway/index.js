// CrewPane — Mobile Gateway Module Aggregator (Phase 4.12)
'use strict';

const {
  DEFAULT_PORT,
  ROUTE_SCOPES,
  COMMAND_KINDS,
  QUERY_KINDS,
  MAX_AUDIO_BYTES,
  MAX_UPLOAD_BODY_BYTES,
  MAX_ATTACHMENTS,
  TASK_STATUSES,
  routeKeyFor,
  queryParamsFor,
} = require('./constants.js');

const {
  parseMultipart,
} = require('./payloadParser.js');

const {
  startMobileGateway,
} = require('./gatewayServer.js');

module.exports = {
  DEFAULT_PORT,
  ROUTE_SCOPES,
  COMMAND_KINDS,
  QUERY_KINDS,
  MAX_AUDIO_BYTES,
  MAX_UPLOAD_BODY_BYTES,
  MAX_ATTACHMENTS,
  TASK_STATUSES,
  routeKeyFor,
  queryParamsFor,
  parseMultipart,
  startMobileGateway,
};
