'use strict';

/**
 * Git & Workspace File Exploration IPC Handlers (Faz 3.5 — Sıra 11)
 * Channels:
 *   - git:diff
 *   - git:branch
 *   - workspace:listFiles
 *   - workspace:grep
 */
function registerGitIpc({
  ipcMain,
  resolveInRoots,
  getAgentWorkspaceRoot = () => '',
  codeIntel,
  gitBranchCache = new Map(),
  GIT_BRANCH_TTL_MS = 2000,
  readGitBranch,
  resolveSearchRoot,
  withinActiveRoots = () => true,
  displayPath = (p) => p,
}) {
  ipcMain.handle('git:diff', (_event, filePath) => {
    const abs = resolveInRoots(filePath);
    if (!abs) return { ok: false, reason: 'path-denied' };
    return codeIntel.gitDiffFile(getAgentWorkspaceRoot(), abs);
  });

  ipcMain.handle('git:branch', (_event, cwd, opts) => {
    const abs = resolveInRoots(cwd);
    if (!abs) return { ok: false, reason: 'path-denied' };
    const force = opts && opts.force === true;
    const hit = gitBranchCache.get(abs);
    if (!force && hit && Date.now() - hit.at < GIT_BRANCH_TTL_MS) return hit.value;
    const value = { ok: true, branch: readGitBranch(abs) };
    gitBranchCache.set(abs, { at: Date.now(), value });
    return value;
  });

  ipcMain.handle('workspace:listFiles', async (_event, root) => {
    const base = resolveSearchRoot(root);
    if (!base) return { ok: false, reason: 'workspace_not_configured' };
    const r = await codeIntel.listWorkspaceFiles(base);
    if (!r.ok) return r;
    return { ...r, files: r.files.filter(withinActiveRoots).map(displayPath) };
  });

  ipcMain.handle('workspace:grep', async (_event, payload) => {
    const { query, root } = payload && typeof payload === 'object' ? payload : { query: payload, root: undefined };
    const base = resolveSearchRoot(root);
    if (!base) return { ok: false, reason: 'workspace_not_configured' };
    const r = await codeIntel.grepWorkspace(base, query);
    if (!r.ok) return r;
    const hits = r.hits.filter((h) => withinActiveRoots(h.file)).map((h) => ({ ...h, file: displayPath(h.file) }));
    return { ...r, hits };
  });
}

module.exports = { registerGitIpc };
