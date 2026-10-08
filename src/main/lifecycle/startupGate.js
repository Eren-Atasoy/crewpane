'use strict';

const defaultSingleInstanceLock = require('../../core/singleInstanceLock.cjs');
const defaultTranslocationNotice = require('../../core/translocationNotice.cjs');
const defaultInstancePaths = require('../../config/instancePaths.cjs');
const defaultCrashJournal = require('../../core/crashJournal.cjs');
const defaultI18n = require('../../../i18n/index.cjs');

const defaultStartupGateOptions = {
  app: null,
  dialog: null,
  singleInstanceGate: null,
  singleInstanceEarlyLog: [],
  resetGate: null,
  resetBootService: null,
  resetT: (k) => k,
  logEnvBannerAndGuard: () => ({ level: 'ok' }),
  applyAppLocale: () => {},
  initLog: () => {},
  logLine: () => {},
  crewpaneHome: () => '',
  instancePaths: defaultInstancePaths,
  singleInstanceLock: defaultSingleInstanceLock,
  translocationNotice: defaultTranslocationNotice,
  crashJournal: defaultCrashJournal,
  i18n: defaultI18n,
  logTarget: null,
  logPath: '',
};

function normalizeStartupGateDeps(deps = {}) {
  return Object.assign({}, defaultStartupGateOptions, deps);
}

function checkResetCliLock(resetCli, { singleInstanceGate, dialog, resetT, app }) {
  const lockIsOurs = !singleInstanceGate
    || singleInstanceGate.enforced === false
    || singleInstanceGate.primary === true;

  if (resetCli && !lockIsOurs) {
    try { process.stderr.write('[reset] kilit BİZDE DEĞİL — uygulama açık, sıfırlama yapılmadı\n'); } catch { /* ignore */ }
    try {
      dialog.showMessageBoxSync({
        type: 'warning',
        title: resetT('main.reset.locked.title'),
        message: resetT('main.reset.locked.message'),
        detail: resetT('main.reset.locked.detail'),
        buttons: [resetT('main.reset.partial.button.ok')],
        noLink: true,
      });
    } catch { /* kutu çizilemedi */ }
    if (app) app.exit(2);
    return false;
  }
  return true;
}

async function applyResetAndInit(resetCli, deps) {
  const resetLines = [];
  const resetLog = (m) => {
    resetLines.push(String(m));
    try { process.stderr.write(`${m}\n`); } catch { /* ignore */ }
  };

  try {
    if (resetCli && await deps.resetBootService.runArgvReset(resetCli, resetLog)) return false;
    if (!resetCli) await deps.resetBootService.applyPendingReset(resetLog);
  } catch (e) {
    resetLog(`[reset] açılış kancası HATASI (${(e && e.code) || 'ERR'}) — açılış normal sürüyor`);
  }

  deps.initLog();
  for (const line of resetLines) deps.logLine(line);
  for (const line of deps.singleInstanceEarlyLog.splice(0)) deps.logLine(`[single-instance] ${line}`);
  if (deps.singleInstanceGate) {
    const gate = deps.singleInstanceGate;
    deps.logLine(`[single-instance] sonuç: primary=${!!gate.primary}`
      + ` forced=${!!gate.forced} degraded=${!!gate.degraded}`
      + `${gate.why ? ` why=${gate.why}` : ''}`
      + `${gate.reason ? ` reason=${gate.reason}` : ''}`);
  }

  if (!resetCli) deps.resetBootService.showPartialWipeDialog(deps.logLine);
  return true;
}

/**
 * Creates the Startup Gate for application boot validation (RESET-03, ENV-08, CRASH-R1).
 */
function createStartupGate(rawDeps = {}) {
  const deps = normalizeStartupGateDeps(rawDeps);

  async function runResetPhase(resetCli) {
    if (!checkResetCliLock(resetCli, deps)) return { proceed: false };

    if (deps.singleInstanceGate && typeof deps.singleInstanceGate.whenDecided === 'function'
      && await deps.singleInstanceGate.whenDecided()) {
      return { proceed: false };
    }

    const applied = await applyResetAndInit(resetCli, deps);
    return { proceed: applied };
  }

  function reportPreviousCrash() {
    try {
      const home = typeof deps.crewpaneHome === 'function' ? deps.crewpaneHome() : deps.crewpaneHome;
      const target = typeof deps.logTarget === 'function' ? deps.logTarget() : deps.logTarget;
      const pathStr = typeof deps.logPath === 'function' ? deps.logPath() : deps.logPath;
      if (deps.app && deps.app.isPackaged && target && target.isolated) {
        deps.logLine(`[crash-r1] YALITILMIŞ GÜNLÜK (${target.source}) → ${pathStr} — canlı uygulamanın günlüğüne DOKUNULMADI`);
      }
      deps.logLine(`[crash-r1] ${deps.crashJournal.formatPrevious(deps.crashJournal.readLast(deps.instancePaths.instanceHome(home)))}`);
      deps.crashJournal.trim(deps.instancePaths.instanceHome(home));
    } catch (e) {
      deps.logLine(`[crash-r1] kapanış defteri okunamadı: ${e.message}`);
    }
  }

  function checkTranslocation() {
    try {
      if (!deps.translocationNotice.isTransientLocation(process.execPath, process.platform)) return;
      deps.logLine(`[env-08] geçici konumdan koşuyor (AppTranslocation/DMG): ${process.execPath}`);
      deps.dialog.showMessageBox({
        type: 'warning',
        title: deps.i18n.t('main.translocation.title'),
        message: deps.i18n.t('main.translocation.message'),
        detail: deps.i18n.t('main.translocation.detail'),
        buttons: [deps.i18n.t('main.translocation.button.ok'), deps.i18n.t('main.translocation.button.separateProfile')],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      }).then(({ response }) => {
        if (response !== 1) return;
        deps.logLine('[env-08] kullanıcı geçici konumdan AYRI TEST PROFİLİYLE yeniden başlatmayı seçti');
        try {
          deps.singleInstanceLock.releaseForRelaunch({
            dataRoot: deps.instancePaths.instanceHome(),
            log: (m) => deps.logLine(`[env-08] ${m}`),
          });
        } catch (e) { deps.logLine(`[env-08] kilit bırakılamadı: ${e && e.message}`); }
        const args = process.argv.slice(1)
          .filter((a) => !/^--(crewpane-)?instance=/.test(a))
          .concat(['--instance=test']);
        try { deps.app.relaunch({ args }); } catch (e) { deps.logLine(`[env-08] relaunch hatası: ${e && e.message}`); }
        deps.app.exit(0);
      }).catch((e) => deps.logLine(`[env-08] translocation kutusu gösterilemedi: ${e && e.message}`));
    } catch (e) {
      deps.logLine(`[env-08] translocation tespiti atlandı: ${e && e.message}`);
    }
  }

  async function runStartupGate(argv = process.argv) {
    const resetCli = deps.resetGate ? deps.resetGate.argvReset(argv) : null;
    const resetRes = await runResetPhase(resetCli);
    if (!resetRes.proceed) return { proceed: false };

    if (deps.logEnvBannerAndGuard().level === 'block') return { proceed: false };

    reportPreviousCrash();
    deps.applyAppLocale();
    checkTranslocation();

    return { proceed: true };
  }

  return {
    runStartupGate,
    runResetPhase,
    reportPreviousCrash,
    checkTranslocation,
  };
}

module.exports = {
  createStartupGate,
};
