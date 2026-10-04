'use strict';

const instancePaths = require('../../config/instancePaths.cjs');

/**
 * Bootstrap Step 06: Chromium & Electron Command Line Switches
 *
 * 1. Mock keychain for test instances (prevents corrupting user's real keychain).
 * 2. Autoplay policy bypass (required for voice assistant).
 * 3. Windows-specific renderer throttling bypass.
 */
function run(ctx) {
  const app = ctx.app;
  if (!app || !app.commandLine) return;

  const instanceId = ctx.instanceId || instancePaths.instanceId();

  if (instanceId === 'test') {
    try {
      app.commandLine.appendSwitch('use-mock-keychain');
    } catch {
      /* best-effort */
    }
  }

  try {
    app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  } catch {
    /* best-effort */
  }

  if (process.platform === 'win32') {
    try {
      app.commandLine.appendSwitch('disable-renderer-backgrounding');
    } catch {
      /* best-effort */
    }
    try {
      app.commandLine.appendSwitch('disable-background-timer-throttling');
    } catch {
      /* best-effort */
    }
  }
}

module.exports = { run };
