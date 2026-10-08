'use strict';

const { registerSkillsIpc } = require('./skillsIpc');
const { registerAgentxIpc } = require('./agentxIpc');
const { registerAgentxDraftIpc } = require('./agentxDraftIpc');
const { registerDelegationIpc } = require('./delegationIpc');
const { registerTeamComposeIpc } = require('./teamComposeIpc');
const { registerTeamScopeIpc } = require('./teamScopeIpc');

module.exports = {
  registerSkillsIpc,
  registerAgentxIpc,
  registerAgentxDraftIpc,
  registerDelegationIpc,
  registerTeamComposeIpc,
  registerTeamScopeIpc,
};

