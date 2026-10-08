'use strict';

const defaultResourceGovernorModule = require('../../terminal/resourceGovernor.cjs');

/**
 * Resource Governor Service (Faz 3.6.58)
 * Manages memory pressure sampling, governor instance caching, and renderer notification.
 */
function createResourceGovernorService(deps = {}) {
  const {
    resourceGovernorModule = defaultResourceGovernorModule,
    agentSettings = { readSettings: () => ({}) },
    getAppWindow = () => null,
    logLine = () => {},
  } = deps;

  let _resourceGovernor = null;
  let _resourceGovernorTimer = null;

  function _resolveSettings() {
    try {
      const read = agentSettings.readSettings();
      if (read && read.resourceGovernor) return read.resourceGovernor;
    } catch {
      // fallback to fail-open
    }
    return { enabled: false, warnFreePct: 1, criticalFreePct: 0 };
  }

  function resourceGovernor() {
    if (_resourceGovernor) return _resourceGovernor;
    const settings = _resolveSettings();
    _resourceGovernor = resourceGovernorModule.createGovernor({
      settings,
      log: (line) => logLine(line),
      onChange: (state) => {
        const win = getAppWindow();
        if (win && !win.isDestroyed()) {
          try {
            win.webContents.send('resource:pressure', state);
          } catch {
            /* window disposed */
          }
        }
      },
    });
    return _resourceGovernor;
  }

  function startResourceGovernorSampling() {
    if (_resourceGovernorTimer) return;
    const gov = resourceGovernor();
    const period = Math.max(1000, Number(gov.state().settings.sampleMs) || 5000);
    try {
      gov.sample();
    } catch (err) {
      logLine(`resourceGovernor ilk ölçüm patladı: ${err.message}`);
    }
    _resourceGovernorTimer = setInterval(() => {
      try {
        gov.sample();
      } catch (err) {
        logLine(`resourceGovernor ölçüm patladı: ${err.message}`);
      }
    }, period);
    if (_resourceGovernorTimer.unref) _resourceGovernorTimer.unref();
    logLine(`resourceGovernor: örnekleme başladı (${period} ms)`);
  }

  function stopResourceGovernorSampling() {
    if (_resourceGovernorTimer) {
      clearInterval(_resourceGovernorTimer);
      _resourceGovernorTimer = null;
    }
  }

  return {
    resourceGovernor,
    startResourceGovernorSampling,
    stopResourceGovernorSampling,
    resourceGovernorModule,
    getGovernor: resourceGovernor,
    state: () => resourceGovernor().state(),
    sample: () => resourceGovernor().sample(),
  };
}

module.exports = {
  createResourceGovernorService,
};
