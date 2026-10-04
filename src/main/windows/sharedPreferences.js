'use strict';

const path = require('node:path');

/**
 * Shared webPreferences for all BrowserWindow instances.
 * Security defaults: contextIsolation: true, nodeIntegration: false, sandbox: true.
 * Background throttling is disabled to keep timers/pty alive when windows are hidden (ADP-003).
 */
function createSharedWebPreferences(deps) {
  const {
    preloadPath = path.resolve(__dirname, '../../../dist/preload.js'),
    supabaseTarget,
    rendererSupabaseTarget,
    appI18n,
    applyAppLocale,
  } = deps;

  return {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    backgroundThrottling: false,
    additionalArguments: [
      supabaseTarget.encodeArgv(rendererSupabaseTarget()),
      appI18n.encodeArgv(applyAppLocale()),
    ],
  };
}

module.exports = {
  createSharedWebPreferences,
};
