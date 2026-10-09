// CrewPane — Main Process Bootstrap & Entry Point
//
// Bootstrap sequence executes early process checks (instance-lock, env-profile, safe-storage)
// followed by initializing the composition root (container.js) to wire lifecycle services.
'use strict';

const { app, dialog } = require('electron');
const { runBootstrap } = require('./bootstrap/index.js');
const { createAppContainer } = require('./container.js');

let container = null;

const bootstrapCtx = {
  app,
  dialog,
  argv: process.argv,
  cwd: process.cwd(),
  handleFocusWindow: (record) => {
    if (container) {
      container.handleFocusWindow(record);
    }
  },
};

// 1. Run bootstrap steps (early flags, env profile, single-instance lock, safe storage)
runBootstrap(bootstrapCtx);

// 2. Build the application composition root and wire lifecycle
container = createAppContainer(bootstrapCtx);

module.exports = {
  container,
  bootstrapCtx,
};
