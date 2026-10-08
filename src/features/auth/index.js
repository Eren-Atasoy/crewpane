'use strict';

const { registerEngineIpc } = require('./engineIpc');
const { registerEngineAuthIpc } = require('./engineAuthIpc');
const { registerEngineProfilesIpc } = require('./engineProfilesIpc');
const { registerAccountIpc } = require('./accountIpc');
const { registerPlanIpc } = require('./planIpc');

const { createAuthService } = require('./service');
const { createAccountBindingService } = require('./accountBindingService');
const { createSeatGateService } = require('./seatGateService');

module.exports = {
  createAuthService,
  createAccountBindingService,
  createSeatGateService,
  registerEngineIpc,
  registerEngineAuthIpc,
  registerEngineProfilesIpc,
  registerAccountIpc,
  registerPlanIpc,
};
