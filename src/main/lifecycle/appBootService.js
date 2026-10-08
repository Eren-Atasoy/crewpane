'use strict';

const fs = require('node:fs');
const path = require('node:path');

function ensureSpawnHelperExecutableDefault({ app, logLine = () => {}, repoRoot = __dirname, resourcesPath = process.resourcesPath } = {}) {
  if (process.platform === 'win32') return;
  const rel = path.join('node-pty', 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
  const appPath = app && typeof app.getAppPath === 'function' ? app.getAppPath() : repoRoot;
  const candidates = [
    path.join(repoRoot, 'node_modules', rel),
    path.join(appPath + '.unpacked', 'node_modules', rel),
    path.join(resourcesPath || '', 'app.asar.unpacked', 'node_modules', rel),
  ];
  for (const helper of candidates) {
    try {
      const mode = fs.statSync(helper).mode;
      if (!(mode & 0o111)) {
        fs.chmodSync(helper, 0o755);
        logLine(`fixed spawn-helper exec bit: ${helper}`);
      }
    } catch {
      /* not present at this candidate path — try the next */
    }
  }
}

function initSyncState(syncRuntime, prefsApplySoon, prefsProjectNow, logLine) {
  try {
    if (syncRuntime && typeof syncRuntime.refresh === 'function') {
      const st = syncRuntime.refresh({ tickNow: true });
      logLine(`[sync] açılış: ${st.enabled ? `AÇIK (workspace=${st.setup.workspaceKey})` : `kapalı (${st.setup.reason})`}`);
    }
  } catch (e) {
    logLine(`[sync] açılış bağlaması hatası: ${e.message}`);
  }

  try {
    if (typeof prefsApplySoon === 'function') prefsApplySoon();
    if (typeof prefsProjectNow === 'function') prefsProjectNow('boot');
  } catch (e) {
    logLine(`[prefs] açılış bağlaması hatası: ${e.message}`);
  }
}

function drainAuthAndDeepLinks(consumeArgvDeepLink, drainPendingAuthUrls) {
  if (process.platform !== 'darwin' && typeof consumeArgvDeepLink === 'function') {
    consumeArgvDeepLink(process.argv, 'cold-start-argv');
  }
  if (typeof drainPendingAuthUrls === 'function') drainPendingAuthUrls();
}

function initSentryAndPosthog({ telemetryMod, app, agentSettings, telemetryProvisioning, obsReporterNow, telemetryChannelMod, analyticsNow, analyticsFirstTime, logLine }) {
  try {
    if (telemetryMod && typeof telemetryMod.initTelemetry === 'function') {
      const t = telemetryMod.initTelemetry({
        version: app.getVersion(),
        config: agentSettings.readSettings(),
        deps: { provisionStore: telemetryProvisioning().store },
      });
      logLine(`telemetry: hata-takibi ${t.enabled ? `AÇIK (${t.channel})` : `kapalı (${t.reason})`}`);
    }
  } catch (e) {
    logLine(`telemetry: init atlandı (${e && e.message})`);
  }

  try {
    const r = obsReporterNow();
    logLine(`obs: sentry ${r.enabledNow() ? 'AÇIK' : 'kapalı'} (kanal=${telemetryChannelMod.resolveChannel()}, sürüm=${app.getVersion()}, ${process.platform}/${process.arch})`);
  } catch { /* best effort */ }

  try {
    const a = analyticsNow();
    logLine(`analytics: posthog ${a.enabledNow() ? 'AÇIK' : 'kapalı'} (kanal=${telemetryChannelMod.resolveChannel()}, sürüm=${app.getVersion()})`);
    a.track('app_opened', { first_run: analyticsFirstTime('app_opened') });
  } catch { /* best effort */ }
}

function checkTamperState(tamperSignals, analyticsNow, obsReporterNow, logLine) {
  try {
    const finding = tamperSignals ? tamperSignals.detect() : null;
    if (finding) {
      logLine(`tamper: TUTARSIZLIK — ${finding.reason} (imza=${finding.signature})`);
      try { analyticsNow().track('tamper', finding); } catch { /* ignore */ }
      try {
        obsReporterNow().capture({
          surface: 'main',
          module: 'tamper',
          label: finding.reason,
          message: `paket bütünlüğü tutarsız: ${finding.reason}`,
          level: 'warning',
          tamper: true,
        });
      } catch { /* ignore */ }
    }
  } catch (e) {
    logLine(`tamper: ölçüm atlandı (${e && e.message})`);
  }
}

function injectSyntheticFault(faultInject, supervisorFor, logLine) {
  if (faultInject && faultInject.includes('obs') && supervisorFor) {
    logLine('obs: FAULT_INJECT=obs — main yüzeyinde sentetik hata fırlatılıyor');
    supervisorFor('obs-selftest').run('inject', () => globalThis.__obs_bu_fonksiyon_yok__(), null);
  }
}

function _normalizeUpdateRoutines(d) {
  const { updateService, announceService, changelogService } = d;
  if (updateService && !d.scheduleUpdateChecks) d.scheduleUpdateChecks = () => updateService.scheduleUpdateChecks();
  if (announceService && !d.scheduleAnnounceChecks) d.scheduleAnnounceChecks = () => announceService.scheduleAnnounceChecks();
  if (changelogService && !d.scheduleChangelogChecks) d.scheduleChangelogChecks = () => changelogService.scheduleChangelogChecks();
}

function _normalizeMemoryAndStorageRoutines(d) {
  const { startupSweepService, memoryService, workspaceFileService } = d;
  if (startupSweepService && !d.scheduleAutoMemoryIndex) d.scheduleAutoMemoryIndex = () => startupSweepService.scheduleAutoMemoryIndex();
  if (startupSweepService && !d.scanE2EResidueAtStartup) d.scanE2EResidueAtStartup = () => startupSweepService.scanE2EResidueAtStartup();
  if (memoryService && !d.memoryIndexerSingleton) d.memoryIndexerSingleton = memoryService.memoryIndexerSingleton;
  if (memoryService && !d.searchIndexSingleton) d.searchIndexSingleton = memoryService.searchIndexSingleton;
  if (workspaceFileService && !d.rehydrateGrantedRoots) d.rehydrateGrantedRoots = () => workspaceFileService.rehydrateGrantedRoots();
}

function _normalizeWindowRoutines(d) {
  const { windowManager, handService } = d;
  if (windowManager && !d.createSpikeWindow) d.createSpikeWindow = () => windowManager.createSpikeWindow();
  if (windowManager && !d.createAppWindow) d.createAppWindow = (url) => windowManager.createAppWindow(url);
  if (windowManager && !d.scheduleHandControlWarmup) d.scheduleHandControlWarmup = (att) => windowManager.scheduleHandControlWarmup(att);
  if (handService && !d.stopHandControl) d.stopHandControl = (why) => handService.stopHandControl(why);
}

function _normalizeTelemetryAndRestoreRoutines(d) {
  const { telemetryService, paneRestoreService } = d;
  if (telemetryService && !d.startHeartbeat) d.startHeartbeat = () => telemetryService.startHeartbeat();
  if (telemetryService && !d.telemetryProvisioning) d.telemetryProvisioning = () => telemetryService.telemetryProvisioning();
  if (telemetryService && !d.analyticsNow) d.analyticsNow = () => telemetryService.analyticsNow();
  if (telemetryService && !d.analyticsFirstTime) d.analyticsFirstTime = (m) => telemetryService.analyticsFirstTime(m);
  if (paneRestoreService && !d.offerRecoverablePanes) d.offerRecoverablePanes = (win, entries, meta) => paneRestoreService.offerRecoverablePanes(win, entries, meta);
}

function _normalizeBootDeps(deps) {
  const d = Object.assign({}, deps);
  _normalizeUpdateRoutines(d);
  _normalizeMemoryAndStorageRoutines(d);
  _normalizeWindowRoutines(d);
  _normalizeTelemetryAndRestoreRoutines(d);
  if (d.crashWatchdogService && !d.startCrashWatchdog) {
    d.startCrashWatchdog = () => d.crashWatchdogService.startCrashWatchdog();
  }
  return d;
}

class AppBootService {
  constructor(deps = {}) {
    this.deps = _normalizeBootDeps(deps);
  }

  setupEarlyObservers() {
    const { engineCoerce, livePaneRegistry, offerRecoverablePanes, getAppWindow, logLine, startCrashWatchdog, app } = this.deps;
    if (engineCoerce && typeof engineCoerce.setUnknownEngineObserver === 'function') {
      engineCoerce.setUnknownEngineObserver((info) => logLine(`ENG-05 ${info.message}`));
    }
    if (livePaneRegistry && typeof livePaneRegistry.setShrinkObserver === 'function') {
      livePaneRegistry.setShrinkObserver((info) => {
        logLine(`live-panes KÜÇÜLDÜ ${info.prev}→${info.next} (sebep=${info.reason}) yedek=${info.backup ?? '-'}`);
        if (info.next === 0 && info.reason !== 'consume' && offerRecoverablePanes) {
          try {
            const entries = Object.entries(info.panes || {}).map(([paneId, e]) => ({ paneId, ...e }));
            offerRecoverablePanes(getAppWindow(), entries, {
              reason: `registry-emptied:${info.reason}`,
              backup: info.backup,
            });
          } catch {
            // best-effort
          }
        }
      });
    }
    if (typeof startCrashWatchdog === 'function') startCrashWatchdog();
    if (app && typeof app.on === 'function') {
      app.on('child-process-gone', (_e, details) => {
        logLine(`CHILD PROCESS GONE: ${JSON.stringify(details)}`);
      });
    }
  }

  runStartupHygiene() {
    const {
      scanE2EResidueAtStartup,
      startupSweepService,
      ensureSpawnHelperExecutable,
      rehydrateGrantedRoots,
      crewpaneHome,
      repoRoot,
      standaloneDir,
      isPackaged,
      resourcesPath,
    } = this.deps;

    if (typeof scanE2EResidueAtStartup === 'function') scanE2EResidueAtStartup();
    if (startupSweepService) {
      if (typeof startupSweepService.scheduleMcpOrphanReap === 'function') {
        startupSweepService.scheduleMcpOrphanReap();
      }
      if (typeof startupSweepService.sweepOrphanHelpers === 'function') {
        startupSweepService.sweepOrphanHelpers({
          crewpaneHome: typeof crewpaneHome === 'function' ? crewpaneHome() : crewpaneHome,
          repoRoot,
          standaloneDir,
          isPackaged,
          resourcesPath,
        });
      }
    }
    if (typeof ensureSpawnHelperExecutable === 'function') {
      ensureSpawnHelperExecutable();
    } else {
      ensureSpawnHelperExecutableDefault({
        app: this.deps.app,
        logLine: this.deps.logLine,
        repoRoot: this.deps.repoRoot,
        resourcesPath: this.deps.resourcesPath,
      });
    }
    if (typeof rehydrateGrantedRoots === 'function') rehydrateGrantedRoots();
  }

  async initSecurityAndAccount() {
    const {
      schemeOwnership,
      app,
      appUrlScheme,
      isAutomatedSession,
      automatedSessionReason,
      setSchemeVerdict,
      logLine,
      safeStorageIdentity,
      safeStorageScope,
      secretBackendState,
      instanceHome,
      initSeatGate,
      bindAccountRoot,
      reresolveWorkspaceRootAfterAccountBind,
    } = this.deps;

    if (schemeOwnership && typeof schemeOwnership.claimAndVerify === 'function') {
      schemeOwnership.claimAndVerify({
        app,
        scheme: appUrlScheme,
        log: logLine,
        allowDevClaimEnv: 'CREWPANE_ALLOW_DEV_PROTOCOL_CLAIM',
        automated: isAutomatedSession,
        automatedReason: automatedSessionReason,
        platform: process.platform,
      }).then((v) => { if (typeof setSchemeVerdict === 'function') setSchemeVerdict(v); })
        .catch((e) => logLine(`scheme ownership check error: ${e && e.message}`));
    }

    try {
      logLine(`safeStorage keychain kapsamı: "${safeStorageIdentity.keychainServiceName(safeStorageScope)}"`);
      if (secretBackendState && typeof secretBackendState.initSecretBackendState === 'function') {
        secretBackendState.initSecretBackendState({
          safeStorage: require('electron').safeStorage,
          platform: process.platform,
          log: logLine,
        });
      }
      if (safeStorageIdentity && typeof safeStorageIdentity.migrateAuthBlobs === 'function') {
        safeStorageIdentity.migrateAuthBlobs({
          homeDir: instanceHome,
          scope: safeStorageScope,
          log: (line) => logLine(line),
        });
      }
    } catch (e) {
      logLine(`keychain scope migration error: ${e.message}`);
    }

    if (typeof initSeatGate === 'function') initSeatGate();
    if (typeof bindAccountRoot === 'function') {
      await bindAccountRoot('boot').catch((e) => logLine(`[account] bağlama hatası: ${e.message}`));
    }
    try {
      if (typeof reresolveWorkspaceRootAfterAccountBind === 'function') {
        reresolveWorkspaceRootAfterAccountBind();
      }
    } catch (e) {
      logLine(`workspace: yeniden çözme hatası: ${e.message}`);
    }
  }

  initSyncAndSkills() {
    const {
      syncRuntime,
      prefsApplySoon,
      prefsProjectNow,
      seedBuiltinSkills,
      syncSkillEngineViews,
      consumeArgvDeepLink,
      drainPendingAuthUrls,
      wireIpc,
      startResourceGovernorSampling,
      logLine,
    } = this.deps;

    initSyncState(syncRuntime, prefsApplySoon, prefsProjectNow, logLine);
    if (typeof seedBuiltinSkills === 'function') seedBuiltinSkills('boot');
    if (typeof syncSkillEngineViews === 'function') syncSkillEngineViews('boot');

    drainAuthAndDeepLinks(consumeArgvDeepLink, drainPendingAuthUrls);

    if (typeof wireIpc === 'function') wireIpc();

    try {
      if (typeof startResourceGovernorSampling === 'function') startResourceGovernorSampling();
    } catch (err) {
      logLine(`resourceGovernor başlatılamadı: ${err.message} — bekçisiz devam`);
    }
  }

  bootSpikeMode() {
    const { createSpikeWindow, app, BrowserWindow, autotest, noteQuit, logLine } = this.deps;
    createSpikeWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createSpikeWindow();
    });
    if (autotest) {
      setTimeout(() => {
        logLine('autotest watchdog timeout — quitting');
        if (typeof noteQuit === 'function') noteQuit('watchdog', 'autotest-timeout');
        app.quit();
      }, 20000);
    }
  }

  startShimsAndAdapters() {
    const { groqShim, providers, adapter, logLine } = this.deps;
    if (groqShim && typeof groqShim.startGroqShim === 'function') {
      groqShim.startGroqShim({ log: logLine }).then(({ port }) => {
        process.env.CREWPANE_GROQ_SHIM_PORT = String(port);
        logLine(`[groq-shim] 127.0.0.1:${port} — Groq istekleri buradan temizlenerek geçecek`);
      }).catch((err) => {
        logLine(`[groq-shim] başlatılamadı (${err.message}) → Groq'a DOĞRUDAN gidilecek`);
      });
    }

    if (providers && adapter && typeof adapter.startAdapter === 'function' && providers.allProviders().some((p) => p.needsShim)) {
      adapter.startAdapter().then(({ port }) => {
        logLine(`[adapter] started on 127.0.0.1:${port}`);
      }).catch((err) => {
        logLine(`[adapter] start failed: ${err.message}`);
      });
    }
  }

  scheduleBackgroundRoutines() {
    const {
      registerJarvisShortcut,
      scheduleHandControlWarmup,
      stopHandControl,
      scheduleUpdateChecks,
      startHeartbeat,
      scheduleAnnounceChecks,
      scheduleChangelogChecks,
      scheduleAutoMemoryIndex,
      startupSweepService,
      memoryIndexerSingleton,
      searchIndexSingleton,
      jarvisVoice,
      notifyScreenshotsMovedOnce,
      runDoctorNow,
      doctorService,
      app,
      logLine,
    } = this.deps;

    if (typeof registerJarvisShortcut === 'function') registerJarvisShortcut();
    if (typeof scheduleHandControlWarmup === 'function') scheduleHandControlWarmup();

    if (app && typeof app.on === 'function') {
      app.on('before-quit', () => {
        try { if (typeof stopHandControl === 'function') stopHandControl('uygulama kapanıyor'); } catch { /* best effort */ }
        try { memoryIndexerSingleton?.shutdown(); } catch { /* best effort */ }
        try { searchIndexSingleton?.stop(); } catch { /* best effort */ }
        try { jarvisVoice?.killLocalAudioChildren(); } catch { /* best effort */ }
      });
    }

    if (typeof scheduleUpdateChecks === 'function') scheduleUpdateChecks();
    if (typeof startHeartbeat === 'function') startHeartbeat();
    if (typeof scheduleAnnounceChecks === 'function') scheduleAnnounceChecks();
    if (typeof scheduleChangelogChecks === 'function') scheduleChangelogChecks();
    if (typeof scheduleAutoMemoryIndex === 'function') scheduleAutoMemoryIndex();
    if (startupSweepService && typeof startupSweepService.sweepOrphanSayProcesses === 'function') {
      startupSweepService.sweepOrphanSayProcesses();
    }
    if (typeof notifyScreenshotsMovedOnce === 'function') notifyScreenshotsMovedOnce();

    if (typeof runDoctorNow === 'function') {
      runDoctorNow()
        .then((report) => logLine(doctorService.formatDoctorLog(report)))
        .catch((e) => logLine(`[doctor] çalıştırılamadı: ${e && e.message}`));
    }
  }

  initTelemetryAndTamper() {
    const {
      telemetryMod,
      app,
      agentSettings,
      telemetryProvisioning,
      obsReporterNow,
      telemetryChannelMod,
      analyticsNow,
      analyticsFirstTime,
      tamperSignals,
      faultInject,
      supervisorFor,
      logLine,
    } = this.deps;

    initSentryAndPosthog({
      telemetryMod,
      app,
      agentSettings,
      telemetryProvisioning,
      obsReporterNow,
      telemetryChannelMod,
      analyticsNow,
      analyticsFirstTime,
      logLine,
    });

    checkTamperState(tamperSignals, analyticsNow, obsReporterNow, logLine);

    if (app && typeof app.on === 'function') {
      app.on('before-quit', () => {
        try { analyticsNow().flush('quit'); } catch { /* ignore */ }
      });
    }

    injectSyntheticFault(faultInject, supervisorFor, logLine);
  }

  async bootRendererServer() {
    const {
      externalUrl,
      mode,
      createAppWindow,
      startBridge,
      startMobile,
      startNextServer,
      logLine,
      noteQuit,
      app,
      BrowserWindow,
      getAppWindow,
    } = this.deps;

    try {
      if (externalUrl) {
        logLine(`attaching to external server: ${externalUrl}`);
        createAppWindow(externalUrl);
        await startBridge();
        await startMobile();
        app.on('activate', () => {
          if (BrowserWindow.getAllWindows().length === 0) createAppWindow(externalUrl);
        });
        return;
      }
      const url = await startNextServer(mode);
      createAppWindow(url);
      await startBridge();
      await startMobile();
      app.on('activate', () => {
        const win = typeof getAppWindow === 'function' ? getAppWindow() : null;
        if (!win || win.isDestroyed()) createAppWindow(url);
      });
    } catch (err) {
      logLine('FATAL: ' + err.message);
      if (typeof noteQuit === 'function') noteQuit('fatal', err.message);
      app.quit();
    }
  }

  async boot() {
    this.setupEarlyObservers();
    this.runStartupHygiene();
    await this.initSecurityAndAccount();
    this.initSyncAndSkills();

    if (this.deps.mode === 'spike') {
      this.bootSpikeMode();
      return;
    }

    this.startShimsAndAdapters();
    this.scheduleBackgroundRoutines();
    this.initTelemetryAndTamper();
    await this.bootRendererServer();
  }
}

function createAppBootService(deps) {
  return new AppBootService(deps);
}

module.exports = {
  AppBootService,
  createAppBootService,
};
