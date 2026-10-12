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
    backendEnvService,
  } = deps;

  const resolveTarget = rendererSupabaseTarget || (() => (backendEnvService ? backendEnvService.rendererSupabaseTarget() : null));

  return {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    backgroundThrottling: false,
    additionalArguments: [
      '--agentspace-bridges=*',
      '--crewpane-bridges=*',
      supabaseTarget.encodeArgv(resolveTarget()),
      '--agentspace-db=' + Buffer.from(JSON.stringify(resolveTarget()), 'utf8').toString('base64'),
      appI18n.encodeArgv(applyAppLocale()),
      String(appI18n.encodeArgv(applyAppLocale())).replace('--crewpane-locale=', '--agentspace-locale='),
      '--agentspace-titlebar=' + (process.platform === 'darwin' ? 'mac' : 'overlay'),
      '--crewpane-titlebar=' + (process.platform === 'darwin' ? 'mac' : 'overlay'),
    ],
  };
}

module.exports = {
  createSharedWebPreferences,
};
