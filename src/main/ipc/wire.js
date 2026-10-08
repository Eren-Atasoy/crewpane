'use strict';

const { wireServicesIpc } = require('./wireServices');
const { wireAgentsIpc } = require('./wireAgents');
const { wireSystemIpc } = require('./wireSystem');

/**
 * Main IPC Wire Coordinator (Faz 3.6.4)
 * Assembles and registers all 39 domain IPC interfaces across services, agents, and system.
 */
function wireIpc(deps) {
  wireServicesIpc(deps);
  wireAgentsIpc(deps);
  wireSystemIpc(deps);
}

module.exports = {
  wireIpc,
  wireServicesIpc,
  wireAgentsIpc,
  wireSystemIpc,
};
