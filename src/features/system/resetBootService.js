'use strict';

const os = require('node:os');
const fs = require('node:fs');
const appI18nDefault = require('../../../i18n/index.cjs');
const installResetDefault = require('../../security/installReset.cjs');
const resetGateDefault = require('../../security/resetGate.cjs');
const helperReaperDefault = require('../../core/helperReaper.cjs');

function resolveResetBootLocale(app, appI18n) {
  try {
    const pinned = process.env.CREWPANE_SYSTEM_LOCALE;
    if (typeof pinned === 'string' && pinned.trim()) return appI18n.localeFromSystem(pinned.trim());
    let sys = '';
    try { sys = app.getLocale() || ''; } catch { /* ready öncesi boş dönebilir */ }
    if (!sys) { try { sys = Intl.DateTimeFormat().resolvedOptions().locale || ''; } catch { /* ICU yok */ } }
    return appI18n.localeFromSystem(sys);
  } catch {
    return undefined;
  }
}

function resolveResetT(key, app, appI18n) {
  return appI18n.t(key, undefined, resolveResetBootLocale(app, appI18n));
}

function selectUpdaterCacheDir(app, resetGate) {
  const cands = resetGate.updaterCacheCandidates({
    platform: process.platform,
    homedir: os.homedir(),
    env: process.env,
    userDataDir: app.getPath('userData'),
    appName: app.getName(),
  });
  for (const c of cands) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* erişilemiyor → sıradaki */
    }
  }
  return cands[0] || null;
}

function createResetContextHelper(log, app, resetGate, installReset) {
  const deps = {
    log,
    userDataDir: app.getPath('userData'),
    logsDir: app.getPath('logs'),
    updaterCacheDir: selectUpdaterCacheDir(app, resetGate),
  };
  const instanceHome = installReset._internal.normalizeDeps(deps).instanceHome;
  return { deps, instanceHome };
}

function emitResetTelemetry(o, analyticsNow, resetGate) {
  try {
    const tracker = typeof analyticsNow === 'function' ? analyticsNow() : analyticsNow;
    if (tracker) {
      tracker.track('install_reset', {
        level: o.level,
        source: o.source,
        bytes_planned_bucket: resetGate.bytesBucket(o.bytes),
      });
      tracker.flush('install_reset');
    }
  } catch {
    /* telemetri ASLA çağıranı düşürmez */
  }
}

async function promptArgvConfirm(req, log, dialog, resetT, app) {
  if (req.yes) return true;
  let picked = 1;
  try {
    picked = dialog.showMessageBoxSync({
      type: 'warning',
      title: resetT('main.reset.confirm.title'),
      message: req.level === 'session'
        ? resetT('main.reset.session.message')
        : resetT('main.reset.confirm.message'),
      detail: resetT('main.reset.confirm.detail'),
      buttons: [resetT('main.reset.confirm.button.yes'), resetT('main.reset.confirm.button.cancel')],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
  } catch (e) {
    log(`[reset] onay kutusu gösterilemedi (${e && e.message}) — sıfırlama İPTAL`);
    app.exit(2);
    return false;
  }
  if (picked !== 0) {
    log('[reset] kullanıcı vazgeçti — hiçbir şey silinmedi');
    app.exit(0);
    return false;
  }
  return true;
}

function reapHelpersSafe(instanceHome, log, helperReaper) {
  try {
    const reap = helperReaper.reapStaleHelpers(instanceHome, { log: (m) => log(`[reset] ${m}`) });
    if (reap && reap.reaped.length) log(`[reset] ${reap.reaped.length} yetim yardımcı biçildi (dosya kilidi)`);
  } catch (e) {
    log(`[reset] yetim toplama atlandı (${(e && e.code) || 'ERR'})`);
  }
}

async function finalizeMarker(instanceHome, resetDeps, notice, installReset, log) {
  if (notice.lockedCount) {
    log('[reset] işaretçi KORUNDU — kilitli hedefler bir sonraki açılışta tekrar denenecek');
  } else {
    const cleared = await installReset.clearMarker(instanceHome, resetDeps);
    log(`[reset] işaretçi temizlendi=${cleared.ok ? 1 : 0}`);
  }
}

/**
 * Reset Boot & Install Wipe Service (Faz 3.6.16)
 */
function createResetBootService(deps = {}) {
  const {
    app,
    dialog,
    appI18n = appI18nDefault,
    installReset = installResetDefault,
    resetGate = resetGateDefault,
    helperReaper = helperReaperDefault,
    analyticsNow = () => null,
  } = deps;

  let resetBootNotice = null;

  const resetBootLocale = () => resolveResetBootLocale(app, appI18n);
  const resetT = (key) => resolveResetT(key, app, appI18n);
  const pickUpdaterCacheDir = () => selectUpdaterCacheDir(app, resetGate);
  const resetContext = (log) => createResetContextHelper(log, app, resetGate, installReset);
  const sendResetTelemetry = (o) => emitResetTelemetry(o, analyticsNow, resetGate);
  const getResetBootNotice = () => resetBootNotice;
  const setResetBootNotice = (n) => { resetBootNotice = n; };

  async function applyPendingReset(log) {
    const { deps: resetDeps, instanceHome } = resetContext(log);
    let marker = null;
    try {
      marker = await installReset.readMarker(instanceHome, resetDeps);
    } catch (e) {
      log(`[reset] işaretçi okunamadı (${(e && e.code) || 'ERR'})`);
      return null;
    }
    if (!marker) return null;
    log(`[reset] bekleyen istek uygulanıyor (seviye=${marker.level} yaş=${Math.round(marker.ageMs / 1000)}sn)`);
    reapHelpersSafe(instanceHome, log, helperReaper);
    let res;
    try {
      res = await installReset.execute({ ...resetDeps, level: marker.level, keepLogs: marker.keepLogs });
    } catch (e) {
      log(`[reset] uygulama HATASI (${(e && e.code) || 'ERR'}) — işaretçi korundu`);
      const partial = { kind: 'partial', level: marker.level, bytesFreed: null, removedCount: 0, lockedCount: 1, skippedCount: 0 };
      resetBootNotice = partial;
      return partial;
    }
    const notice = resetGate.bootNotice(marker.level, res);
    log(`[reset] sonuç ok=${res.ok ? 1 : 0} silinen=${notice.removedCount} kilitli=${notice.lockedCount} `
      + `atlanan=${notice.skippedCount} süre=${res.durationMs}ms`);
    await finalizeMarker(instanceHome, resetDeps, notice, installReset, log);
    resetBootNotice = notice;
    return notice;
  }

  async function runArgvReset(req, log) {
    if (req.invalid !== undefined) {
      log('[reset] komut satırında TANINMAYAN seviye — hiçbir şey silinmedi');
      try {
        dialog.showErrorBox(resetT('main.reset.badLevel.title'), resetT('main.reset.badLevel.detail'));
      } catch { /* kutu çizilemedi → stdout satırı kaldı */ }
      app.exit(2);
      return true;
    }
    const confirmed = await promptArgvConfirm(req, log, dialog, resetT, app);
    if (!confirmed) return true;

    const { deps: resetDeps } = resetContext(log);
    log(`[reset] komut satırından sıfırlama (seviye=${req.level} onay=${req.yes ? 'bayrak' : 'kutu'})`);
    let planned = null;
    try { planned = await installReset.plan({ ...resetDeps, level: req.level }); } catch { /* kova 'unknown' */ }
    sendResetTelemetry({ level: req.level, source: 'cli', bytes: planned && planned.bytesTotal });
    const res = await installReset.execute({ ...resetDeps, level: req.level });
    const notice = resetGate.bootNotice(req.level, res);
    log(`[reset] cli sonuç ok=${res.ok ? 1 : 0} silinen=${notice.removedCount} kilitli=${notice.lockedCount}`);
    if (notice.lockedCount) {
      try {
        dialog.showMessageBoxSync({
          type: 'warning',
          title: resetT('main.reset.partial.title'),
          message: resetT('main.reset.partial.message'),
          detail: resetT('main.reset.partial.detail'),
          buttons: [resetT('main.reset.partial.button.ok')],
          noLink: true,
        });
      } catch { /* best-effort */ }
    }
    resetBootNotice = notice;
    return false;
  }

  function showPartialWipeDialog(logLine = () => {}) {
    if (!resetBootNotice || resetBootNotice.kind !== 'partial') return;
    try {
      dialog.showMessageBox({
        type: 'warning',
        title: resetT('main.reset.partial.title'),
        message: resetT('main.reset.partial.message'),
        detail: resetT('main.reset.partial.detail'),
        buttons: [resetT('main.reset.partial.button.ok')],
        noLink: true,
      }).catch(() => {});
    } catch (e) {
      logLine(`[reset] uyarı kutusu gösterilemedi: ${e && e.message}`);
    }
  }

  return {
    resetBootLocale,
    resetT,
    pickUpdaterCacheDir,
    resetContext,
    sendResetTelemetry,
    getResetBootNotice,
    setResetBootNotice,
    applyPendingReset,
    runArgvReset,
    showPartialWipeDialog,
  };
}

module.exports = {
  createResetBootService,
};
