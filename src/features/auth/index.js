'use strict';

const { registerEngineIpc } = require('./engineIpc');
const { registerEngineAuthIpc } = require('./engineAuthIpc');
const { registerEngineProfilesIpc } = require('./engineProfilesIpc');
const { registerAccountIpc } = require('./accountIpc');
const { registerPlanIpc } = require('./planIpc');

const { createAuthService } = require('./service');
const { createAccountBindingService } = require('./accountBindingService');
const { createSeatGateService } = require('./seatGateService');
const { createPlanLimitService, PLAN_NUDGE_MIN_MS } = require('./planLimitService');
const { createApiKeyService, ApiKeyService } = require('./apiKeyService');

module.exports = {
  createAuthService,
  createAccountBindingService,
  createSeatGateService,
  createPlanLimitService,
  createApiKeyService,
  ApiKeyService,
  PLAN_NUDGE_MIN_MS,
  registerEngineIpc,
  registerEngineAuthIpc,
  registerEngineProfilesIpc,
  registerAccountIpc,
  registerPlanIpc,
};
