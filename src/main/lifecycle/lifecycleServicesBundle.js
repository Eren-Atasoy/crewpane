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
    try {
      const gate = await startupGate.runStartupGate(process.argv);
      if (!gate.proceed) return;

      const appBootService = createAppBootService(bootDeps);
      await appBootService.boot();
    } catch (bootErr) {
      const msg = bootErr && bootErr.stack ? bootErr.stack : String(bootErr);
      if (bootDeps && typeof bootDeps.logLine === 'function') {
        bootDeps.logLine(`[boot] kritik başlatma hatası: ${msg}`);
      }
      try { process.stderr.write(`[boot] kritik başlatma hatası: ${msg}\n`); } catch { /* ignore */ }
    }
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
