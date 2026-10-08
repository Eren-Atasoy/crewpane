'use strict';

const { registerSkillsIpc } = require('./skillsIpc');
const { registerAgentxIpc } = require('./agentxIpc');
const { registerAgentxDraftIpc } = require('./agentxDraftIpc');
const { registerDelegationIpc } = require('./delegationIpc');
const { registerTeamComposeIpc } = require('./teamComposeIpc');
const { registerTeamScopeIpc } = require('./teamScopeIpc');
const { createTeamComposeService } = require('./teamComposeService');
const {
  createDelegationSupervisorService,
  supervisorFingerprint,
} = require('./delegationSupervisorService');

module.exports = {
  registerSkillsIpc,
  registerAgentxIpc,
  registerAgentxDraftIpc,
  registerDelegationIpc,
  registerTeamComposeIpc,
  registerTeamScopeIpc,
  createTeamComposeService,
  createDelegationSupervisorService,
  supervisorFingerprint,
};
