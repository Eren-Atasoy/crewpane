'use strict';

const { registerWorktreeIpc } = require('./worktreeIpc');
const { registerBrowserIpc } = require('./browserIpc');
const { registerIntegIpc } = require('./integIpc');
const { registerSprintIpc } = require('./sprintIpc');

module.exports = {
  registerWorktreeIpc,
  registerBrowserIpc,
  registerIntegIpc,
  registerSprintIpc,
};
