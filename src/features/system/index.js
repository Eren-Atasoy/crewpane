'use strict';

const { registerFeedbackIpc } = require('./feedbackIpc');
const { registerFileIpc } = require('./fileIpc');
const { registerClipIpc } = require('./clipIpc');
const { registerAnnounceIpc } = require('./announceIpc');

function registerSystemIpc(deps) {
  registerFeedbackIpc(deps);
  registerFileIpc(deps);
  registerClipIpc(deps);
  registerAnnounceIpc(deps);
}

module.exports = {
  registerSystemIpc,
  registerFeedbackIpc,
  registerFileIpc,
  registerClipIpc,
  registerAnnounceIpc,
};
