'use strict';

const {
  registerGitIpc,
  registerTaskIpc,
  registerCodeIntelIpc,
  registerWorktreeIpc,
  registerWorkspaceIpc,
  registerIntegIpc,
  registerSprintIpc,
  registerBrowserIpc,
} = require('../../features/services');
const { registerPopoutIpc } = require('../../features/popout');
const { registerDesignIpc } = require('../../features/design');
const { registerSpritesIpc } = require('../../features/sprites');
const { registerOfficeIpc } = require('../../features/office');
const { registerResourceIpc } = require('../../features/resource');
const { registerUpdateIpc } = require('../../features/update');
const { registerMediaIpc, registerSystemIpc } = require('../../features/system');

/**
 * Wires Services, Workspace, Files, Git, Worktree, and Window IPC handlers.
 * (Faz 3.6.4 — Wire IPC Modularization)
 */
function wireServicesIpc(deps) {
  const {
    ipcMain,
    app,
    shell,
    clipboard,
    nativeImage,
    dialog,
    appI18n,
    BrowserWindow,
    ptys,
    agentSettings,
    crewpaneHome,
    logLine,
    resolveInRoots,
    withinActiveRoots,
    displayPath,
    getAgentWorkspaceRoot,
    supervisorFor,
  } = deps;

  // Clipboard history lifecycle
  let clipHistory = deps.clipHistory;
  if (!clipHistory && deps.clipboardHistoryCore) {
    clipHistory = deps.clipboardHistoryCore.createClipboardHistory({
      clipboard,
      onChange: () => deps.broadcastClipChanged && deps.broadcastClipChanged(),
      log: (line) => logLine(line),
    });
    const clipTimer = setInterval(() => {
      try {
        clipHistory.tick();
      } catch (err) {
        logLine(`[clip] tick hatası: ${err && err.message}`);
      }
    }, 700);
    app.once('before-quit', () => clearInterval(clipTimer));
  }

  // Image store sweep lifecycle
  if (deps.imageStore) {
    try {
      const swept = deps.imageStore.sweepOrphans();
      if (swept) logLine(`[win-img-01] ${swept} yetim geçici görsel klasörü temizlendi`);
    } catch (err) {
      logLine(`[win-img-01] yetim süpürme hatası: ${err && err.message}`);
    }
    app.once('before-quit', () => {
      try {
        deps.imageStore.dispose();
      } catch {
        /* çıkışı geciktirme */
      }
    });
  }

  // System IPC (clip, file, feedback, announce)
  registerSystemIpc({
    ipcMain,
    shell,
    clipboard,
    nativeImage,
    feedbackBridge: deps.feedbackBridge,
    readFeedbackSeen: deps.readFeedbackSeen,
    writeFeedbackSeen: deps.writeFeedbackSeen,
    readWorkspaceFile: deps.readWorkspaceFile,
    writeWorkspaceFile: deps.writeWorkspaceFile,
    listWorkspaceDir: deps.listWorkspaceDir,
    openFolderDialog: deps.openFolderDialog,
    allowPaneRoot: deps.allowPaneRoot,
    readEditorState: deps.readEditorState,
    writeEditorState: deps.writeEditorState,
    clipHistory,
    ptys,
    clipboardImageRoute: deps.clipboardImageRoute,
    saveTempImage: deps.saveTempImage,
    announcements: deps.announcements,
    agentSettings,
    announceStateForRenderer: deps.announceStateForRenderer,
    runAnnounceCheck: deps.runAnnounceCheck,
    pushAnnounceState: deps.pushAnnounceState,
    announceHiddenThisSession: deps.announceHiddenThisSession,
    getAnnounceState: deps.getAnnounceState,
    logLine,
  });

  // Popout & Design Windows IPC
  registerPopoutIpc({
    ipcMain,
    openPopoutWindow: deps.openPopoutWindow,
    closePopoutWindow: deps.closePopoutWindow,
    listPopoutPanes: deps.listPopoutPanes,
    popoutWindowFor: deps.popoutWindowFor,
    logLine,
  });

  registerDesignIpc({
    ipcMain,
    openDesignWindow: deps.openDesignWindow,
    closeDesignWindow: deps.closeDesignWindow,
    designWindowAlive: deps.designWindowAlive,
    listPanes: deps.listPanes,
    resolveInRoots,
    withinActiveRoots,
    displayPath,
    logLine,
  });

  registerSpritesIpc({
    ipcMain,
    localSprites: deps.localSprites,
    pkgMgr: deps.pkgMgr || require('../../agents/avatarPackageManager.cjs'),
    logLine,
  });

  registerOfficeIpc({
    ipcMain,
    officePkg: deps.officePkg || require('../../agents/officePackageManager.cjs'),
    readOfficeState: deps.readOfficeState,
    writeOfficeState: deps.writeOfficeState,
    keepPanesAliveOnWindowClose: deps.keepPanesAliveOnWindowClose,
    crashWatchdog: deps.crashWatchdog,
    getAppWindow: deps.getAppWindow,
    getAppBaseUrl: deps.getAppBaseUrl,
    ptys,
    createAppWindow: deps.createAppWindow,
    logLine,
  });

  registerResourceIpc({
    ipcMain,
    resourceGovernor: deps.resourceGovernor,
    agentSettings,
    ptys,
    agentRunner: deps.agentRunner,
    resourceGovernorModule: deps.resourceGovernorModule,
    killPaneExplicitAndCleanup: deps.killPaneExplicitAndCleanup,
    logLine,
  });

  registerUpdateIpc({
    ipcMain,
    updateStateForRenderer: deps.updateStateForRenderer,
    runUpdateCheck: deps.runUpdateCheck,
    updateLicenseGateNow: deps.updateLicenseGateNow,
    getAutoUpdaterRef: deps.getAutoUpdaterRef,
    getUpdateState: deps.getUpdateState,
    setUpdateState: deps.setUpdateState,
    pushUpdateState: deps.pushUpdateState,
    updateCheck: deps.updateCheck,
    shell,
    noteQuit: deps.noteQuit,
    agentSettings,
    logLine,
  });

  registerWorktreeIpc({
    ipcMain,
    ptys,
    worktreeStore: deps.worktreeStore,
    crewpaneHome,
    projectRepos: deps.projectRepos,
    agentWorkspaceRoot: deps.agentWorkspaceRoot,
    agentSettings,
    mergeService: deps.mergeService,
    worktreeService: deps.worktreeService,
    invalidateGitBranchCache: deps.invalidateGitBranchCache,
    logLine,
  });

  registerBrowserIpc({
    ipcMain,
    runBrowserAction: deps.runBrowserAction,
    browserGate: deps.browserGate,
    browserGuests: deps.browserGuests,
    isOwnedGuest: deps.isOwnedGuest,
    guestOwners: deps.guestOwners,
    setAppWindowGuest: deps.setAppWindowGuest,
    getAppWindowGuest: deps.getAppWindowGuest,
    agentGuests: deps.agentGuests,
    lastUnownedGuest: deps.lastUnownedGuest,
    logLine,
  });

  registerIntegIpc({
    ipcMain,
    supervisorFor,
    integrations: deps.integrations,
    planDenial: deps.planDenial,
    ptys,
    mcpProcess: deps.mcpProcess,
    crewpaneHome,
    integrationAutostart: deps.integrationAutostart,
    telemetryProvisioning: deps.telemetryProvisioning,
    logLine,
  });

  registerSprintIpc({
    ipcMain,
    sprintStore: deps.sprintStore,
    supervisorFor,
    resultRootMod: deps.resultRootMod,
    agentWorkspaceRoot: deps.agentWorkspaceRoot,
    agentSettings,
    worktreeStore: deps.worktreeStore,
    crewpaneHome,
    activeWorktreePaths: deps.activeWorktreePaths,
    ptys,
    evidencePathMod: deps.evidencePathMod,
    REPO_ROOT: deps.REPO_ROOT,
    logLine,
  });

  registerGitIpc({
    ipcMain,
    resolveInRoots,
    getAgentWorkspaceRoot,
    codeIntel: deps.codeIntel,
    gitBranchCache: deps.gitBranchCache,
    GIT_BRANCH_TTL_MS: deps.GIT_BRANCH_TTL_MS,
    readGitBranch: deps.readGitBranch,
    resolveSearchRoot: deps.resolveSearchRoot,
    withinActiveRoots,
    displayPath,
  });

  registerTaskIpc({
    ipcMain,
  });

  registerCodeIntelIpc({
    ipcMain,
    agentSettings,
    worktreeStore: deps.worktreeStore,
    crewpaneHome,
    projectRepos: deps.projectRepos,
    getAgentWorkspaceRoot,
    branchName: deps.branchName,
    codeIndexStore: deps.codeIndexStore,
    codeIndexHealth: deps.codeIndexHealth,
    codeIndexRepoPath: deps.codeIndexRepoPath,
    codeIndexFreshness: deps.codeIndexFreshness,
    codeIndexJobs: deps.codeIndexJobs,
    getAppWindow: deps.getAppWindow,
    spawn: deps.spawn,
    logLine,
  });

  registerWorkspaceIpc({
    ipcMain,
    app,
    BrowserWindow,
    dialog,
    appI18n,
    supervisorFor,
    notifyGate: deps.notifyGate,
    workspacePlanDenial: deps.workspacePlanDenial,
    workspaceOnboarding: deps.workspaceOnboarding,
    rememberWorkspaceRoot: deps.rememberWorkspaceRoot,
    switchWorkspaceRoot: deps.switchWorkspaceRoot,
    logLine,
  });

  registerMediaIpc({
    ipcMain,
    saveTempImage: deps.saveTempImage,
    imageStore: deps.imageStore,
    ingestTaskAttachment: deps.ingestTaskAttachment,
    attachmentStore: deps.attachmentStore,
    clipboard,
    ptys,
    clipboardImageRoute: deps.clipboardImageRoute,
    logLine,
  });
}

module.exports = {
  wireServicesIpc,
};
