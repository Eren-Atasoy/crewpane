'use strict';
/**
 * CrewPane Domain: CORE
 */
const path = require('node:path');

module.exports = {
  get appScheme() { return require(path.join(__dirname, "appScheme.cjs")); },
  get childIpcSafe() { return require(path.join(__dirname, "childIpcSafe.cjs")); },
  get crashJournal() { return require(path.join(__dirname, "crashJournal.cjs")); },
  get crashWatchdog() { return require(path.join(__dirname, "crashWatchdog.cjs")); },
  get e2eParentWatchdog() { return require(path.join(__dirname, "e2eParentWatchdog.cjs")); },
  get helperReaper() { return require(path.join(__dirname, "helperReaper.cjs")); },
  get helperWatchdog() { return require(path.join(__dirname, "helperWatchdog.cjs")); },
  get mainStallMonitor() { return require(path.join(__dirname, "mainStallMonitor.cjs")); },
  get orphanElectron() { return require(path.join(__dirname, "orphanElectron.cjs")); },
  get quitFunnel() { return require(path.join(__dirname, "quitFunnel.cjs")); },
  get schemeOwnership() { return require(path.join(__dirname, "schemeOwnership.cjs")); },
  get singleInstanceLock() { return require(path.join(__dirname, "singleInstanceLock.cjs")); },
  get stdioGuard() { return require(path.join(__dirname, "stdioGuard.cjs")); },
  get translocationNotice() { return require(path.join(__dirname, "translocationNotice.cjs")); },
  get vendorSurface() { return require(path.join(__dirname, "vendorSurface.cjs")); },
};
