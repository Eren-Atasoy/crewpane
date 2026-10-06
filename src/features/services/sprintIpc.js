'use strict';

/**
 * Sprint Persistence & Evidence IPC Handlers (Faz 3.5 — Sıra 3)
 * Channels: sprint:save, sprint:load, sprint:resultRoot, sprint:evidence, sprint:list
 */
function registerSprintIpc({
  ipcMain,
  sprintStore,
  supervisorFor,
  resultRootMod,
  agentWorkspaceRoot,
  agentSettings,
  worktreeStore,
  crewpaneHome,
  activeWorktreePaths,
  ptys,
  evidencePathMod,
  REPO_ROOT,
  logLine = () => {},
}) {
  ipcMain.handle('sprint:save', (_event, run) => {
    try {
      return { ok: true, file: sprintStore.saveSprintRun(run) };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('sprint:load', (_event, id) =>
    supervisorFor('sprint-store').run('load', () => ({ ok: true, run: sprintStore.loadSprintRun(id) }), { ok: false, reason: 'degraded' }));

  ipcMain.handle('sprint:resultRoot', (_event, req) =>
    supervisorFor('delegation-supervisor').run(
      'resultRoot',
      () => {
        const r = req && typeof req === 'object' ? req : {};
        const project = typeof r.project === 'string' ? r.project : '';
        const codes = (Array.isArray(r.codes) ? r.codes : [r.code])
          .filter((c) => typeof c === 'string' && /^[A-Z0-9-]{3,40}$/i.test(c))
          .slice(0, 8);
        const settings = agentSettings.readSettings();
        const resolved = resultRootMod.resolveResultRoot(project, agentWorkspaceRoot, {
          settings,
          store: worktreeStore,
          homedir: crewpaneHome(),
          mapping: settings.departmentDirs,
          log: logLine,
        });
        if (!resolved) return { ok: false, error: 'workspace kökü yok' };
        if (resolved.fallback) {
          logLine(`resultRoot: proje '${project || '-'}' için dizin yok → ${resolved.source} (${resolved.root}); settings.projectRepos ile eşle`);
        }
        return {
          ok: true,
          root: resolved.root,
          source: resolved.source,
          fallback: resolved.fallback,
          existing: [...new Set(codes.flatMap((c) => resultRootMod.existingReportsFor(resolved.root, c)))],
          hasIndexScript: resultRootMod.hasResultsIndexScript(resolved.root),
        };
      },
      { ok: false, error: 'degraded' },
    ));

  ipcMain.handle('sprint:evidence', (_event, req) =>
    supervisorFor('sprint-store').run(
      'evidence',
      () => {
        const r = req && typeof req === 'object' ? req : {};
        const items = Array.isArray(r.items) ? r.items.slice(0, 64) : [];
        const mapping = agentSettings.readSettings().departmentDirs;
        const worktrees = activeWorktreePaths();
        const out = items.map((it) => {
          const taskId = String((it && it.taskId) || '');
          const evidencePath = it && typeof it.evidencePath === 'string' ? it.evidencePath : '';
          if (!taskId || !evidencePath) return { taskId, found: false };
          let cwd = null;
          let paneWt = null;
          if (it.agentId) {
            for (const [, entry] of ptys) {
              if (entry && entry.agentId === it.agentId) {
                cwd = entry.cwd || null;
                paneWt = typeof entry.worktreePath === 'string' ? entry.worktreePath : null;
                break;
              }
            }
          }
          const probe = evidencePathMod.probeEvidence(evidencePath, {
            cwd,
            workspaceRoot: agentWorkspaceRoot,
            department: r.department,
            mapping,
            repoRoot: REPO_ROOT,
            worktreePaths: paneWt ? [paneWt] : worktrees,
            since: Number.isFinite(it.since) ? it.since : 0,
          });
          return {
            taskId,
            found: probe.found,
            path: probe.path || undefined,
            mtimeMs: probe.mtimeMs || 0,
            stale: probe.stale === true,
          };
        });
        return { ok: true, items: out };
      },
      { ok: false, error: 'degraded', items: [] },
    ));

  ipcMain.handle('sprint:list', () =>
    supervisorFor('sprint-store').run('list', () => ({ ok: true, runs: sprintStore.listSprintRuns() }), { ok: false, reason: 'degraded', runs: [] }));
}

module.exports = { registerSprintIpc };
