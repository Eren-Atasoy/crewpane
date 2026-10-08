'use strict';

/**
 * Project Configuration & Code Index IPC Handlers (Faz 3.5 — Sıra 11)
 * Channels:
 *   - project:config:get
 *   - project:config:set
 *   - codeIndex:list
 *   - codeIndex:set
 *   - codeIndex:index
 */
function registerCodeIntelIpc({
  ipcMain,
  agentSettings,
  worktreeStore,
  crewpaneHome,
  projectRepos,
  getAgentWorkspaceRoot = () => '',
  branchName,
  codeIndexStore,
  codeIndexHealth,
  codeIndexRepoPath,
  codeIndexFreshness,
  codeIndexJobs,
  getAppWindow = () => null,
  spawn,
  logLine = () => {},
}) {
  ipcMain.handle('project:config:get', (_e, input) => {
    const wanted = Array.isArray(input?.slugs)
      ? input.slugs.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().toLowerCase())
      : [];
    const s = agentSettings.readSettings();
    const isoMap = (s && s.projectIsolation && typeof s.projectIsolation === 'object') ? s.projectIsolation : {};
    const repoMap = (s && s.projectRepos && typeof s.projectRepos === 'object') ? s.projectRepos : {};
    let stored = {};
    try { stored = worktreeStore.listProjects(crewpaneHome()) || {}; } catch { stored = {}; }
    const slugs = [...new Set([...wanted, ...Object.keys(isoMap), ...Object.keys(repoMap), ...Object.keys(stored)])];
    const projects = slugs.map((slug) => {
      const rec = (() => { try { return worktreeStore.getProject(slug, crewpaneHome()); } catch { return null; } })();
      const repo = projectRepos.resolveProjectRepo(slug, getAgentWorkspaceRoot(), {
        settings: s, store: worktreeStore, homedir: crewpaneHome(), log: () => {},
      });
      return {
        slug,
        isolation: isoMap[slug] === 'worktree' ? 'worktree' : 'off',
        defaultBranch: (rec && rec.defaultBranch) || 'dev',
        repoPath: repo ? repo.repoPath : null,
        repoSource: repo ? repo.source : null,
      };
    });
    return { ok: true, workspaceRoot: getAgentWorkspaceRoot(), projects };
  });

  ipcMain.handle('project:config:set', (_e, input) => {
    const slug = typeof input?.slug === 'string' ? input.slug.trim().toLowerCase() : '';
    if (!slug) return { ok: false, why: 'slug gerekli' };
    const isolation = input?.isolation === 'worktree' ? 'worktree' : input?.isolation === 'off' ? 'off' : null;
    if (!isolation) return { ok: false, why: "isolation 'worktree' ya da 'off' olmalı" };
    const branch = typeof input?.defaultBranch === 'string' && input.defaultBranch.trim()
      ? input.defaultBranch.trim() : 'dev';
    const refErr = branchName.refFormatError(branch);
    if (refErr) return { ok: false, why: `varsayılan dal geçersiz: ${refErr}` };

    const s = agentSettings.readSettings();
    const nextMap = { ...(s.projectIsolation && typeof s.projectIsolation === 'object' ? s.projectIsolation : {}) };
    nextMap[slug] = isolation;
    const applied = agentSettings.applySettingsPatch({ projectIsolation: nextMap });

    const repo = projectRepos.resolveProjectRepo(slug, getAgentWorkspaceRoot(), {
      settings: applied.next, store: worktreeStore, homedir: crewpaneHome(), log: logLine,
    });
    let branchSaved = false;
    if (repo) {
      try {
        branchSaved = worktreeStore.setProject(slug, { repoPath: repo.repoPath, defaultBranch: branch }, crewpaneHome()) === true;
      } catch (e) {
        logLine(`project:config:set defterine yazılamadı (${slug}): ${e.message}`);
      }
    }
    logLine(`proje ayarı: ${slug} izolasyon=${isolation} dal=${branch}${repo ? ` repo=${repo.repoPath}` : ' repo=YOK'}`);
    return {
      ok: true,
      persisted: applied.persisted !== false,
      persistError: applied.persistError || null,
      branchSaved,
      repoPath: repo ? repo.repoPath : null,
      why: repo ? null : 'bu proje için git deposu bulunamadı — izolasyon açıkken görev spawn edilemez (H-5)',
    };
  });

  ipcMain.handle('codeIndex:list', async (_e, input) => {
    const wanted = Array.isArray(input?.slugs)
      ? input.slugs.map((x) => codeIndexStore.projectKey(x)).filter(Boolean) : [];
    const s = agentSettings.readSettings();
    const map = (s && s.codeIndex && typeof s.codeIndex === 'object') ? s.codeIndex : {};
    const repoMap = (s && s.projectRepos && typeof s.projectRepos === 'object') ? s.projectRepos : {};
    let stored = {};
    try { stored = worktreeStore.listProjects(crewpaneHome()) || {}; } catch { stored = {}; }
    const slugs = [...new Set([...wanted, ...Object.keys(map), ...Object.keys(repoMap), ...Object.keys(stored)])]
      .map((x) => codeIndexStore.projectKey(x)).filter(Boolean).sort();
    const bin = (() => { try { return codeIndexStore.findBinary({ env: process.env }); } catch { return null; } })();

    const toolProjects = await new Promise((resolve) => {
      if (!bin) { resolve(null); return; }
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      try {
        const child = spawn(bin.path, ['cli', 'list_projects', '{}'],
          { stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        child.stdout.on('data', (d) => { if (out.length < 8 * 1024 * 1024) out += d; });
        child.on('error', () => finish(null));
        child.on('close', () => finish(codeIndexHealth.parseProjects(out)));
        setTimeout(() => { try { child.kill(); } catch { /* zaten indi */ } finish(null); }, 5000).unref();
      } catch { finish(null); }
    });
    const corrupt = codeIndexHealth.corruptNames(codeIndexHealth.defaultCacheDir());
    const injections = (() => { try { return codeIndexStore.injectionsThisSession(); } catch { return {}; } })();
    return {
      ok: true,
      installed: !!bin,
      binPath: bin ? bin.path : null,
      binName: codeIndexStore.BIN_NAME,
      installUrl: codeIndexStore.INSTALL_URL,
      installHint: codeIndexStore.installHint(process.platform),
      platform: process.platform,
      serverName: codeIndexStore.SERVER_NAME,
      userRegistered: (() => { try { return codeIndexStore.userRegisteredServers({}); } catch { return []; } })(),
      projects: slugs.map((slug) => {
        const rec = map[slug] || null;
        const repoPath = codeIndexRepoPath(slug);
        const fresh = codeIndexFreshness(repoPath, rec ? rec.indexedSha : null);
        const realRepoPath = (() => {
          if (!repoPath) return repoPath;
          try { return require('node:fs').realpathSync(repoPath); } catch { return repoPath; }
        })();
        const health = codeIndexHealth.healthFor({
          repoPath: realRepoPath,
          ledger: {
            indexedSha: rec ? rec.indexedSha : null,
            lastIndexedAt: rec ? rec.lastIndexedAt : null,
            enabled: !!(rec && rec.enabled === true),
          },
          ledgerState: fresh.state,
          tool: toolProjects,
          corrupt,
        });
        return {
          slug,
          repoPath,
          enabled: !!(rec && rec.enabled === true),
          indexedSha: rec ? rec.indexedSha : null,
          lastIndexedAt: rec ? rec.lastIndexedAt : null,
          state: health.state,
          staleFiles: fresh.staleFiles,
          indexing: codeIndexJobs.has(slug),
          symbols: health.symbols,
          graphEdges: health.edges,
          toolAsked: health.toolAsked,
          toolName: health.toolName,
          injectedThisSession: injections[slug] || 0,
        };
      }),
    };
  });

  ipcMain.handle('codeIndex:set', (_e, input) => {
    const slug = codeIndexStore.projectKey(input?.slug);
    if (!slug) return { ok: false, why: 'proje kimliği gerekli' };
    const enabled = input?.enabled === true;
    const s = agentSettings.readSettings();
    const next = { ...(s.codeIndex && typeof s.codeIndex === 'object' ? s.codeIndex : {}) };
    const prev = next[slug] || {};
    next[slug] = { enabled, indexedSha: prev.indexedSha || null, lastIndexedAt: prev.lastIndexedAt || null };
    const applied = agentSettings.applySettingsPatch({ codeIndex: next });
    logLine(`kod indeksi: ${slug} → ${enabled ? 'AÇIK' : 'kapalı'} (bir sonraki pane'den itibaren)`);
    return {
      ok: true,
      enabled,
      persisted: applied.persisted !== false,
      persistError: applied.persistError || null,
      restartHint: true,
    };
  });

  ipcMain.handle('codeIndex:index', (_e, input) => {
    const slug = codeIndexStore.projectKey(input?.slug);
    if (!slug) return { ok: false, why: 'proje kimliği gerekli' };
    if (codeIndexJobs.has(slug)) return { ok: false, why: 'bu proje zaten indeksleniyor' };
    const bin = (() => { try { return codeIndexStore.findBinary({ env: process.env }); } catch { return null; } })();
    if (!bin) return { ok: false, why: `${codeIndexStore.BIN_NAME} kurulu değil` };
    const repoPath = codeIndexRepoPath(slug);
    if (!repoPath) return { ok: false, why: 'bu proje için git deposu bulunamadı' };
    const headSha = (() => {
      try {
        return require('node:child_process')
          .execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 4000 }).trim();
      } catch { return null; }
    })();
    const push = (payload) => {
      const win = getAppWindow();
      if (win && !win.isDestroyed()) win.webContents.send('codeIndex:progress', { slug, ...payload });
    };
    let child;
    try {
      child = spawn(bin.path, ['cli', 'index_repository', '--repo-path', repoPath], {
        cwd: repoPath, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      return { ok: false, why: `indeksleme başlatılamadı: ${e.message}` };
    }
    codeIndexJobs.set(slug, child);
    logLine(`kod indeksi: ${slug} indeksleniyor (${repoPath})`);
    let tail = '';
    const onOut = (buf) => { tail = (tail + buf.toString()).slice(-2000); push({ running: true }); };
    child.stdout.on('data', onOut);
    child.stderr.on('data', onOut);
    child.on('error', (e) => { logLine(`kod indeksi: ${slug} hata ${e.message}`); });
    child.on('close', (code) => {
      codeIndexJobs.delete(slug);
      const ok = code === 0;
      if (ok && headSha) {
        try {
          const cur = agentSettings.readSettings();
          const map = { ...(cur.codeIndex && typeof cur.codeIndex === 'object' ? cur.codeIndex : {}) };
          const prev = map[slug] || {};
          map[slug] = { enabled: prev.enabled === true, indexedSha: headSha, lastIndexedAt: Date.now() };
          agentSettings.applySettingsPatch({ codeIndex: map });
        } catch (e) { logLine(`kod indeksi: ${slug} defteri yazılamadı (${e.message})`); }
      }
      logLine(`kod indeksi: ${slug} bitti çıkış=${code}`);
      push({ running: false, ok, exitCode: code, tail: ok ? null : tail.slice(-400) });
    });
    return { ok: true, started: true, repoPath };
  });
}

module.exports = { registerCodeIntelIpc };
