'use strict';

const { registerSkillsIpc } = require('./skillsIpc');
const { registerAgentxIpc } = require('./agentxIpc');
const { registerAgentxDraftIpc } = require('./agentxDraftIpc');
const { registerDelegationIpc } = require('./delegationIpc');

module.exports = {
  registerSkillsIpc,
  registerAgentxIpc,
  registerAgentxDraftIpc,
  registerDelegationIpc,
};
