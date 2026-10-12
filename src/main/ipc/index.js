'use strict';

const { createIpcRouter } = require('./router');
const { wireIpc, wireServicesIpc, wireAgentsIpc, wireSystemIpc, wire040Ipc } = require('./wire');
const {
  assembleIpcDeps,
  buildPlatformAndWindowDeps,
  buildWorkspaceAndStorageDeps,
  buildMediaAndMemoryDeps,
  buildTerminalAndExecutionDeps,
  buildMobileAndSkillDeps,
  buildSystemAuthAndEngineDeps,
} = require('./ipcDepsBuilder');
const { createMainIpcWiring } = require('./ipcMainWiring');

module.exports = {
  createIpcRouter,
  wireIpc,
  wireServicesIpc,
  wireAgentsIpc,
  wireSystemIpc,
  wire040Ipc,
  assembleIpcDeps,
  buildPlatformAndWindowDeps,
  buildWorkspaceAndStorageDeps,
  buildMediaAndMemoryDeps,
  buildTerminalAndExecutionDeps,
  buildMobileAndSkillDeps,
  buildSystemAuthAndEngineDeps,
  createMainIpcWiring,
};

