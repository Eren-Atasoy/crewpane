'use strict';

const crypto = require('node:crypto');

/**
 * Settings, Presets, Onboarding & Factory Reset IPC Handlers (Faz 3.5 — Sıra 11)
 * Channels:
 *   - onboarding:load
 *   - onboarding:save
 *   - onboarding:tips:load
 *   - onboarding:tips:save
 *   - reset:plan
 *   - reset:request
 *   - settings:get
 *   - settings:set
 *   - presets:recommend
 */
function registerSettingsIpc({
  ipcMain,
  onboardingStore,
  resetContext,
  installReset,
  runningPaneSummary = () => [],
  resetGate,
  appI18n,
  signOutConfirmCopy = () => ({}),
  getSeatGate = () => null,
  closePanesForSignOut = () => 0,
  accountScope,
  sendResetTelemetry = () => {},
  relaunchForAccountChange = () => {},
  agentSettings,
  getAgentWorkspaceRoot = () => null,
  repoRoot,
  workspaceOnboarding,
  app,
  leaderRefreshPolicy,
  handOverlayContract,
  updateChannel,
  currentUpdateChannel = () => 'auto',
  aiProvidersPayload,
  engineModelCatalogPayload,
  appApiKeysPayload,
  jarvisVoice,
  grokVoice,
  engineCatalog,
  teamScope,
  browserTrustMod,
  logLine = () => {},
  broadcastLocale = () => null,
  getSyncRuntime = () => null,
  prefsProjectNow = () => {},
  applyHandOverlaySettings = () => {},
  presetAdvisor,
  agentRunner,
}) {
  // Main DUMB IO'dur: iki HAM kaydı okur, birleşmiş kaydı iki yüzeye yazar.
  ipcMain.handle('onboarding:load', () => {
    try {
      return { ok: true, ...onboardingStore.load() };
    } catch {
      return { ok: false, local: null, portable: null };
    }
  });

  ipcMain.handle('onboarding:save', (_event, progress) => {
    try {
      return onboardingStore.save(progress);
    } catch (err) {
      return { ok: false, error: String((err && err.code) || 'internal') };
    }
  });

  // TOUR-02-C — bağlamsal ipuçlarının kaydı
  ipcMain.handle('onboarding:tips:load', () => {
    try {
      return { ok: true, ...onboardingStore.loadTips() };
    } catch {
      return { ok: false, local: null, portable: null };
    }
  });

  ipcMain.handle('onboarding:tips:save', (_event, tips) => {
    try {
      return onboardingStore.saveTips(tips);
    } catch (err) {
      return { ok: false, error: String((err && err.code) || 'internal') };
    }
  });

  // ─── RESET-03 — KURULUMU SIFIRLA ───────────────────────────────────────────
  ipcMain.handle('reset:plan', async (_e, opts) => {
    const level = opts && opts.level === 'session' ? 'session' : 'full';
    try {
      const { deps } = resetContext((m) => logLine(`[reset] ${m}`));
      const plan = await installReset.plan({ ...deps, level });
      const panes = runningPaneSummary();
      return {
        ok: true,
        level: plan.level,
        bytesTotal: plan.bytesTotal,
        targets: plan.targets.map((t) => ({ kind: t.kind, bytes: t.bytes, entries: t.entries })),
        keeps: plan.keeps,
        warnings: plan.warnings,
        confirmWord: resetGate.expectedConfirmWord(appI18n.getLocale()),
        panes,
        ...signOutConfirmCopy(panes),
      };
    } catch (e) {
      logLine(`[reset] plan hatası (${(e && e.code) || 'ERR'})`);
      return { ok: false, reason: (e && e.code) || 'plan_failed' };
    }
  });

  ipcMain.handle('reset:request', async (_e, raw) => {
    const req = resetGate.sanitizeRequest(raw);
    if (!req.ok) {
      logLine(`[reset] istek reddedildi (${req.reason})`);
      return { ok: false, reason: req.reason };
    }
    if (!resetGate.confirmMatches(req.confirmText, appI18n.getLocale())) {
      logLine('[reset] istek reddedildi (confirm_mismatch)');
      return { ok: false, reason: 'confirm_mismatch' };
    }
    const seatGate = getSeatGate();
    if (!seatGate) {
      logLine('[reset] istek reddedildi (not_ready)');
      return { ok: false, reason: 'not_ready' };
    }
    const log = (m) => logLine(`[reset] ${m}`);
    const { deps, instanceHome } = resetContext(log);
    log(`istek KABUL (seviye=${req.level} günlükleriSakla=${req.keepLogs ? 1 : 0})`);

    let closedPanes = 0;
    try {
      closedPanes = closePanesForSignOut();
    } catch (e) {
      log(`pane kapatma hatası: ${e.message}`);
    }

    if (req.level === 'full') {
      try {
        await seatGate.releaseDeviceLease();
      } catch (e) {
        log(`kira bırakılamadı: ${e.message}`);
      }
      try {
        const ownId = accountScope.ensureDeviceId(instanceHome);
        const r = await seatGate.revokeDevice(ownId);
        log(`cihaz kaydı iptali ok=${r && r.ok ? 1 : 0}`);
      } catch (e) {
        log(`cihaz kaydı iptal edilemedi: ${e.message}`);
      }
    }
    try {
      await seatGate.signOut();
    } catch (e) {
      log(`çıkış hatası: ${e.message}`);
    }

    let planned = null;
    try {
      planned = await installReset.plan({ ...deps, level: req.level });
    } catch {
      /* best-effort */
    }
    sendResetTelemetry({ level: req.level, source: 'settings', bytes: planned && planned.bytesTotal });

    try {
      installReset.writeMarker(
        instanceHome,
        {
          level: req.level,
          keepLogs: req.keepLogs,
          nonce: crypto.randomBytes(16).toString('hex'),
        },
        deps
      );
      log('işaretçi yazıldı — silme YENİDEN BAŞLATMADAN SONRA');
    } catch (e) {
      log(`işaretçi YAZILAMADI (${(e && e.code) || 'ERR'}) — sıfırlama İPTAL`);
      return { ok: false, reason: 'locked' };
    }

    try {
      const { session } = require('electron');
      await session.defaultSession.clearStorageData();
      await session.defaultSession.clearCache();
      log('tarayıcı depoları boşaltıldı');
    } catch (e) {
      log(`tarayıcı depoları boşaltılamadı: ${e.message}`);
    }

    relaunchForAccountChange(accountScope.ANON_ACCOUNT_KEY, 'reset');
    return { ok: true, restarting: true, closedPanes, level: req.level };
  });

  ipcMain.handle('settings:get', () => {
    const s = agentSettings.readSettings();
    const agentWorkspaceRoot = typeof getAgentWorkspaceRoot === 'function' ? getAgentWorkspaceRoot() : getAgentWorkspaceRoot;
    return {
      ok: true,
      workspaceRoot: s.workspaceRoot,
      resolvedWorkspaceRoot: agentWorkspaceRoot,
      workspaceRootProblem: (() => {
        const st = agentSettings.configuredWorkspaceRootStatus();
        return st.root ? null : { reason: st.reason, configured: st.configured, code: st.code ?? null };
      })(),
      repoRoot,
      firstRunRequired: workspaceOnboarding.firstRunRequired({ isPackaged: app.isPackaged }),
      defaultWorkspaceDir: workspaceOnboarding.defaultWorkspaceDir(),
      pushToTalkKey: s.pushToTalkKey,
      pushToTalkKeys: agentSettings.PUSH_TO_TALK_KEYS,
      wakeModelPath: s.wakeModelPath,
      keepExitedPanes: s.keepExitedPanes === true,
      engines: s.engines || {},
      autoModelByTaskClass: s.autoModelByTaskClass === true,
      leaderAutoRefresh: leaderRefreshPolicy.normalizeMode(s.leaderAutoRefresh),
      cloudSyncEnabled: s.cloudSyncEnabled === true,
      prefsSyncEnabled: s.prefsSyncEnabled !== false,
      paneZoomShortcut: s.paneZoomShortcut ?? null,
      paneMoveShortcut: s.paneMoveShortcut ?? null,
      terminalFontScale: s.terminalFontScale || 'medium',
      locale: s.locale || 'system',
      localeEffective: appI18n.getLocale(),
      voiceLocale: s.voiceLocale || 'follow-ui',
      voiceLocaleEffective: appI18n.voiceLocale(s),
      handControl: handOverlayContract ? handOverlayContract.sanitizeHandControl(s.handControl) : s.handControl,
      updateAutoCheck: s.updateAutoCheck !== false,
      foreignHookNoticeDismissed: s.foreignHookNoticeDismissed === true,
      productTourDone: s.productTourDone === true,
      onboardingGuideDone: s.onboardingGuideDone === true,
      telemetryEnabled: s.telemetryEnabled !== false,
      updateChannel: updateChannel.normalizeChannel(s.updateChannel) || 'auto',
      updateChannelEffective: currentUpdateChannel(),
      hasOpenAiKey: !!(s.apiKeys && s.apiKeys.openai),
      hasXaiKey: !!(s.apiKeys && s.apiKeys.xai),
      aiProviders: aiProvidersPayload(s),
      engineModels: engineModelCatalogPayload(),
      appApiKeys: appApiKeysPayload(),
      mcpServers: s.mcpServers,
      jarvis: s.jarvis,
      jarvisEndpoint: {
        silenceMs: jarvisVoice.normalizeSilenceMs(s.jarvis && s.jarvis.silenceMs),
        endpointMaxMs: jarvisVoice.normalizeEndpointMaxMs(
          s.jarvis && s.jarvis.endpointMaxMs,
          s.jarvis && s.jarvis.silenceMs
        ),
        sleepAfterMs: jarvisVoice.normalizeSleepAfterMs(s.jarvis && s.jarvis.sleepAfterMs),
        noSpeechMs: jarvisVoice.normalizeNoSpeechMs(s.jarvis && s.jarvis.noSpeechMs),
        silentSleep: !!(s.jarvis && s.jarvis.silentSleep === true),
      },
      voiceMode: grokVoice.resolveVoiceMode(s),
      grok: {
        model: grokVoice.resolveGrokModel(s),
        voice: grokVoice.resolveGrokVoice(s),
        voices: grokVoice.GROK_VOICES,
        models: Object.values(grokVoice.GROK_MODELS),
        cost: grokVoice.grokCostNotice(grokVoice.resolveGrokModel(s)),
        pricingSource: grokVoice.GROK_PRICING_SOURCE,
      },
      tts: jarvisVoice.ttsProviders.ttsConfig(s, { rootDir: repoRoot }),
      engineCost: engineCatalog.engineCostSummary(s, {
        rootDir: repoRoot,
        sttStatus: jarvisVoice.whisperLocal.status({ settings: s }),
      }),
      theme: s.theme,
      notifications: s.notifications,
      browserTrust: s.browserTrust,
      jev: s.jev,
      teamScope: teamScope.sanitizeTeamScope(agentSettings.readSettings().teamScope),
      browserTrustBuiltins: {
        trusted: [...browserTrustMod.BUILTIN_TRUSTED],
        blocked: browserTrustMod.BUILTIN_BLOCKED.map((r) => ({
          host: r.host,
          why: r.why,
          path: r.path ? String(r.path) : null,
        })),
      },
    };
  });

  ipcMain.handle('settings:set', (_event, patch) => {
    const { next, restartRequired, persisted, persistError } = agentSettings.applySettingsPatch(patch);
    if (persisted === false) logLine(`settings:set DİSKE YAZILAMADI (${persistError}) — patch: ${Object.keys(patch || {}).join(',')}`);
    const localeState = patch && 'locale' in patch ? broadcastLocale() : null;
    if (patch && 'cloudSyncEnabled' in patch) {
      try {
        const syncRuntime = getSyncRuntime();
        if (syncRuntime) syncRuntime.refresh({ tickNow: next.cloudSyncEnabled === true });
      } catch (e) {
        logLine(`[sync] tercih uygulanamadı: ${e.message}`);
      }
    }
    prefsProjectNow('settings:set');
    if (patch && 'handControl' in patch) {
      try {
        applyHandOverlaySettings();
      } catch (e) {
        logLine(`hand overlay: tercih uygulanamadı: ${e.message}`);
      }
    }
    return {
      ok: true,
      workspaceRoot: next.workspaceRoot,
      locale: next.locale,
      localeEffective: localeState ? localeState.locale : appI18n.getLocale(),
      voiceLocale: next.voiceLocale,
      voiceLocaleEffective: appI18n.voiceLocale(next),
      pushToTalkKey: next.pushToTalkKey,
      wakeModelPath: next.wakeModelPath,
      hasOpenAiKey: !!(next.apiKeys && next.apiKeys.openai),
      hasXaiKey: !!(next.apiKeys && next.apiKeys.xai),
      aiProviders: aiProvidersPayload(next),
      engineModels: engineModelCatalogPayload(),
      appApiKeys: appApiKeysPayload(),
      restartRequired,
      persisted,
      persistError,
    };
  });

  ipcMain.handle('presets:recommend', async (_event, payload) => {
    const req = payload || {};
    return presetAdvisor.recommendWithClaude({
      text: req.text,
      presets: Array.isArray(req.presets) ? req.presets : [],
      locale: req.locale === 'en' ? 'en' : 'tr',
      claudeBin: process.env.CREWPANE_PRESET_ADVISOR_BIN || engineCatalog.BRAIN_CLI,
      env: { ...process.env, PATH: agentRunner.augmentedPath(process.env.PATH) },
    });
  });
}

module.exports = { registerSettingsIpc };
