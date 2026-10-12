'use strict';

const { wireServicesIpc } = require('./wireServices');
const { wireAgentsIpc } = require('./wireAgents');
const { wireSystemIpc } = require('./wireSystem');
const { wire040Ipc } = require('./wire040');

/**
 * Main IPC Wire Coordinator (Faz 3.6.4 + 0.4.0 Extended Architecture)
 * Assembles and registers all domain IPC interfaces across services, agents, system, and 0.4.0 features.
 */
function wireIpc(deps) {
  wireServicesIpc(deps);
  wireAgentsIpc(deps);
  wireSystemIpc(deps);
  wire040Ipc(deps);
}

module.exports = {
  wireIpc,
  wireServicesIpc,
  wireAgentsIpc,
  wireSystemIpc,
  wire040Ipc,
};

