'use strict';

const { registerMobileIpc } = require('./ipc');
const { createMobileService } = require('./service');

module.exports = {
  registerMobileIpc,
  createMobileService,
};
