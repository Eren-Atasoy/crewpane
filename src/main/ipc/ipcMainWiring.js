'use strict';

const { assembleIpcDeps } = require('./ipcDepsBuilder');
const { wireIpc: wireAppIpc } = require('./wire');

// Static modules previously required at top of main.js solely for IPC delegation
const defaultStaticModules = {
  engineLeadership: require('../../agents/engineLeadership.cjs'),
  enginePlanned: require('../../agents/enginePlanned.cjs'),
  analyticsSchema: require('../../../telemetry/analyticsSchema.cjs'),
  provisionStoreMod: require('../../../telemetry/provisionStore.cjs'),
  agentxBeamMod: require('../../agents/agentxBeam.cjs'),
  inputSim: require('../../services/inputSim.cjs'),
  screenCaptureMod: require('../../services/screenCapture.cjs'),
  evidencePathMod: require('../../services/evidencePath.cjs'),
  resultRootMod: require('../../services/resultRoot.cjs'),
  ptyResizeGate: require('../../terminal/ptyResizeGate.cjs'),
  engineProfiles: require('../../agents/engineProfiles.cjs'),
  engineSwitch: require('../../agents/engineSwitch.cjs'),
  limitDetect: require('../../terminal/limitDetect.cjs'),
  engineLoginLedger: require('../../agents/engineLoginLedger.cjs'),
  engineCatalog: require('../../agents/engineCatalog.cjs'),
  presetAdvisor: require('../../agents/presetAdvisor.cjs'),
  handOverlayContract: require('../../hand/handOverlayContract.cjs'),
  sprintStore: require('../../agents/sprintStore.cjs'),
  tmuxWindows: require('../../terminal/tmuxWindows.cjs'),
  agentEngineMirror: require('../../agents/agentEngineMirror.cjs'),
  integrationAutostart: require('../../mcp/integrationAutostart.cjs'),
  mobileProbe: require('../../mobile/mobileProbe.cjs'),
  grokVoice: require('../../voice/grokVoice.cjs'),
  agentxDraft: require('../../agents/agentxDraft.cjs'),
  skillCenter: require('../../agents/skillCenter.cjs'),
  skillApprove: require('../../agents/skillApprove.cjs'),
  skillAuthor: require('../../agents/skillAuthor.cjs'),
  skillVersions: require('../../agents/skillVersions.cjs'),
  skillShare: require('../../agents/skillShare.cjs'),
  skillGuard: require('../../agents/skillGuard.cjs'),
  skillEngineView: require('../../agents/skillEngineView.cjs'),
  delegationSupervisorStore: require('../../agents/delegationSupervisorStore.cjs'),
  resumeQueueStore: require('../../terminal/resumeQueue.cjs'),
  queueBoard: require('../../agents/queueBoard.cjs'),
  supervisorFingerprint: require('../../features/agents').supervisorFingerprint,
  gateOverrides: require('../../config/crewpaneId.cjs').gateOverrides,
  browserTrustMod: require('../../security/browserTrust.cjs'),
  planCatalog: require('../../config/planCatalog.cjs'),
  codeIntel: require('../../services/codeIntel.cjs'),
  branchName: require('../../config/branchName.cjs'),
  codeIndexHealth: require('../../services/codeIndexHealth.cjs'),
  clipboardImageRoute: require('../../services/clipboardImageRoute.cjs'),
  localSprites: require('../../agents/localSprites.cjs'),
  memoryGraph: require('../../memory/memoryGraph.cjs'),
  memoryEmbedder: require('../../memory/memoryEmbedder.cjs'),
  memoryEmbedInstall: require('../../memory/memoryEmbedInstall.cjs'),
  memoryRecall: require('../../memory/memoryRecall.cjs'),
  memoryTaskBlock: require('../../memory/memoryTaskBlock.cjs'),
  paneContextScope: require('../../terminal/paneContextScope.cjs'),
  engineMemoryScope: require('../../agents/engineMemoryScope.cjs'),
  clipboardHistoryCore: require('../../services/clipboardHistory.cjs'),
  spendGuard: require('../../security/spendGuard.cjs'),
  tokenUsage: require('../../services/tokenUsage.cjs'),
  tokenCost: require('../../services/tokenCost.cjs'),
  leaderComposer: require('../../agents/leaderComposer.cjs'),
  transcriptProbe: require('../../services/transcriptProbe.cjs'),
  leaderRefreshPolicy: require('../../agents/leaderRefreshPolicy.cjs'),
  teamScope: require('../../agents/teamScope.cjs'),
  livePaneRegistry: require('../../agents/livePaneRegistry.cjs'),
  capabilityRegistry: require('../../agents/capabilityRegistry.cjs'),
  codeIndexStore: require('../../services/codeIndex.cjs'),
  projectRepos: require('../../config/projectRepos.cjs'),
  worktreeStore: require('../../services/worktreeStore.cjs'),
  workspaceOnboarding: require('../../agents/workspaceOnboarding.cjs'),
  builtinSkills: require('../../agents/builtinSkills.cjs'),
  skillEngineSync: require('../../agents/skillEngineSync.cjs'),
  accountScope: require('../../config/accountScope.cjs'),
  mobileDeviceStore: require('../../mobile/mobileDeviceStore.cjs'),
  mobileTranscript: require('../../mobile/mobileTranscript.cjs'),
  mergeService: require('../../services/mergeService.cjs'),
  worktreeService: require('../../services/worktreeService.cjs'),
  mcpProcess: require('../../mcp/mcpProcess.cjs'),
  updateChannel: require('../../services/updateChannel.cjs'),
  firstRunDoctor: require('../../agents/firstRunDoctor.cjs'),
  announcements: require('../../services/announcements.cjs'),
  demoSitePath: require('../../config/demoSitePath.cjs'),
  engineCheck: require('../../agents/engineCheck.cjs'),
  teamComposeCore: require('../../agents/teamCompose.cjs'),
  schemeOwnership: require('../../core/schemeOwnership.cjs'),
};

/**
 * Main Process IPC Wiring Orchestrator (Phase 3.6.59)
 * Merges static domain modules with runtime services and dispatches to IPC router.
 */
function createMainIpcWiring(deps = {}) {
  const mergedContext = Object.assign({}, defaultStaticModules, deps);

  function wireIpc() {
    const assembled = assembleIpcDeps(mergedContext);
    wireAppIpc(assembled);
    return assembled;
  }

  return {
    wireIpc,
    mergedContext,
  };
}

module.exports = {
  createMainIpcWiring,
  defaultStaticModules,
};
