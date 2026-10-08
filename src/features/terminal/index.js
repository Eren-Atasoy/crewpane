'use strict';

const { registerPtyIpc } = require('./ptyIpc');
const { registerPanesIpc } = require('./panesIpc');

module.exports = {
  registerPtyIpc,
  registerPanesIpc,
};

