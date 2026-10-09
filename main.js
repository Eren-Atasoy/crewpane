// CrewPane — Electron MAIN process entry shell.
//
// The monolithic main.js was decomposed into modular domains and features (Phase 3).
// Application bootstrapping and composition root live in src/main/index.js.
//
// Security: contextIsolation:true, nodeIntegration:false, sandbox:true.
'use strict';

module.exports = require('./src/main');
