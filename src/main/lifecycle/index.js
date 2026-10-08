'use strict';

const { createLifecycleManager } = require('./lifecycleManager');
const { createStartupGate } = require('./startupGate');

module.exports = {
  createLifecycleManager,
  createStartupGate,
};
