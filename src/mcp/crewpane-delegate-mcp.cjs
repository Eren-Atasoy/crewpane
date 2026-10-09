#!/usr/bin/env node
// CrewPane — Delegation MCP Server Facade.
// Modular submodules live under ./delegate/ (Phase 4.13).
'use strict';

const delegate = require('./delegate/index.cjs');

module.exports = {
  discoverBridge: delegate.discoverBridge,
  discoverBridgeCandidates: delegate.discoverBridgeCandidates,
  bridgeRequestFailover: delegate.bridgeRequestFailover,
  summarizeStatus: delegate.summarizeStatus,
  summarizeSupervisor: delegate.summarizeSupervisor,
  runDelegate: delegate.runDelegate,
  runStatus: delegate.runStatus,
  runSprint: delegate.runSprint,
  runSprintStatus: delegate.runSprintStatus,
  summarizeSprintStatus: delegate.summarizeSprintStatus,
  runPane: delegate.runPane,
  summarizePanes: delegate.summarizePanes,
  runTeamCompose: delegate.runTeamCompose,
  TOOLS: delegate.TOOLS,
  CANONICAL_TOOLS: delegate.CANONICAL_TOOLS,
  bridgeRequest: delegate.bridgeRequest,
  BRIDGE_FILE: delegate.BRIDGE_FILE,
};

if (require.main === module) delegate.main();
