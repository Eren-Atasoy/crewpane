'use strict';

/**
 * Worktree IPC Handlers (Faz 3.5 — Sıra 3)
 * Channels: worktree:list, worktree:review, worktree:merge, worktree:release, worktree:reap
 */
function registerWorktreeIpc({
  ipcMain,
  ptys,
  worktreeStore,
  crewpaneHome,
  projectRepos,
  agentWorkspaceRoot,
  agentSettings,
  mergeService,
  worktreeService,
  invalidateGitBranchCache = () => {},
  logLine = () => {},
}) {
  /** Bir görevin projesini + repo yolunu çöz (iki uçta da aynı türetme). */
  const worktreeRepoFor = (taskId) => {
    const rec = worktreeStore.getWorktree(taskId, crewpaneHome());
    if (!rec || !rec.project) return null;
    const repo = projectRepos.resolveProjectRepo(rec.project, agentWorkspaceRoot, {
      settings: agentSettings.readSettings(),
      store: worktreeStore,
      homedir: crewpaneHome(),
      log: logLine,
    });
    return repo ? { rec, repoPath: repo.repoPath } : null;
  };

  ipcMain.handle('worktree:list', () => {
    const panesByTask = new Map();
    for (const [paneId, e] of ptys) if (e && e.taskId) panesByTask.set(e.taskId, paneId);
    return {
      ok: true,
      worktrees: worktreeStore.listWorktrees(crewpaneHome()).map((r) => ({ ...r, livePaneId: panesByTask.get(r.taskId) || null })),
    };
  });

  ipcMain.handle('worktree:review', async (_e, input) => {
    const taskId = typeof input?.taskId === 'string' ? input.taskId.trim() : '';
    if (!taskId) return { ok: false, why: 'taskId gerekli' };
    const r = worktreeRepoFor(taskId);
    if (!r) return { ok: false, why: 'bu görev için izole ağaç kaydı yok (bu cihazda izolasyon kurulmamış — H-10)' };
    const proj = worktreeStore.getProject(r.rec.project, crewpaneHome()) || {};
    return mergeService.review(taskId, {
      homedir: crewpaneHome(),
      repoPath: r.repoPath,
      target: proj.defaultBranch || 'dev',
      setting: input?.setting,
      autopilot: input?.autopilot === true,
      gate: input?.gate || null,
    });
  });

  ipcMain.handle('worktree:merge', async (_e, input) => {
    const taskId = typeof input?.taskId === 'string' ? input.taskId.trim() : '';
    if (!taskId) return { ok: false, why: 'taskId gerekli' };
    const r = worktreeRepoFor(taskId);
    if (!r) return { ok: false, why: 'bu görev için izole ağaç kaydı yok' };
    const proj = worktreeStore.getProject(r.rec.project, crewpaneHome()) || {};
    const res = await mergeService.merge(taskId, {
      homedir: crewpaneHome(),
      repoPath: r.repoPath,
      target: proj.defaultBranch || 'dev',
      title: typeof input?.title === 'string' ? input.title : null,
      setting: input?.setting,
      autopilot: input?.autopilot === true,
      gate: input?.gate || null,
      approvedBy: input?.approvedBy === true ? 'boss' : (typeof input?.approvedBy === 'string' ? input.approvedBy : null),
    });
    if (res.ok) logLine(`merge OK task=${taskId} ${res.branch} → ${res.target} @${res.mergedCommit}`);
    else logLine(`merge REDDEDİLDİ task=${taskId}: ${res.why}`);
    if (res.ok) invalidateGitBranchCache();
    return res;
  });

  ipcMain.handle('worktree:release', async (_e, input) => {
    const taskId = typeof input?.taskId === 'string' ? input.taskId.trim() : '';
    if (!taskId) return { ok: false, why: 'taskId gerekli' };
    const r = worktreeRepoFor(taskId);
    if (!r) return { ok: false, why: 'kayıt yok' };
    const released = await worktreeService.release(taskId, {
      homedir: crewpaneHome(),
      workspaceRoot: agentWorkspaceRoot,
      repoPath: r.repoPath,
      force: input?.force === true,
    });
    if (released && released.ok) invalidateGitBranchCache(r.rec && r.rec.path);
    return released;
  });

  ipcMain.handle('worktree:reap', async () => {
    const first = worktreeStore.listWorktrees(crewpaneHome())[0];
    const repo = first ? worktreeRepoFor(first.taskId) : null;
    return worktreeService.reap({
      homedir: crewpaneHome(),
      workspaceRoot: agentWorkspaceRoot,
      repoPath: repo ? repo.repoPath : null,
      paneLive: (paneId) => ptys.has(paneId),
    });
  });
}

module.exports = { registerWorktreeIpc };
