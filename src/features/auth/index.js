'use strict';

const { registerEngineIpc } = require('./engineIpc');
const { registerEngineAuthIpc } = require('./engineAuthIpc');
const { registerEngineProfilesIpc } = require('./engineProfilesIpc');

module.exports = {
  registerEngineIpc,
  registerEngineAuthIpc,
  registerEngineProfilesIpc,
};
