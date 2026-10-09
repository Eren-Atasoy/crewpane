// CrewPane — Delegation MCP Module Aggregator (Phase 4.13)
'use strict';

const {
  BRIDGE_FILE,
  discoverBridgeCandidates,
  discoverBridge,
  bridgeRequestFailover,
  bridgeRequest,
} = require('./bridgeClient.cjs');

const {
  summarizeSupervisor,
  summarizeStatus,
  summarizeSprintStatus,
  summarizePanes,
} = require('./formatters.cjs');

const {
  runDelegate,
  runStatus,
  runSprint,
  runSprintStatus,
  runPane,
  runTeamCompose,
} = require('./toolRunners.cjs');

const {
  CANONICAL_TOOLS,
  TOOLS,
} = require('./toolDefs.cjs');

const {
  main,
} = require('./serverLoop.cjs');

module.exports = {
  discoverBridge,
  discoverBridgeCandidates,
  bridgeRequestFailover,
  summarizeStatus,
  summarizeSupervisor,
  runDelegate,
  runStatus,
  runSprint,
  runSprintStatus,
  summarizeSprintStatus,
  runPane,
  summarizePanes,
  runTeamCompose,
  TOOLS,
  CANONICAL_TOOLS,
  bridgeRequest,
  BRIDGE_FILE,
  main,
};
