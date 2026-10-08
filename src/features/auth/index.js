'use strict';

const { registerEngineIpc } = require('./engineIpc');
const { registerEngineAuthIpc } = require('./engineAuthIpc');
const { registerEngineProfilesIpc } = require('./engineProfilesIpc');
const { registerAccountIpc } = require('./accountIpc');
const { registerPlanIpc } = require('./planIpc');

module.exports = {
  registerEngineIpc,
  registerEngineAuthIpc,
  registerEngineProfilesIpc,
  registerAccountIpc,
  registerPlanIpc,
};
