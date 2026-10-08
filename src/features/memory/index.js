'use strict';

const { registerMemoryIpc } = require('./ipc');
const { createMemoryService, MemoryService } = require('./memoryService');

module.exports = {
  registerMemoryIpc,
  createMemoryService,
  MemoryService,
};
