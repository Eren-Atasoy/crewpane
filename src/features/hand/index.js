'use strict';

const { registerHandIpc } = require('./ipc');
const { createHandService } = require('./service');
const { createHandDisplayService } = require('./handDisplayService');
const { createHandCameraService } = require('./handCameraService');

module.exports = {
  registerHandIpc,
  createHandService,
  createHandDisplayService,
  createHandCameraService,
};
