'use strict';
/**
 * CrewPane Domain: TERMINAL
 */
const path = require('node:path');

module.exports = {
  get limitDetect() { return require(path.join(__dirname, "limitDetect.cjs")); },
  get paneAsk() { return require(path.join(__dirname, "paneAsk.cjs")); },
  get paneBudget() { return require(path.join(__dirname, "paneBudget.cjs")); },
  get paneBudgetStore() { return require(path.join(__dirname, "paneBudgetStore.cjs")); },
  get paneCapabilityMatrix() { return require(path.join(__dirname, "paneCapabilityMatrix.cjs")); },
  get paneContextScope() { return require(path.join(__dirname, "paneContextScope.cjs")); },
  get paneControl() { return require(path.join(__dirname, "paneControl.cjs")); },
  get paneDraft() { return require(path.join(__dirname, "paneDraft.cjs")); },
  get paneEarlyExit() { return require(path.join(__dirname, "paneEarlyExit.cjs")); },
  get paneKill() { return require(path.join(__dirname, "paneKill.cjs")); },
  get paneScreen() { return require(path.join(__dirname, "paneScreen.cjs")); },
  get paneSessionAnchor() { return require(path.join(__dirname, "paneSessionAnchor.cjs")); },
  get paneSessionsJournal() { return require(path.join(__dirname, "paneSessionsJournal.cjs")); },
  get paneTokenBudget() { return require(path.join(__dirname, "paneTokenBudget.cjs")); },
  get paneViewState() { return require(path.join(__dirname, "paneViewState.cjs")); },
  get ptyResizeGate() { return require(path.join(__dirname, "ptyResizeGate.cjs")); },
  get resourceGovernor() { return require(path.join(__dirname, "resourceGovernor.cjs")); },
  get resumeDaemonCore() { return require(path.join(__dirname, "resumeDaemonCore.cjs")); },
  get resumeNotify() { return require(path.join(__dirname, "resumeNotify.cjs")); },
  get resumePaneRegistry() { return require(path.join(__dirname, "resumePaneRegistry.cjs")); },
  get resumePtyDaemon() { return require(path.join(__dirname, "resumePtyDaemon.cjs")); },
  get resumeQueue() { return require(path.join(__dirname, "resumeQueue.cjs")); },
  get resumeScheduler() { return require(path.join(__dirname, "resumeScheduler.cjs")); },
  get resumeTelemetry() { return require(path.join(__dirname, "resumeTelemetry.cjs")); },
  get resumeTmux() { return require(path.join(__dirname, "resumeTmux.cjs")); },
  get tmuxWindows() { return require(path.join(__dirname, "tmuxWindows.cjs")); },
};
