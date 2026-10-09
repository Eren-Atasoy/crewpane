'use strict';

const path = require('node:path');
const os = require('node:os');
const providers = require('../providers.cjs');
const crewpaneEnv = require('../../config/crewpaneEnv.cjs');
const instancePaths = require('../../config/instancePaths.cjs');
const systemPromptCap = require('../../../platform/systemPromptCap.cjs');
const identityBudget = require('../identityBudget.cjs');
const identitySurfaceTrim = require('../identitySurfaceTrim.cjs');
const paneContextScope = require('../../terminal/paneContextScope.cjs');
const integrationBriefing = require('../../mcp/integrationBriefing.cjs');
const { setPathVar, getPathVar } = require('../../../platform/envPath.cjs');
const { resolveCommand, sanitizeModel, sanitizeArgs, IDLE_AFTER_MS, defaultArgsFor } = require('./commandWhitelist.cjs');
const { sanitizeEnv, resolveCwd } = require('./environment.cjs');
const { planEngineTrust } = require('./trust.cjs');
const { engineCapability, unsupportedCapabilities, getEngineRegistry } = require('./registryBridge.cjs');
const {
  withModel,
  resolveEffort,
  withEffort,
  withProvider,
  withImages,
  terminateImageList,
  isResumeSpawn,
  appendResume,
  withSessionId,
} = require('./modelDecorators.cjs');
const {
  identityFileFlagSink,
  warnIdentityClamp,
  withIdentity,
  applyIdentityEnvFile,
  supportsResumeReinject,
  applyPaneIsolationEnv,
  paneIsolationPlan,
} = require('./identityCarrier.cjs');
const {
  composeSpawnIdentity,
  resumeMemoryPrompt,
  runnableEngineMemorySearchCli,
} = require('./memoryDecorators.cjs');
const {
  ensureKillGuardShims,
  resolveIntegrationCreds,
  integrationsInjectable,
  gateIntegrations,
  readIntegrationsConfigFacts,
  integrationContextFor,
} = require('./integrationsConfig.cjs');
const {
  mcpEnvSnapshot,
  withLeaderDelegation,
  leaderDelegationStatus,
  withSubagentBlock,
  withBrowserCapable,
  withTaskCapable,
  withTurnBriefing,
  withAgyHooks,
  withIntegrations,
  withCodeIndex,
  withLeaderEnv,
  withBrowserEnv,
} = require('./spawnDecorators.cjs');
const { leaderSignal } = require('./leaderDetector.cjs');

/**
 * Turn a validated spawn request into the concrete node-pty arguments.
 * Throws (via resolveCommand) on a disallowed command — callers must let that
 * reject the IPC, never swallow it.
 *
 * @returns {{ key:string, isAgent:boolean, file:string, argv:string[], cwd:string, env:object }}
 */
function buildSpawn(opts = {}, baseEnv, repoRoot, trusted = {}) {
  const { command, args, env, systemPrompt } = opts;
  const resolved = resolveCommand(command);

  const effectiveModel = sanitizeModel(opts.model, resolved.key);
  const effectiveEffort = resolveEffort(resolved.key, opts.effort, effectiveModel);
  let fixedLoadFact = null;
  let leaderDelegationFact = null;

  const customProviderRow = (trusted && trusted.customProvider) || null;
  const effectiveProvider =
    engineCapability(resolved.key, 'provider') && providers.isProvider(opts.provider, customProviderRow)
      ? opts.provider
      : null;

  const cwdResolved = resolveCwd(
    opts,
    repoRoot,
    resolved.isAgent,
    trusted && trusted.departmentDirs,
    trusted && trusted.log,
    resolved.isAgent ? (trusted && trusted.taskWorktree) : undefined,
  );
  const childEnv = sanitizeEnv(env, baseEnv);

  let engineProfileId = null;
  if (resolved.isAgent && trusted && trusted.engineProfiles
      && typeof trusted.engineProfiles.envFor === 'function') {
    try {
      const profileEnv = trusted.engineProfiles.envFor(resolved.key, opts.engineProfileId);
      if (profileEnv && typeof profileEnv === 'object') Object.assign(childEnv, profileEnv);
      if (typeof trusted.engineProfiles.resolveId === 'function') {
        const id = trusted.engineProfiles.resolveId(resolved.key, opts.engineProfileId);
        engineProfileId = typeof id === 'string' && id ? id : null;
      }
    } catch {
      /* defter hatası spawn'ı ASLA engellemez */
    }
  }

  const trustPlan = resolved.isAgent ? planEngineTrust(resolved.key, cwdResolved, childEnv) : null;

  if (effectiveProvider && trusted && trusted.providerKeys) {
    const p = providers.getProvider(effectiveProvider, customProviderRow);
    const keyEnv = providers.providerKeyEnv(
      effectiveProvider,
      trusted.providerKeys[p.settingsKey],
      customProviderRow,
    );
    if (keyEnv) Object.assign(childEnv, keyEnv);
  }

  if (resolved.isAgent && trusted && trusted.bridge && trusted.bridge.port && trusted.bridge.token) {
    crewpaneEnv.dualWrite(childEnv, 'BRIDGE_PORT', String(trusted.bridge.port));
    crewpaneEnv.dualWrite(childEnv, 'BRIDGE_TOKEN', trusted.bridge.token);
    crewpaneEnv.dualWrite(childEnv, 'BRIDGE_HOST', trusted.bridge.host || '127.0.0.1');
  }

  if (resolved.isAgent) {
    crewpaneEnv.dualWrite(childEnv, 'HOST_PID', String((trusted && trusted.hostPid) || process.pid));
    const sib = trusted && Array.isArray(trusted.panePids)
      ? trusted.panePids.map((p) => Number(p)).filter((p) => Number.isInteger(p) && p > 0)
      : [];
    if (sib.length) crewpaneEnv.dualWrite(childEnv, 'PANE_PIDS', sib.join(','));
    const guardBin = crewpaneEnv.readEnv('KILL_GUARD', childEnv) === '0'
      ? null
      : ensureKillGuardShims(instancePaths.crewpaneHome(undefined));
    if (guardBin) setPathVar(childEnv, `${guardBin}${path.delimiter}${getPathVar(childEnv) || ''}`);
  }

  if (resolved.isAgent && typeof childEnv.CREWPANE_MCP_LEGACY_ALIASES !== 'string') {
    childEnv.CREWPANE_MCP_LEGACY_ALIASES = '0';
  }

  let isolationFact = null;
  if (resolved.isAgent) {
    const liveIsolationFiles = trusted && Array.isArray(trusted.liveIsolationFiles) ? trusted.liveIsolationFiles : [];
    applyPaneIsolationEnv(childEnv, resolved.key, opts, undefined, trusted && trusted.log, liveIsolationFiles);
    isolationFact = paneIsolationPlan(childEnv, resolved.key, opts, undefined, liveIsolationFiles);
  }

  let argv;
  let sessionId = null;
  let injectedIntegrations = [];
  let gatedIntegrations = [];
  let lazyFacts = null;
  if (resolved.isAgent) {
    const wantResume = isResumeSpawn(opts, resolved.key);
    argv = sanitizeArgs(args) ?? defaultArgsFor(resolved.key);
    argv = withModel(argv, resolved.key, effectiveModel);
    argv = withEffort(argv, resolved.key, effectiveEffort, effectiveModel);
    argv = withProvider(argv, resolved.key, effectiveProvider, effectiveModel, customProviderRow);
    argv = withImages(argv, resolved.key, opts.images);

    const promptSink =
      (trusted && typeof trusted.promptFile === 'function' ? trusted.promptFile : null) ||
      identityFileFlagSink(resolved.key, opts, undefined, trusted && trusted.log);
    if (!wantResume) {
      let scopePlan = null;
      const composeCap = promptSink ? systemPromptCap.FILE_MAX : systemPromptCap.CLI_MAX;
      const surfaceTrim = identitySurfaceTrim.trimIdentityToSurfaces(systemPrompt, {
        cwd: cwdResolved,
        workspaceRoot: repoRoot,
        env: childEnv,
        log: trusted && trusted.log,
      });
      let composedIdentity = composeSpawnIdentity({
        contextBlock: (budgetChars) => {
          scopePlan = paneContextScope.planContextScope({
            engineId: resolved.key,
            cwd: cwdResolved,
            workspaceRoot: repoRoot,
            env: childEnv,
            homedir: childEnv.HOME || childEnv.USERPROFILE || os.homedir(),
            budgetChars,
            memorySearchCli: runnableEngineMemorySearchCli(),
            query: '',
            log: trusted && trusted.log,
          });
          return scopePlan ? scopePlan.text : '';
        },
        systemPrompt: surfaceTrim.text,
        opts,
        workspaceRoot: repoRoot,
        log: trusted && trusted.log,
        engine: resolved.key,
        cap: identityBudget.carrierCap(resolved.key),
        contextCap: composeCap,
      });
      if (scopePlan) Object.assign(childEnv, scopePlan.env);
      warnIdentityClamp(composedIdentity, resolved.key, promptSink, trusted && trusted.log);
      fixedLoadFact = {
        identityChars: composedIdentity.length,
        contextScoped: !!scopePlan,
        scopeItems: scopePlan ? scopePlan.items : [],
        surfaceTrimmed: surfaceTrim.dropped,
      };
      argv = withIdentity(argv, resolved.key, composedIdentity, promptSink, process.platform, cwdResolved);
      applyIdentityEnvFile(childEnv, resolved.key, composedIdentity, opts, undefined, trusted && trusted.log);
    } else if (supportsResumeReinject(resolved.key)) {
      argv = withIdentity(
        argv,
        resolved.key,
        integrationBriefing.withIntegrationProtocol(resumeMemoryPrompt(opts, repoRoot), { engine: resolved.key }),
        promptSink,
        process.platform,
        cwdResolved,
      );
    }

    const mcpTrusted = { ...(trusted || {}), binFile: (trusted && trusted.binFile) || resolved.file };
    const argvBeforeLeader = argv;
    const envBeforeLeader = mcpEnvSnapshot(resolved.key, childEnv);
    argv = withLeaderDelegation(argv, resolved.key, opts, undefined, childEnv, mcpTrusted);
    leaderDelegationFact = leaderDelegationStatus(
      resolved.key,
      opts,
      argvBeforeLeader,
      argv,
      envBeforeLeader,
      mcpEnvSnapshot(resolved.key, childEnv),
    );

    const blockOpts =
      opts && opts.plain === true && leaderSignal(opts)
        ? { ...opts, disallowSubagent: true }
        : opts;
    argv = withSubagentBlock(argv, resolved.key, blockOpts);
    argv = withBrowserCapable(argv, resolved.key, opts, undefined, childEnv, mcpTrusted);
    argv = withTaskCapable(argv, resolved.key, opts, undefined, childEnv, mcpTrusted);
    argv = withTurnBriefing(argv, resolved.key, opts, undefined);
    argv = withAgyHooks(argv, resolved.key, opts, undefined);

    const integrationCreds = resolveIntegrationCreds(opts, trusted);
    argv = withIntegrations(argv, resolved.key, opts, undefined, childEnv, integrationCreds);

    if (integrationsInjectable(resolved.key)) {
      const gated = gateIntegrations(integrationCreds, opts, undefined);
      injectedIntegrations = gated.kept.map((c) => c.service);
      gatedIntegrations = gated.skipped.map((sv) => ({ service: sv, source: gated.reasons[sv] || 'global' }));
      lazyFacts = readIntegrationsConfigFacts(undefined, opts);
    }

    if (integrationsInjectable(resolved.key) && integrationCreds.length
      && trusted && trusted.integrations && typeof trusted.integrations.markUsed === 'function') {
      try {
        trusted.integrations.markUsed(integrationCreds.map((c) => c.id));
      } catch {
        /* damga spawn'ı asla etkilemez */
      }
    }

    argv = withCodeIndex(argv, resolved.key, opts, undefined, trusted);
    withLeaderEnv(childEnv, resolved.key, opts);
    withBrowserEnv(childEnv, resolved.key, opts);

    if (wantResume) {
      argv = appendResume(argv, resolved.key, opts.sessionId);
      sessionId = opts.sessionId || null;
    } else {
      const withSid = withSessionId(argv, resolved.key, opts, baseEnv);
      argv = withSid.argv;
      sessionId = withSid.sessionId;
    }

    argv = terminateImageList(argv, resolved.key);
  } else {
    argv = [];
  }

  const reg = getEngineRegistry();

  return {
    key: resolved.key,
    isAgent: resolved.isAgent,
    file: resolved.file,
    argv,
    cwd: cwdResolved,
    env: childEnv,
    sessionId,
    model: resolved.isAgent ? effectiveModel : null,
    effort: resolved.isAgent ? effectiveEffort : null,
    provider: effectiveProvider,
    engineProfileId,
    taskWorktree:
      resolved.isAgent && trusted && typeof trusted.taskWorktree === 'string'
        && cwdResolved === trusted.taskWorktree
        ? trusted.taskWorktree
        : null,
    taskBranch: resolved.isAgent && trusted && typeof trusted.taskBranch === 'string' ? trusted.taskBranch : null,
    taskId: resolved.isAgent && trusted && typeof trusted.taskId === 'string' ? trusted.taskId : null,
    integrations: resolved.isAgent
      ? {
          services: injectedIntegrations,
          projectId: integrationContextFor(opts).projectId,
          env: integrationContextFor(opts).env,
          gated: gatedIntegrations,
          lazy: lazyFacts ? lazyFacts.lazy : false,
        }
      : null,
    capabilities: resolved.isAgent
      ? {
          engine: resolved.key,
          unsupported: unsupportedCapabilities(resolved.key),
          summary: reg && typeof reg.unsupportedSummary === 'function' ? reg.unsupportedSummary(resolved.key) : '',
          ...(leaderDelegationFact ? { leaderDelegation: leaderDelegationFact } : {}),
        }
      : null,
    fixedLoad: fixedLoadFact,
    isolation: isolationFact,
    trust: trustPlan,
  };
}

/**
 * Derive a binding status from last-activity (ADP-014 bridge). `lastDataAt` is
 * 0 before the pane's first byte → "working" (it just started). After that,
 * working while bytes are recent, else idle.
 */
function statusFor(lastDataAt, now) {
  if (!lastDataAt) return 'working';
  return now - lastDataAt < IDLE_AFTER_MS ? 'working' : 'idle';
}

module.exports = {
  buildSpawn,
  statusFor,
};
