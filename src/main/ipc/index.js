'use strict';

const { createIpcRouter } = require('./router');
const { wireIpc, wireServicesIpc, wireAgentsIpc, wireSystemIpc } = require('./wire');

module.exports = {
  createIpcRouter,
  wireIpc,
  wireServicesIpc,
  wireAgentsIpc,
  wireSystemIpc,
};
