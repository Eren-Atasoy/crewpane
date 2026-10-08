'use strict';

const { createStartupGate } = require('./startupGate');
const { createAppBootService } = require('./appBootService');
const { createLifecycleManager } = require('./lifecycleManager');

/**
 * Lifecycle Services Bundle (Phase 3.6.66)
 * Orchestrates StartupGate, AppBootService (whenReady hook), and LifecycleManager.
 */
function setupLifecycleServices({
  app,
  startupGateDeps = {},
  bootDeps = {},
  lifecycleDeps = {},
} = {}) {
  const startupGate = createStartupGate(startupGateDeps);

  app.whenReady().then(async () => {
    const gate = await startupGate.runStartupGate(process.argv);
    if (!gate.proceed) return;

    const appBootService = createAppBootService(bootDeps);
    await appBootService.boot();
  });

  const lifecycleManager = createLifecycleManager(lifecycleDeps);
  lifecycleManager.register();

  return {
    startupGate,
    lifecycleManager,
  };
}

module.exports = {
  setupLifecycleServices,
};
