'use strict';

const path = require('path');
const pty = require('node-pty');
const instancePaths = require('../../config/instancePaths.cjs');
const engineInstall = require('../../agents/engineInstall.cjs');
const spawnPromptFile = require('../../agents/spawnPromptFile.cjs');
const agentRunner = require('../../agents/agentRunner.js');
const providerKeysEnvFile = require('../../config/providerKeysEnvFile.cjs');
const engineProfiles = require('../../agents/engineProfiles.cjs');
const engineAuth = require('../../agents/engineAuth.cjs');
const secretRedactor = require('../../security/secretRedactor.cjs');
const paneCapabilityMatrix = require('../../terminal/paneCapabilityMatrix.cjs');
const modelDetect = require('../../agents/modelDetect.cjs');
const providers = require('../../agents/providers.cjs');
const engineBilling = require('../../agents/engineBilling.cjs');
const opencodeModelGate = require('../../agents/opencodeModelGate.cjs');
const engineRegistry = require('../../agents/engineRegistry.cjs');
const winShellPrereq = require('../../../platform/winShellPrereq.cjs');
const crewpaneEnv = require('../../config/crewpaneEnv.cjs');
const cmdLineLimit = require('../../../platform/cmdLineLimit.cjs');
const ptyResizeGate = require('../../terminal/ptyResizeGate.cjs');
const paneExitClassifier = require('../../../telemetry/paneExit.cjs');
const paneEarlyExit = require('../../terminal/paneEarlyExit.cjs');
const paneScreen = require('../../terminal/paneScreen.cjs');
const livePaneRegistry = require('../../agents/livePaneRegistry.cjs');
const workspaceOnboarding = require('../../agents/workspaceOnboarding.cjs');
const jevRouter = require('../../agents/jevRouter.cjs');

const PANE_BUFFER_MAX = 256 * 1024;
const PANE_BUFFER_SLACK = 64 * 1024;
const PANE_LIVE_THROTTLE_MS = 500;

const defaultDeps = {
  ptys: new Map(),
  getAppWindow: () => null,
  crewpaneHome: () => instancePaths.crewpaneHome(),
  logLine: () => {},
  getWorkspaceRoot: () => null,
  readSettings: () => ({}),
  appI18n: { t: (k) => k, getLocale: () => 'en' },
  planDenial: () => null,
  dedupeSpawnForAgent: () => null,
  resolveTaskWorktreeSync: () => null,
  liveIsolationFiles: () => [],
  integrationResolverOrNull: () => null,
  codeIndexResolverOrNull: () => null,
  getDelegationBridge: () => null,
  publicSupabaseEnv: () => ({}),
  engineKeyStore: () => null,
  reportModuleFault: () => {},
  settleMemoryUsage: () => {},
  scheduleSupervisorSweep: () => {},
  sendPaneEvent: () => {},
  sessionAnchor: { forget: () => {} },
  dispatchStore: { clear: () => {} },
  dispatchApplied: new Set(),
  leaderRefreshState: new Map(),
  invalidateGitBranchCache: () => {},
  isQuitting: () => false,
  isAutotest: () => false,
  isRestoreDisabled: () => false,
  hasMobileSubscribers: () => false,
  emitMobileEvent: () => {},
  getPaneAskRuntime: () => null,
};

function paneOwnerWindow(entry, fallbackWin, appWin) {
  if (entry && entry.win && !entry.win.isDestroyed()) return entry.win;
  if (appWin && !appWin.isDestroyed()) return appWin;
  return fallbackWin && !fallbackWin.isDestroyed() ? fallbackWin : null;
}

function restoreSeedText(opts) {
  const dim = (s) => `\x1b[2m${s}\x1b[0m`;
  const tail = Array.isArray(opts.screenTail)
    ? opts.screenTail.filter((s) => typeof s === 'string')
    : [];
  const out = [];
  if (tail.length) {
    out.push(dim(`── önceki oturum — son ${tail.length} satır ──`));
    out.push(...tail);
    out.push('');
  }
  out.push(dim('── oturum devam ettiriliyor (restore) — ajan çıktısı bekleniyor… ──'));
  return out.join('\r\n') + '\r\n';
}

function checkSpawnLimit(opts, ptysSize, planDenial, logLine) {
  const spawnIntent = opts.spawnIntent === 'restore' || opts.spawnIntent === 'replace'
    ? opts.spawnIntent
    : 'new';
  if (spawnIntent !== 'restore') return null;

  const restoreGate = planDenial('agents', ptysSize, { notify: false });
  if (!restoreGate) return null;

  const agent = (opts && opts.agentId) || '-';
  logLine(
    `restore: plan tavanı — pane AÇILMADI agent=${agent} `
      + `(katman=${restoreGate.tier} tavan=${restoreGate.limit} canlı=${ptysSize}; kayıt defterde duruyor)`,
  );
  return { planLimited: true, paneId: null, agentId: opts.agentId || null, department: opts.department || null, denial: restoreGate };
}

function buildPromptFileSink(opts, home, logLine) {
  if (!opts || opts.command !== 'claude') return null;
  try {
    const probeEnv = { ...process.env, PATH: agentRunner.augmentedPath(process.env.PATH) };
    const bin = engineInstall.resolveBinary('claude', probeEnv);
    return spawnPromptFile.createSink({
      engine: 'claude',
      bin,
      env: probeEnv,
      home,
      log: logLine,
    });
  } catch (e) {
    logLine(`spawn kimliği dosya sink'i kurulamadı (${(e && e.message) || e}) → satır-içi bayrak`);
    return null;
  }
}

function applyEngineApiKeyEnv(plan, apiKeyStore, logLine) {
  if (!plan.isAgent) return;
  try {
    const envEntries = Object.entries(engineAuth.apiKeyEnvFor(plan.key, { apiKeyStore, env: process.env }));
    for (const [k, v] of envEntries) {
      if (!plan.env[k]) plan.env[k] = v;
    }
  } catch (e) {
    logLine(`engine api-key env skipped: ${engineAuth.maskSecrets(String(e && e.message))}`);
  }
}

function applyOfficeSupabaseEnv(plan, publicSupabaseEnv, logLine) {
  if (!plan.isAgent) return;
  const sb = publicSupabaseEnv();
  for (const [k, v] of Object.entries(sb)) {
    if (plan.env[k] && plan.env[k] !== v) {
      logLine(`[backend] pane env EZİLDİ (${k}): miras=${k.endsWith('URL') ? plan.env[k] : '<gizli>'} → main kararı`);
    }
    plan.env[k] = v;
  }
}

function resolveModelLabel(plan, readSettings, logLine, paneId) {
  const launchModel = plan.isAgent ? plan.model || null : null;
  const launchEffort = plan.isAgent ? plan.effort || null : null;
  const modelLabel = modelDetect.withEffortSuffix(
    modelDetect.paneModelLabel(
      { isAgent: plan.isAgent, launchModel, provider: plan.provider },
      {
        providerModelLabel: (p, m) =>
          providers.providerModelLabel(p, m, readSettings().customProvider || null),
        resolveK1: () => modelDetect.resolveSpawnModel({ engine: plan.key, env: plan.env, cwd: plan.cwd }),
      },
    ),
    launchEffort,
  );
  if (launchModel) logLine(`model launched (--model) paneId=${paneId} engine=${plan.key} model=${launchModel} label=${modelLabel}`);
  if (launchEffort) logLine(`effort launched paneId=${paneId} engine=${plan.key} effort=${launchEffort}`);
  else if (modelLabel) logLine(`model resolved (K1) paneId=${paneId} engine=${plan.key} label=${modelLabel}`);
  return { launchModel, launchEffort, modelLabel };
}

function formatModelGateLog(modelGate, paneId, plan) {
  if (!modelGate || modelGate.reason === 'no-model' || modelGate.reason === 'not-gated') return '';
  const parts = [`model gate paneId=${paneId} engine=${plan.key} model=${plan.model || '-'} sonuç=${modelGate.reason}`];
  if (modelGate.detail) parts.push(`(${modelGate.detail})`);
  if (modelGate.url) parts.push(`adres=${modelGate.url}`);
  if (modelGate.probe) parts.push(`probe=${modelGate.probe}`);
  if (modelGate.blocked) parts.push('→ motor başlatılmadı, rehber pane\'i açılıyor');
  return parts.join(' ');
}

function evaluateModelGate(plan, trustedExtra, resolvedBin, settings, appI18n, logLine, paneId) {
  let modelGate = { blocked: false, reason: 'skipped', banner: null };
  const pre = trustedExtra && trustedExtra.modelGate;
  if (pre && pre.model === plan.model && pre.cwd === plan.cwd) {
    modelGate = pre;
  } else {
    try {
      modelGate = opencodeModelGate.verdictSync({
        descriptor: engineRegistry.getEngine(plan.key),
        model: plan.model,
        bin: resolvedBin,
        env: plan.env,
        cwd: plan.cwd,
        settings,
        t: appI18n.t,
        locale: appI18n.getLocale(),
        label: (engineInstall.installInfo(plan.key) || {}).label || plan.key,
      });
    } catch (e) {
      modelGate = { blocked: false, reason: 'unmeasured', detail: `throw: ${e && e.message}`, banner: null };
    }
  }
  const line = formatModelGateLog(modelGate, paneId, plan);
  if (line) logLine(line);
  return modelGate;
}

function evaluateShellPrereq(plan, appI18n, logLine, paneId, agentId) {
  let shellVerdict = { blocked: false, reason: 'skipped' };
  try {
    shellVerdict = winShellPrereq.shellPrereqVerdict({
      engineId: plan.key,
      env: plan.env,
      platform: process.platform,
      enabled: crewpaneEnv.readEnv(winShellPrereq.PRECHECK_ENV_BASE) !== '0',
      descriptor: engineRegistry.getEngine(plan.key),
    });
  } catch (e) {
    logLine(`win shell precheck failed-open paneId=${paneId} engine=${plan.key}: ${e && e.message}`);
  }
  if (!shellVerdict.blocked) {
    if (process.platform === 'win32') {
      logLine(`win shell precheck paneId=${paneId} engine=${plan.key} sonuç=${shellVerdict.reason}`);
    }
    return null;
  }
  const label = (engineInstall.installInfo(plan.key) || {}).label || plan.key;
  logLine(
    `win SHELL MISSING paneId=${paneId} engine=${plan.key} agentId=${agentId ?? '-'} `
      + `sebep=${shellVerdict.reason} → kabuk rehberi pane'i açılıyor (motor başlatılmadı)`,
  );
  return {
    engine: plan.key,
    label,
    reason: shellVerdict.reason,
    docsUrl: shellVerdict.docsUrl,
    holderArgv: engineInstall.guidanceHolderArgv(
      winShellPrereq.missingShellBanner(shellVerdict, { t: appI18n.t, locale: appI18n.getLocale(), label }),
    ),
  };
}

function evaluateVendorGate(plan, settings) {
  try {
    return engineBilling.vendorGateVerdict(plan.key, { settings, env: plan.env });
  } catch {
    return { blocked: false, policy: null, reason: 'ayar okunamadı → kapı açık', banner: null };
  }
}

function evaluateSpawnGates(plan, trustedExtra, workspaceRoot, settings, appI18n, logLine, paneId, agentId) {
  const workspaceMissing = plan.isAgent && !workspaceRoot;
  const resolvedBin = plan.isAgent && !workspaceMissing ? engineInstall.resolveBinary(plan.file, plan.env) : null;
  const engineMissing = plan.isAgent && !workspaceMissing && !resolvedBin ? plan.key : null;
  const installGuide = engineMissing ? engineInstall.installInfo(engineMissing) : null;

  if (!plan.isAgent || workspaceMissing || engineMissing) {
    return {
      workspaceMissing,
      engineMissing,
      vendorGate: { blocked: false, policy: null, reason: null, banner: null },
      modelGate: { blocked: false, reason: 'skipped', banner: null },
      shellMissing: null,
      resolvedBin,
      installGuide,
    };
  }

  const vendorGate = evaluateVendorGate(plan, settings);
  const modelGate = vendorGate.blocked ? { blocked: false, reason: 'skipped', banner: null }
    : evaluateModelGate(plan, trustedExtra, resolvedBin, settings, appI18n, logLine, paneId);
  const shellMissing = (vendorGate.blocked || modelGate.blocked) ? null
    : evaluateShellPrereq(plan, appI18n, logLine, paneId, agentId);

  return { workspaceMissing, engineMissing, vendorGate, modelGate, shellMissing, resolvedBin, installGuide };
}

function resolveGuidanceHolder(gates, plan, logLine, paneId, agentId) {
  if (gates.workspaceMissing) {
    logLine(`workspace MISSING paneId=${paneId} command=${plan.key} agentId=${agentId ?? '-'} → çalışma alanı rehberi pane'i açılıyor (motor başlatılmadı)`);
    return engineInstall.guidanceHolderArgv(
      workspaceOnboarding.missingWorkspaceBanner({ defaultDir: workspaceOnboarding.defaultWorkspaceDir() }),
    );
  }
  if (gates.engineMissing) {
    logLine(`engine MISSING paneId=${paneId} engine=${gates.engineMissing} file=${plan.file} agentId=${agentId ?? '-'} → kurulum rehberi pane'i açılıyor (motor başlatılmadı)`);
    return engineInstall.guidanceHolderArgv(engineInstall.missingEngineBanner(gates.engineMissing));
  }
  if (gates.vendorGate && gates.vendorGate.blocked) {
    logLine(`vendor-hosted BLOCKED paneId=${paneId} engine=${plan.key} agentId=${agentId ?? '-'} politika=${gates.vendorGate.policy} sebep=${gates.vendorGate.reason} → rehber pane'i açılıyor (motor başlatılmadı)`);
    return engineInstall.guidanceHolderArgv(gates.vendorGate.banner);
  }
  if (gates.modelGate && gates.modelGate.blocked) {
    return engineInstall.guidanceHolderArgv(gates.modelGate.banner);
  }
  if (gates.shellMissing && gates.shellMissing.holderArgv) {
    return gates.shellMissing.holderArgv;
  }
  return null;
}

function checkCommandLineLimit(spawnFile, spawnArgv, plan, logLine, paneId, agentId) {
  const cmdVerdict = cmdLineLimit.commandLineVerdict({
    file: spawnFile,
    argv: spawnArgv,
    platform: process.platform,
    env: plan.env,
  });
  if (cmdVerdict.fits) {
    return { spawnFile, spawnArgv };
  }
  logLine(`KOMUT SATIRI ÇOK UZUN paneId=${paneId} engine=${plan.key} agentId=${agentId ?? '-'} uzunluk=${cmdVerdict.length} sınır=${cmdVerdict.limit} (${cmdVerdict.limitName}) taşma=${cmdVerdict.overBy} dal=${cmdVerdict.kind} → motor başlatılmadı, rehber pane'i açılıyor`);
  const holder = engineInstall.guidanceHolderArgv(cmdLineLimit.tooLongBanner(cmdVerdict, engineInstall.installInfo(plan.key) || {}));
  return { spawnFile: holder.file, spawnArgv: holder.argv };
}

function resolveExecutionTarget(plan, gates, logLine, paneId, agentId) {
  const holder = resolveGuidanceHolder(gates, plan, logLine, paneId, agentId);
  if (holder) {
    return checkCommandLineLimit(holder.file, holder.argv, plan, logLine, paneId, agentId);
  }

  let spawnFile = plan.file;
  let spawnArgv = plan.argv;
  if (!gates.engineMissing && !gates.workspaceMissing && gates.resolvedBin && process.platform === 'win32') {
    const target = engineInstall.execArgs(gates.resolvedBin, plan.argv);
    spawnFile = target.file;
    spawnArgv = target.commandLine || target.argv;
  }

  return checkCommandLineLimit(spawnFile, spawnArgv, plan, logLine, paneId, agentId);
}

function handleDataChunk(entry, data, paneId, logLine, paneAskRuntime) {
  entry.lastDataAt = Date.now();
  if (entry.agentId && paneAskRuntime) paneAskRuntime.noteData(paneId);

  if (!entry.firstDataAt) {
    entry.firstDataAt = entry.lastDataAt;
    const pendingResize = ptyResizeGate.takePendingResize(entry);
    if (pendingResize) {
      try {
        entry.child.resize(pendingResize.cols, pendingResize.rows);
        if (entry.screen) entry.screen.resize(pendingResize.cols, pendingResize.rows);
        logLine(`pty resize (deferred→applied) paneId=${paneId} cols=${pendingResize.cols} rows=${pendingResize.rows}`);
      } catch (err) {
        logLine(`pty resize skipped (dead pane, deferred) paneId=${paneId}: ${err.message}`);
      }
    }
  }

  entry.bytes += data.length;
  let nextBuffer = entry.buffer + data;
  if (nextBuffer.length > PANE_BUFFER_MAX + PANE_BUFFER_SLACK) {
    nextBuffer = nextBuffer.slice(-PANE_BUFFER_MAX);
  }
  entry.buffer = secretRedactor.redactTail(nextBuffer, data.length);

  if (entry.modelSniffer) {
    const detected = entry.modelSniffer.push(data);
    const withEffort = modelDetect.withEffortSuffix(detected, entry.launchEffort);
    if (withEffort && withEffort !== entry.modelLabel) {
      entry.modelLabel = withEffort;
      logLine(`model detected (K2) paneId=${paneId} label=${withEffort}`);
    }
  }
}

function wireChildDataListener(child, paneId, agentId, win, deps, dataState) {
  child.onData((rawData) => {
    const data = secretRedactor.redact(rawData);
    if (deps.isAutotest() && dataState.bytes === 0) deps.logLine(`pty first data paneId=${paneId} (${data.length} bytes)`);
    dataState.bytes += data.length;

    const entry = deps.ptys.get(paneId);
    let seq = dataState.bytes;
    if (entry) {
      handleDataChunk(entry, data, paneId, deps.logLine, deps.getPaneAskRuntime());
      seq = entry.bytes;
    }

    const targetWin = paneOwnerWindow(entry, win, deps.getAppWindow());
    deps.sendPaneEvent(targetWin, paneId, 'pty:data', { paneId, agentId, data, seq });
    if (entry && entry.screen) entry.screen.write(data);
  });
}

function cleanupPaneOnExit(entry, paneId, agentId, deps) {
  if (entry && !entry.preserve) {
    try { livePaneRegistry.removePane(paneId, deps.crewpaneHome()); } catch { /* best-effort */ }
  }
  if (entry && entry.screen) {
    try { entry.screen.dispose(); } catch { /* best-effort */ }
  }
  deps.sessionAnchor.forget(paneId);
  try {
    agentRunner.cleanupIntegrationsMcpConfig(deps.crewpaneHome(), (entry && entry.integrationsKeyOpts) || { agentId, paneId });
  } catch { /* best-effort */ }
  try {
    agentRunner.cleanupAgyWorkspacePlugin(deps.crewpaneHome(), (entry && entry.integrationsKeyOpts) || { agentId, paneId });
  } catch { /* best-effort */ }
  deps.dispatchStore.clear(paneId);
  deps.dispatchApplied.delete(paneId);
  deps.leaderRefreshState.delete(paneId);
  deps.ptys.delete(paneId);
}

function classifyAndReportExit(exitCode, signal, paneId, plan, dataBytes, deps) {
  let early = { early: false, reason: 'unclassified', msSinceSpawn: -1, firstDataBytes: 0 };
  const exiting = deps.ptys.get(paneId);
  try {
    early = paneEarlyExit.classifyEarlyExit({
      exitCode,
      signal,
      quitting: deps.isQuitting(),
      preserve: exiting && exiting.preserve,
      msSinceSpawn: exiting && exiting.startedAt ? Date.now() - exiting.startedAt : NaN,
      bytes: exiting ? exiting.bytes : dataBytes,
    });
    if (early.early) {
      deps.logLine(
        `pty EARLY EXIT paneId=${paneId} engine=${(exiting && exiting.command) || plan.key} code=${exitCode} `
          + `msSinceSpawn=${early.msSinceSpawn} firstDataBytes=${early.firstDataBytes} (${early.reason}) → hücre korunur`,
      );
    }
  } catch { /* best-effort */ }

  try {
    const verdict = paneExitClassifier.classifyPaneExit({
      exitCode,
      signal,
      quitting: deps.isQuitting(),
      preserve: exiting && exiting.preserve,
      engine: exiting && exiting.command,
      plannedEngine: plan && plan.key,
    });
    if (verdict.report) {
      deps.reportModuleFault({
        module: 'worker',
        label: 'pane-exit',
        message: verdict.message,
        location: null,
        stopped: false,
        level: verdict.level,
        at: Date.now(),
        engine: verdict.engine,
        msSinceSpawn: early.msSinceSpawn,
        firstDataBytes: early.firstDataBytes,
      });
    }
  } catch { /* best-effort */ }
  return early;
}

function triggerDeadSessionFallback(entry, paneId, exitCode, win, spawnPtyFn, deps) {
  if (
    entry && entry.resumeOpts && !entry.preserve
    && agentRunner.isDeadSessionExit({ buffer: entry.buffer, exitCode, uptimeMs: Date.now() - entry.startedAt })
  ) {
    deps.logLine(`restore: dead session detected paneId=${paneId} agent=${entry.agentId ?? '-'} (session=${entry.sessionId ?? '-'}) → fresh spawn fallback`);
    try {
      const targetWin = paneOwnerWindow(null, win, deps.getAppWindow());
      const res = spawnPtyFn(targetWin, {
        ...entry.resumeOpts,
        resume: false,
        sessionId: undefined,
        spawnIntent: 'replace',
      });
      deps.logLine(`restore: fresh fallback spawned paneId=${res.paneId} agent=${entry.agentId ?? '-'}`);
    } catch (e) {
      deps.logLine(`restore: fresh fallback failed agent=${entry.agentId ?? '-'}: ${e.message}`);
    }
  }
}

function wireChildExitListener(child, paneId, agentId, win, plan, dataState, deps, spawnPtyFn) {
  child.onExit(({ exitCode, signal }) => {
    deps.logLine(`pty exit paneId=${paneId} code=${exitCode} signal=${signal ?? '-'}`);
    const askRuntime = deps.getPaneAskRuntime();
    if (askRuntime) {
      try { askRuntime.noteExit(paneId); } catch { /* best-effort */ }
    }

    const early = classifyAndReportExit(exitCode, signal, paneId, plan, dataState.bytes, deps);
    deps.settleMemoryUsage({ paneId });
    deps.scheduleSupervisorSweep();

    const exiting = deps.ptys.get(paneId);
    const targetWin = paneOwnerWindow(exiting, win, deps.getAppWindow());
    deps.sendPaneEvent(targetWin, paneId, 'pty:exit', {
      paneId,
      agentId,
      code: exitCode,
      earlyExit: early.early === true,
      msSinceSpawn: early.msSinceSpawn,
      firstDataBytes: early.firstDataBytes,
    });

    cleanupPaneOnExit(exiting, paneId, agentId, deps);
    triggerDeadSessionFallback(exiting, paneId, exitCode, win, spawnPtyFn, deps);
  });
}

function createPaneScreenInstance(paneId, agentId, cols, rows, deps) {
  return paneScreen.createPaneScreen({
    paneId,
    cols,
    rows,
    onFault: deps.reportModuleFault,
    log: deps.logLine,
    wantsLive: () => deps.hasMobileSubscribers(),
    onLine: (lineEntry) => {
      if (!deps.hasMobileSubscribers()) return;
      deps.emitMobileEvent({ type: 'pane-line', paneId, agentId, seq: lineEntry.seq, text: lineEntry.text, at: Date.now() });
    },
    onLive: (text) => {
      if (!deps.hasMobileSubscribers()) return;
      const now = Date.now();
      const e = deps.ptys.get(paneId);
      if (e) {
        if (now - (e.lastLiveAt || 0) < PANE_LIVE_THROTTLE_MS) return;
        e.lastLiveAt = now;
      }
      deps.emitMobileEvent({ type: 'pane-live', paneId, agentId, text, at: now });
    },
  });
}

function buildLivePaneRecord(paneId, plan, opts, capabilities, gates) {
  return {
    agentId: opts.agentId || null,
    department: opts.department || null,
    restoreKey: typeof opts.restoreKey === 'string' && opts.restoreKey ? opts.restoreKey : null,
    cwd: plan.cwd,
    engine: plan.key,
    sessionId: (gates.engineMissing || gates.workspaceMissing) ? null : plan.sessionId,
    model: plan.model || null,
    provider: plan.provider || null,
    label: opts.label || null,
    role: opts.role || null,
    plain: opts.plain === true,
    browserCapable: opts.browserCapable === true,
    disallowSubagent: opts.disallowSubagent === true,
    systemPrompt: typeof opts.systemPrompt === 'string' ? opts.systemPrompt : null,
    taskId: plan.taskId || null,
    branch: plan.taskBranch || null,
    worktreePath: plan.taskWorktree || null,
    capabilities,
  };
}

function resolvePaneSessionId(gates, plan) {
  if (gates.engineMissing || gates.workspaceMissing || gates.vendorGate.blocked || gates.modelGate.blocked) {
    return null;
  }
  if (gates.shellMissing && gates.shellMissing.blocked) {
    return null;
  }
  return plan.sessionId || null;
}

function resolveModelGateEntry(modelGate, engineKey) {
  if (!modelGate || !modelGate.blocked) return null;
  return {
    reason: modelGate.reason,
    model: modelGate.model,
    url: modelGate.url || null,
    engine: engineKey,
  };
}

function logSpawnProfile(plan, home, paneId, logLine) {
  if (!plan.isAgent) return;
  const paneProfile = plan.engineProfileId || engineProfiles.activeProfileId(home, plan.key);
  if (paneProfile && paneProfile !== engineProfiles.DEFAULT_PROFILE_ID) {
    logLine(`engine account: paneId=${paneId} engine=${plan.key} profile=${paneProfile}`);
  }
}

function buildIsolationNotice(plan, agentId, paneId, t, logLine) {
  if (!plan.isolation || !plan.isolation.separated) return '';
  logLine(`pane izolasyonu İKİZ paneId=${paneId} engine=${plan.key} agentId=${agentId ?? '-'} → ayrı depo (${path.basename(path.dirname(plan.isolation.file))}); canlı ikizi ${plan.isolation.twinOf}`);
  return `\x1b[2m${t('main.pane.isolationTwin.line')}\x1b[0m\r\n`;
}

function ensureEngineTrust(plan, paneId, logLine) {
  if (!plan.trust || !plan.trust.pending) return;
  const trusted = agentRunner.ensureEngineTrusted(plan.key, plan.cwd, plan.env);
  logLine(`${plan.key} trust ensured paneId=${paneId} cwd=${plan.cwd} ok=${trusted}`);
}

function buildReturnPayload(paneId, child, plan, gates, modelInfo) {
  return {
    paneId,
    pid: child.pid,
    command: plan.key,
    shell: plan.file,
    agentId: plan.agentId || null,
    department: plan.department || null,
    cwd: plan.cwd,
    model: modelInfo.launchModel,
    engineMissing: gates.engineMissing,
    engineInstall: gates.installGuide,
    workspaceMissing: gates.workspaceMissing,
    defaultWorkspaceDir: gates.workspaceMissing ? workspaceOnboarding.defaultWorkspaceDir() : null,
    shellMissing: gates.shellMissing,
    modelGate: resolveModelGateEntry(gates.modelGate, plan.key),
  };
}

function resolvePaneBuffer(opts, isolationNotice) {
  const seed = opts.resume === true ? restoreSeedText(opts) : '';
  return seed + isolationNotice;
}

function resolvePaneRole(opts) {
  if (typeof opts.role === 'string' && opts.role.trim()) {
    return opts.role.trim();
  }
  return null;
}

function resolveMcpConfigCount(argv) {
  if (!Array.isArray(argv)) return 0;
  return argv.filter((a) => a === '--mcp-config').length;
}

function buildTaskTrackingProps(plan) {
  return {
    taskId: plan.taskId || null,
    branch: plan.taskBranch || null,
    worktreePath: plan.taskWorktree || null,
    integrations: plan.integrations || null,
    fixedLoad: plan.fixedLoad || null,
    isolationFile: (plan.isolation && plan.isolation.file) || null,
  };
}

function buildModelTrackingProps(plan, modelInfo) {
  return {
    modelLabel: modelInfo.modelLabel,
    modelSniffer: plan.isAgent ? modelDetect.createModelSniffer(plan.key) : null,
    launchModel: modelInfo.launchModel,
    launchEffort: modelInfo.launchEffort,
    launchProvider: plan.provider || null,
    engineProfileId: plan.engineProfileId || null,
  };
}

function applyJevRouting(opts, settings, deps) {
  if (!opts || opts.model !== 'auto') return opts;
  const jevCfg = (settings && settings.jev) || { mode: 'suggest', policy: 'balanced' };
  if (jevCfg.mode === 'off') return opts;

  let decision = null;
  try {
    const task = {
      title: opts.title || opts.label || opts.agentId || 'Terminal Task',
      description: opts.prompt || opts.taskDescription || '',
    };
    decision = jevRouter.decide({
      task,
      engines: [{ id: opts.commandKey || 'claude', installed: true, loggedIn: true }],
      policy: jevCfg.policy,
    });
  } catch (_e) {
    return opts;
  }

  if (!decision || decision.skip) return opts;

  if (jevCfg.mode === 'auto') {
    if (decision.model) opts.model = decision.model;
    if (decision.effort && !opts.effort) opts.effort = decision.effort;
    deps.logLine(`[jev] auto-routed: model=${decision.model} effort=${decision.effort} reason=${decision.reason && decision.reason.code}`);
  } else if (jevCfg.mode === 'suggest') {
    try {
      const appWin = deps.getAppWindow && deps.getAppWindow();
      if (appWin && !appWin.isDestroyed()) {
        appWin.webContents.send('jev:decision-log', {
          type: 'suggestion',
          agentId: opts.agentId,
          decision,
        });
      }
    } catch {
      /* UI bildirimi akışı düşüremez */
    }
  }
  return opts;
}

class PtySpawnService {
  constructor(deps = {}) {
    this.deps = Object.assign({}, defaultDeps, deps);
    this.paneSeq = 0;
  }

  buildSpawnPlan(opts, trustedExtra, promptFileSink) {
    const images = opts.images || null;
    const bridge = this.deps.getDelegationBridge();
    const settings = this.deps.readSettings();
    return agentRunner.buildSpawn(
      { ...opts, images },
      process.env,
      this.deps.getWorkspaceRoot(),
      {
        ...(bridge ? { bridge: bridge.info() } : {}),
        departmentDirs: settings.departmentDirs,
        providerKeys: providerKeysEnvFile.mergeProviderKeys(settings.apiKeys).keys,
        customProvider: settings.customProvider || null,
        integrations: this.deps.integrationResolverOrNull(),
        codeIndex: this.deps.codeIndexResolverOrNull(),
        engineProfiles: engineProfiles.createResolver(this.deps.crewpaneHome()),
        liveIsolationFiles: this.deps.liveIsolationFiles(),
        log: this.deps.logLine,
        ...(trustedExtra && trustedExtra.taskWorktree ? trustedExtra : this.deps.resolveTaskWorktreeSync(opts) || {}),
        ...(promptFileSink ? { promptFile: promptFileSink } : {}),
      },
    );
  }

  recordLivePane(paneId, plan, opts, capabilities, gates) {
    if (!plan.isAgent || this.deps.isRestoreDisabled()) return;
    try {
      const record = buildLivePaneRecord(paneId, plan, opts, capabilities, gates);
      livePaneRegistry.recordPane(paneId, record, this.deps.crewpaneHome());
    } catch (e) {
      this.deps.logLine(`live-pane record failed paneId=${paneId}: ${e.message}`);
    }
  }

  buildPaneEntry(paneId, child, win, plan, opts, gates, modelInfo, capabilities, isolationNotice) {
    const cols = opts.cols || 80;
    const rows = opts.rows || 24;
    const agentId = opts.agentId || null;
    return {
      child,
      win,
      agentId,
      integrationsKeyOpts: { agentId, paneId: opts.paneId || null, leaderId: opts.leaderId || null },
      department: opts.department || null,
      command: plan.key,
      label: opts.label || null,
      cwd: plan.cwd,
      pid: child.pid,
      ...buildTaskTrackingProps(plan),
      mcpConfigCount: resolveMcpConfigCount(plan.argv),
      sessionId: resolvePaneSessionId(gates, plan),
      role: resolvePaneRole(opts),
      disallowSubagent: opts.disallowSubagent === true,
      ...buildModelTrackingProps(plan, modelInfo),
      capabilities,
      engineMissing: gates.engineMissing,
      engineInstallGuide: gates.installGuide,
      workspaceMissing: gates.workspaceMissing,
      resumeOpts: opts.resume === true ? { ...opts } : null,
      startedAt: Date.now(),
      lastDataAt: 0,
      firstDataAt: 0,
      pendingResize: null,
      shellMissing: gates.shellMissing,
      modelGate: resolveModelGateEntry(gates.modelGate, plan.key),
      taskCount: 0,
      lastResetAt: 0,
      buffer: resolvePaneBuffer(opts, isolationNotice),
      bytes: 0,
      screen: createPaneScreenInstance(paneId, agentId, cols, rows, this.deps),
      lastLiveAt: 0,
    };
  }

  spawnPty(win, opts = {}, trustedExtra = null) {
    const dedupe = this.deps.dedupeSpawnForAgent(opts, 'spawnPty');
    if (dedupe) return dedupe;

    const limitVerdict = checkSpawnLimit(opts, this.deps.ptys.size, this.deps.planDenial, this.deps.logLine);
    if (limitVerdict) return limitVerdict;

    const settings = this.deps.readSettings();
    const routedOpts = applyJevRouting({ ...opts }, settings, this.deps);

    const promptFileSink = buildPromptFileSink(routedOpts, this.deps.crewpaneHome(), this.deps.logLine);
    const plan = this.buildSpawnPlan(routedOpts, trustedExtra, promptFileSink);
    applyEngineApiKeyEnv(plan, this.deps.engineKeyStore(), this.deps.logLine);
    const redactor = this.deps.secretRedactor || secretRedactor;
    const maskedNew = redactor && typeof redactor.registerEnv === 'function' ? redactor.registerEnv(plan.env) : 0;
    if (maskedNew) this.deps.logLine(`integrations: ${maskedNew} anahtar maskeleme kapsamına alındı`);

    const paneId = `pane-${++this.paneSeq}`;
    const agentId = opts.agentId || null;
    const department = opts.department || null;
    logSpawnProfile(plan, this.deps.crewpaneHome(), paneId, this.deps.logLine);
    const isolationNotice = buildIsolationNotice(plan, agentId, paneId, this.deps.appI18n.t, this.deps.logLine);
    ensureEngineTrust(plan, paneId, this.deps.logLine);

    const paneCapabilities = plan.capabilities ? { ...plan.capabilities, matrix: paneCapabilityMatrix.buildMatrix(plan.capabilities.engine) } : null;
    applyOfficeSupabaseEnv(plan, this.deps.publicSupabaseEnv, this.deps.logLine);
    const modelInfo = resolveModelLabel(plan, this.deps.readSettings, this.deps.logLine, paneId);

    const gates = evaluateSpawnGates(plan, trustedExtra, this.deps.getWorkspaceRoot(), this.deps.readSettings(), this.deps.appI18n, this.deps.logLine, paneId, agentId);
    const { spawnFile, spawnArgv } = resolveExecutionTarget(plan, gates, this.deps.logLine, paneId, agentId);

    const cols = opts.cols || 80;
    const rows = opts.rows || 24;
    const child = pty.spawn(spawnFile, spawnArgv, { name: 'xterm-color', cols, rows, cwd: plan.cwd, env: plan.env });
    this.deps.logLine(`pty spawned paneId=${paneId} pid=${child.pid} command=${plan.key} agentId=${agentId ?? '-'} dept=${department ?? '-'} file=${spawnFile} cwd=${plan.cwd} cols=${cols} rows=${rows} sessionId=${plan.sessionId ?? '-'}`);

    const dataState = { bytes: 0 };
    wireChildDataListener(child, paneId, agentId, win, this.deps, dataState);
    wireChildExitListener(child, paneId, agentId, win, plan, dataState, this.deps, (w, o, t) => this.spawnPty(w, o, t));

    this.deps.invalidateGitBranchCache(plan.cwd);
    const entry = this.buildPaneEntry(paneId, child, win, plan, opts, gates, modelInfo, paneCapabilities, isolationNotice);
    this.deps.ptys.set(paneId, entry);
    this.recordLivePane(paneId, plan, opts, paneCapabilities, gates);

    const result = buildReturnPayload(paneId, child, plan, gates, modelInfo);
    result.shell = spawnFile;
    result.agentId = agentId;
    result.department = department;
    return result;
  }
}

function createPtySpawnService(deps) {
  return new PtySpawnService(deps);
}

module.exports = {
  createPtySpawnService,
  PtySpawnService,
};
