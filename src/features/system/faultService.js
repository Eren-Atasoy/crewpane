'use strict';

const path = require('node:path');
const os = require('node:os');
const errorReporterCore = require('../../../telemetry/errorReporter.cjs');
const moduleGuardCore = require('../../agents/moduleGuard.cjs');
const telemetryChannelCore = require('../../../telemetry/channel.cjs');

/**
 * Modül adından Sentry YÜZEYİ (main | renderer | worker) — etiket tek kaynaktan.
 */
function obsSurfaceFor(moduleName) {
  if (moduleName === 'renderer') return 'renderer';
  if (moduleName === 'worker' || moduleName === 'pane') return 'worker';
  return 'main';
}

/**
 * Module Faults, Error Reporting & Guard Supervision Service (Faz 3.6.10)
 */
function createFaultService(deps = {}) {
  const {
    app,
    getAppWindow = () => null,
    logLine = () => {},
    telemetryEnvNow = () => ({}),
    telemetryEnabledNow = () => true,
    telemetryChannelMod = telemetryChannelCore,
    errorReporter = errorReporterCore,
    moduleGuard = moduleGuardCore,
    appRoot = path.resolve(__dirname, '..', '..', '..', '..'),
  } = deps;

  const moduleFaults = [];
  const supervisors = new Map();
  let obsReporter = null;

  function obsReporterNow() {
    if (obsReporter) return obsReporter;
    try {
      const env = telemetryEnvNow();
      const channel = telemetryChannelMod.resolveChannel();
      obsReporter = errorReporter.createErrorReporter({
        dsn: telemetryChannelMod.resolveDsn(channel, env),
        channel,
        app: 'crewpane',
        appVersion: app ? app.getVersion() : '0.0.0',
        appRoot,
        homeDir: os.homedir(),
        osInfo: { platform: process.platform, arch: process.arch, release: os.release() },
        enabled: () => telemetryEnabledNow(),
        log: (line) => logLine(line),
      });
    } catch (e) {
      obsReporter = {
        capture: () => ({ sent: false, reason: 'init-failed' }),
        stats: () => ({}),
        enabledNow: () => false,
      };
      try {
        logLine(`obs: raporlayıcı kurulamadı (${e && e.message})`);
      } catch {
        /* best-effort fallback */
      }
    }
    return obsReporter;
  }

  function reportModuleFault(fault, extra) {
    moduleFaults.push(fault);
    if (moduleFaults.length > 50) moduleFaults.shift();
    logLine(
      `MODULE FAULT ${fault.module}${fault.label ? `/${fault.label}` : ''}: ${fault.message} `
      + `@ ${fault.location || '?'}${fault.stopped ? ' — MODÜL DURDURULDU (degrade)' : ''}`,
    );
    try {
      const win = getAppWindow();
      if (win && !win.isDestroyed()) win.webContents.send('module:fault', fault);
    } catch {
      /* pencere gitti — log'da zaten var */
    }
    try {
      obsReporterNow().capture({
        surface: obsSurfaceFor(fault.module),
        module: fault.module,
        label: fault.label,
        message: fault.message,
        location: fault.location,
        stopped: fault.stopped,
        fatal: fault.fatal,
        level: fault.level,
        stack: extra && extra.stack,
        stage: fault.stage,
        renderer: fault.renderer,
        attempt: fault.attempt,
        engine: fault.engine,
        msSinceSpawn: fault.msSinceSpawn,
        firstDataBytes: fault.firstDataBytes,
      });
    } catch {
      /* hata takibi hata üretmez */
    }
  }

  function supervisorFor(name) {
    let sup = supervisors.get(name);
    if (!sup) {
      sup = moduleGuard.createSupervisor({
        name,
        onFault: (fault, err) => reportModuleFault(fault, { stack: err && err.stack }),
        log: (m) => logLine(`[guard] ${m}`),
      });
      supervisors.set(name, sup);
    }
    return sup;
  }

  return {
    moduleFaults,
    supervisors,
    obsReporterNow,
    reportModuleFault,
    supervisorFor,
    obsSurfaceFor,
  };
}

module.exports = {
  createFaultService,
  obsSurfaceFor,
};
