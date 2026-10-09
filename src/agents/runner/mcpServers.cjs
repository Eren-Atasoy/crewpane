'use strict';

const path = require('node:path');
const fs = require('node:fs');
const instancePaths = require('../../config/instancePaths.cjs');
const mcpNode = require('../../../platform/mcpNode.cjs');
const { writeJsonAtomic } = require('./atomicFs.cjs');
const { engineCapability } = require('./registryBridge.cjs');

const DELEGATE_TOOL_MARKER = 'crewpane_delegate';
const DELEGATE_MCP_SERVER_FILE = 'crewpane-delegate-mcp.cjs';
const DELEGATE_MCP_SERVER_NAME = 'crewpane-delegate';

const BROWSER_MCP_SERVER_FILE = 'crewpane-browser-mcp.cjs';
const BROWSER_MCP_SERVER_NAME = 'crewpane-browser';

const TASK_MCP_SERVER_FILE = 'crewpane-task-mcp.cjs';
const TASK_MCP_SERVER_NAME = 'crewpane-task';

const INTEGRATIONS_MCP_SERVER_FILE = 'crewpane-integrations-mcp.cjs';
const INTEGRATIONS_MCP_SERVER_NAME = 'crewpane-integrations';

const AGENTS_DIR = path.resolve(__dirname, '..');

function resolveMcpServerDir(dirname) {
  const d = typeof dirname === 'string' ? dirname : '';
  if (d.includes('app.asar.unpacked')) return d;
  if (d.endsWith(`${path.sep}app.asar`) || d === 'app.asar') return `${d}.unpacked`;
  const seg = `${path.sep}app.asar${path.sep}`;
  if (d.includes(seg)) return d.replace(seg, `${path.sep}app.asar.unpacked${path.sep}`);
  return d;
}

function mcpServerDir() {
  return resolveMcpServerDir(AGENTS_DIR);
}

const MCP_DEFAULT_ENVELOPE = 'mcpServers';

function mcpEntry(scriptPath, launcher) {
  return mcpNode.mcpServerEntry(scriptPath, launcher);
}

function mcpEnvelopeFor(commandKey) {
  const d = engineCapability(commandKey, 'mcp');
  if (!d) return MCP_DEFAULT_ENVELOPE;
  return Object.prototype.hasOwnProperty.call(d, 'envelope') ? d.envelope : MCP_DEFAULT_ENVELOPE;
}

function mcpConfigDoc(commandKey, servers) {
  const envelope = mcpEnvelopeFor(commandKey);
  return envelope ? { [envelope]: servers } : { ...servers };
}

function mcpConfigFileName(base, commandKey) {
  const envelope = mcpEnvelopeFor(commandKey);
  return envelope === MCP_DEFAULT_ENVELOPE ? `${base}.json` : `${base}-${envelope || 'flat'}.json`;
}

function delegateMcpServerPath() {
  return path.join(mcpServerDir(), DELEGATE_MCP_SERVER_FILE);
}

function browserMcpServerPath() {
  return path.join(mcpServerDir(), BROWSER_MCP_SERVER_FILE);
}

function taskMcpServerPath() {
  return path.join(mcpServerDir(), TASK_MCP_SERVER_FILE);
}

function integrationsMcpServerPath() {
  return path.join(mcpServerDir(), INTEGRATIONS_MCP_SERVER_FILE);
}

function delegateMcpConfigPath(homedir, commandKey) {
  return path.join(instancePaths.crewpaneHome(homedir), mcpConfigFileName('delegate-mcp', commandKey));
}

function ensureDelegateMcpConfig(homedir, commandKey) {
  try {
    const dir = instancePaths.crewpaneHome(homedir);
    fs.mkdirSync(dir, { recursive: true });
    const cfgPath = path.join(dir, mcpConfigFileName('delegate-mcp', commandKey));
    const launcher = mcpNode.resolveMcpNode();
    const config = mcpConfigDoc(commandKey, {
      [DELEGATE_MCP_SERVER_NAME]: mcpEntry(delegateMcpServerPath(), launcher),
      [BROWSER_MCP_SERVER_NAME]: mcpEntry(browserMcpServerPath(), launcher),
      [TASK_MCP_SERVER_NAME]: mcpEntry(taskMcpServerPath(), launcher),
      [INTEGRATIONS_MCP_SERVER_NAME]: mcpEntry(integrationsMcpServerPath(), launcher),
    });
    writeJsonAtomic(cfgPath, config);
    return cfgPath;
  } catch {
    return null;
  }
}

function browserMcpConfigPath(homedir, commandKey) {
  return path.join(instancePaths.crewpaneHome(homedir), mcpConfigFileName('browser-mcp', commandKey));
}

function ensureBrowserMcpConfig(homedir, commandKey) {
  try {
    const dir = instancePaths.crewpaneHome(homedir);
    fs.mkdirSync(dir, { recursive: true });
    const cfgPath = path.join(dir, mcpConfigFileName('browser-mcp', commandKey));
    const launcher = mcpNode.resolveMcpNode();
    const config = mcpConfigDoc(commandKey, {
      [BROWSER_MCP_SERVER_NAME]: mcpEntry(browserMcpServerPath(), launcher),
      [TASK_MCP_SERVER_NAME]: mcpEntry(taskMcpServerPath(), launcher),
      [INTEGRATIONS_MCP_SERVER_NAME]: mcpEntry(integrationsMcpServerPath(), launcher),
    });
    writeJsonAtomic(cfgPath, config);
    return cfgPath;
  } catch {
    return null;
  }
}

function taskMcpConfigPath(homedir, commandKey) {
  return path.join(instancePaths.crewpaneHome(homedir), mcpConfigFileName('task-mcp', commandKey));
}

function ensureTaskMcpConfig(homedir, commandKey) {
  try {
    const dir = instancePaths.crewpaneHome(homedir);
    fs.mkdirSync(dir, { recursive: true });
    const cfgPath = path.join(dir, mcpConfigFileName('task-mcp', commandKey));
    const launcher = mcpNode.resolveMcpNode();
    const config = mcpConfigDoc(commandKey, {
      [TASK_MCP_SERVER_NAME]: mcpEntry(taskMcpServerPath(), launcher),
      [BROWSER_MCP_SERVER_NAME]: mcpEntry(browserMcpServerPath(), launcher),
      [INTEGRATIONS_MCP_SERVER_NAME]: mcpEntry(integrationsMcpServerPath(), launcher),
    });
    writeJsonAtomic(cfgPath, config);
    return cfgPath;
  } catch {
    return null;
  }
}

function leaderMcpServers() {
  return [
    { name: DELEGATE_MCP_SERVER_NAME, path: delegateMcpServerPath() },
    { name: BROWSER_MCP_SERVER_NAME, path: browserMcpServerPath() },
    { name: TASK_MCP_SERVER_NAME, path: taskMcpServerPath() },
    { name: INTEGRATIONS_MCP_SERVER_NAME, path: integrationsMcpServerPath() },
  ];
}

function commonMcpServers() {
  return [
    { name: TASK_MCP_SERVER_NAME, path: taskMcpServerPath() },
    { name: BROWSER_MCP_SERVER_NAME, path: browserMcpServerPath() },
    { name: INTEGRATIONS_MCP_SERVER_NAME, path: integrationsMcpServerPath() },
  ];
}

module.exports = {
  DELEGATE_TOOL_MARKER,
  DELEGATE_MCP_SERVER_FILE,
  DELEGATE_MCP_SERVER_NAME,
  BROWSER_MCP_SERVER_FILE,
  BROWSER_MCP_SERVER_NAME,
  TASK_MCP_SERVER_FILE,
  TASK_MCP_SERVER_NAME,
  INTEGRATIONS_MCP_SERVER_FILE,
  INTEGRATIONS_MCP_SERVER_NAME,
  resolveMcpServerDir,
  mcpServerDir,
  MCP_DEFAULT_ENVELOPE,
  mcpEntry,
  mcpEnvelopeFor,
  mcpConfigDoc,
  mcpConfigFileName,
  delegateMcpServerPath,
  browserMcpServerPath,
  taskMcpServerPath,
  integrationsMcpServerPath,
  delegateMcpConfigPath,
  ensureDelegateMcpConfig,
  browserMcpConfigPath,
  ensureBrowserMcpConfig,
  taskMcpConfigPath,
  ensureTaskMcpConfig,
  leaderMcpServers,
  commonMcpServers,
};
