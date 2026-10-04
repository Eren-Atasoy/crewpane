'use strict';

const instancePaths = require('../../config/instancePaths.cjs');
const singleInstanceLock = require('../../core/singleInstanceLock.cjs');
const appScheme = require('../../core/appScheme.cjs');
const i18n = require('../../../i18n/index.cjs');

/**
 * Bootstrap Step 05: Single Instance Lock
 *
 * Her platformda tekil çalışma kilidini zorunlu tutar.
 * Erken kapı kararı burada verilir, diyalog ve arayüz whenReady sonrasına bırakılır.
 */
function run(ctx) {
  const app = ctx.app;
  const dialog = ctx.dialog;
  const argv = ctx.argv || process.argv;
  const cwd = ctx.cwd || process.cwd();

  const singleInstanceEarlyLog = [];

  const locale = (() => {
    const pinned = process.env.CREWPANE_SYSTEM_LOCALE;
    if (typeof pinned === 'string' && pinned.trim()) return i18n.localeFromSystem(pinned.trim());
    let sys = '';
    try {
      sys = (app && app.getLocale()) || '';
    } catch {
      /* whenReady öncesi */
    }
    if (!sys) {
      try {
        sys = Intl.DateTimeFormat().resolvedOptions().locale || '';
      } catch {
        /* ICU yok */
      }
    }
    return i18n.localeFromSystem(sys);
  })();

  const singleInstanceGate = singleInstanceLock.enforce({
    app,
    dialog,
    dataRoot: ctx.instanceHome || instancePaths.instanceHome(),
    instanceId: ctx.instanceId || instancePaths.instanceId(),
    argv,
    cwd,
    deepLinkPrefix: appScheme.appSchemePrefix(),
    locale,
    log: (m) => {
      try {
        process.stderr.write(`[single-instance] ${m}\n`);
      } catch {
        /* best-effort */
      }
      try {
        singleInstanceEarlyLog.push(m);
      } catch {
        /* best-effort */
      }
    },
    focusWindow: (record) => {
      if (typeof ctx.handleFocusWindow === 'function') {
        try {
          ctx.handleFocusWindow(record);
        } catch (e) {
          try {
            process.stderr.write(`[single-instance] focus error: ${e.message}\n`);
          } catch {
            /* ignore */
          }
        }
      }
    },
  });

  ctx.singleInstanceGate = singleInstanceGate;
  ctx.singleInstanceEarlyLog = singleInstanceEarlyLog;
}

module.exports = { run };
