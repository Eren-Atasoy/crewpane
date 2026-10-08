'use strict';

/**
 * Memory, MemoryIndex, and MemoryEmbed IPC Handlers (Faz 3.5 — Sıra 4)
 * Channels:
 *   - memory:graph, memory:fact, memory:recall, memory:taskBlock
 *   - memoryIndex:status, memoryIndex:start, memoryIndex:stop, memoryIndex:search, memoryIndex:searchStatus
 *   - memoryEmbed:state, memoryEmbed:plan, memoryEmbed:consent, memoryEmbed:install, memoryEmbed:cancel, memoryEmbed:remove, memoryEmbed:setPrefs
 */
function registerMemoryIpc({
  ipcMain,
  memoryGraph,
  getAgentWorkspaceRoot,
  memoryIndexer,
  memorySearcher,
  agentSettings,
  memoryEmbedder,
  REPO_ROOT,
  memoryEmbedInstall,
  memoryEmbedInstaller,
  memoryRecall,
  secretRedactor,
  ptys,
  agentRunner,
  memoryTaskBlock,
  currentSessionId,
  paneContextScope,
  engineMemoryScope,
  searchIndexer = () => null,
  logLine = () => {},
}) {
  // ── ADP-243 / ADP-277: Memory Graph & Fact ─────────────────────────────────
  ipcMain.handle('memory:graph', () => {
    try {
      return memoryGraph.buildMemoryGraph({ workspaceRoot: getAgentWorkspaceRoot() });
    } catch (err) {
      logLine(`memory:graph failed: ${err.message}`);
      return { nodes: [], edges: [], counts: {}, scopes: {}, health: { ok: false, reason: 'not_writable', root: null, detail: err.message } };
    }
  });

  ipcMain.handle('memory:fact', (_event, scope, slug) => {
    try {
      return memoryGraph.readFact({ workspaceRoot: getAgentWorkspaceRoot(), scope, slug });
    } catch (err) {
      logLine(`memory:fact failed: ${err.message}`);
      return null;
    }
  });

  // ── ADP-870 / ADP-871: Memory Index & Hybrid Search ────────────────────────
  ipcMain.handle('memoryIndex:status', () => {
    try {
      return memoryIndexer().status();
    } catch (err) {
      logLine(`memoryIndex:status failed: ${err.message}`);
      return { running: false, phase: 'error', reason: err.message };
    }
  });

  ipcMain.handle('memoryIndex:start', () => {
    try {
      return memoryIndexer().start({ workspaceRoot: getAgentWorkspaceRoot() });
    } catch (err) {
      logLine(`memoryIndex:start failed: ${err.message}`);
      return { ok: false, reason: err.message };
    }
  });

  ipcMain.handle('memoryIndex:stop', () => {
    try {
      return memoryIndexer().stop();
    } catch (err) {
      logLine(`memoryIndex:stop failed: ${err.message}`);
      return { ok: false, reason: err.message };
    }
  });

  ipcMain.handle('memoryIndex:search', async (_evt, query, k) => {
    try {
      return await memorySearcher().search({
        workspaceRoot: getAgentWorkspaceRoot(),
        query: String(query || ''),
        k: Number.isFinite(k) ? Math.max(1, Math.min(20, k)) : 5,
      });
    } catch (err) {
      logLine(`memoryIndex:search failed: ${err.message}`);
      return { ok: false, reason: err.message };
    }
  });

  ipcMain.handle('memoryIndex:searchStatus', () => {
    try {
      return memorySearcher().status();
    } catch (err) {
      return { embedderReady: false, unavailable: err.message };
    }
  });

  // ── ADP-900 / WIN-W6A: Memory Embedder Installation & Preferences ─────────
  ipcMain.handle('memoryEmbed:state', () => {
    try {
      const s = agentSettings.readSettings();
      const prefs = s.memorySearch || {};
      const avail = memoryEmbedder.localAvailability({ repoRoot: REPO_ROOT });
      const effective = memoryEmbedder.availability({ repoRoot: REPO_ROOT });
      return {
        ok: true,
        prefs: {
          semanticEnabled: prefs.semanticEnabled !== false,
          autoIndex: prefs.autoIndex !== false,
          consent: prefs.semanticConsent || null,
        },
        available: avail.ok,
        reason: avail.ok ? null : avail.reason,
        hosted: {
          active: effective.ok === true && effective.kind === 'hosted',
          provider: effective.kind === 'hosted' ? effective.provider : null,
          model: effective.kind === 'hosted' ? effective.model : null,
          dim: effective.kind === 'hosted' ? effective.dim : null,
          reason: effective.ok ? null : effective.hostedReason || null,
          message: effective.ok ? null : effective.message || null,
          settingsTarget: effective.ok ? null : effective.settingsTarget || null,
        },
        model: memoryEmbedder.MODEL_ID,
        ramMb: memoryEmbedInstall.EXPECTED_RSS_MB,
        installRoot: memoryEmbedInstall.installRoot(),
        diskBytes: memoryEmbedInstall.dirSize(memoryEmbedInstall.installRoot()),
        install: memoryEmbedInstaller().status(),
        search: memorySearcher().status(),
      };
    } catch (err) {
      logLine(`memoryEmbed:state failed: ${err.message}`);
      return { ok: false, reason: err.message };
    }
  });

  ipcMain.handle('memoryEmbed:plan', async () => {
    try {
      return await memoryEmbedInstall.probePlan({ repoRoot: REPO_ROOT });
    } catch (err) {
      logLine(`memoryEmbed:plan failed: ${err.message}`);
      return { ok: false, reason: 'probe_failed', message: err.message };
    }
  });

  ipcMain.handle('memoryEmbed:consent', (_evt, granted, key) => {
    try {
      const next = agentSettings.writeSettings({
        memorySearch: {
          semanticConsent: { granted: granted === true, key: String(key || ''), at: Date.now() },
        },
      });
      logLine(`memoryEmbed: onay ${granted === true ? 'VERİLDİ' : 'REDDEDİLDİ'} (${key || '-'})`);
      return { ok: true, consent: next.memorySearch.semanticConsent };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  });

  ipcMain.handle('memoryEmbed:install', async () => {
    try {
      const consent = agentSettings.readSettings().memorySearch?.semanticConsent || null;
      const res = await memoryEmbedInstaller().start({ consent });
      if (res.ok) {
        try {
          memorySearcher().reset();
        } catch {
          /* servis yoksa sorun değil */
        }
      }
      return res;
    } catch (err) {
      logLine(`memoryEmbed:install failed: ${err.message}`);
      return { ok: false, reason: 'install_failed', message: err.message };
    }
  });

  ipcMain.handle('memoryEmbed:cancel', () => {
    try {
      return memoryEmbedInstaller().cancel();
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  });

  ipcMain.handle('memoryEmbed:remove', () => {
    try {
      const res = memoryEmbedInstaller().remove();
      agentSettings.writeSettings({ memorySearch: { semanticConsent: null } });
      try {
        memorySearcher().reset();
      } catch {
        /* servis yoksa sorun değil */
      }
      return res;
    } catch (err) {
      logLine(`memoryEmbed:remove failed: ${err.message}`);
      return { ok: false, reason: err.message };
    }
  });

  ipcMain.handle('memoryEmbed:setPrefs', (_evt, patch) => {
    try {
      const p = patch && typeof patch === 'object' ? patch : {};
      const memorySearch = {};
      if (typeof p.semanticEnabled === 'boolean') memorySearch.semanticEnabled = p.semanticEnabled;
      if (typeof p.autoIndex === 'boolean') memorySearch.autoIndex = p.autoIndex;
      const next = agentSettings.writeSettings({ memorySearch });
      return { ok: true, prefs: next.memorySearch };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  });

  // ── ADP-862: Memory Recall ────────────────────────────────────────────────
  ipcMain.handle('memory:recall', async (_evt, query, k) => {
    try {
      const res = await memoryRecall.recall({
        workspaceRoot: getAgentWorkspaceRoot(),
        query: String(query || ''),
        k: Number.isFinite(k) ? Math.max(1, Math.min(20, k)) : 5,
        search: (args) => memorySearcher().search(args),
      });
      return secretRedactor.redactDeep(res);
    } catch (err) {
      logLine(`memory:recall failed: ${err.message}`);
      return { ok: false, found: false, measured: false, results: [], text: memoryRecall.unmeasuredText(err.message), degraded: true, reason: err.message };
    }
  });

  // ── D-07 / MEM-SCOPE-01: Memory Task Block ────────────────────────────────
  ipcMain.handle('memory:taskBlock', (_evt, payload) => {
    const empty = (reason) => ({ ok: false, text: '', slugs: [], stats: { reason } });
    try {
      const p = payload && typeof payload === 'object' ? payload : {};
      const paneId = typeof p.paneId === 'string' ? p.paneId : '';
      const entry = paneId ? ptys.get(paneId) : null;
      const agentId = (entry && entry.agentId) || (typeof p.agentId === 'string' ? p.agentId.trim() : '');
      const taskText = typeof p.text === 'string' ? p.text : '';
      if (!agentId || !taskText.trim()) return empty('no-scope');
      const wsRoot = getAgentWorkspaceRoot();
      if (!wsRoot) return empty('no-workspace');
      const ledger = agentRunner.memoryLedger();
      const res = memoryTaskBlock.taskBlock({
        workspaceRoot: wsRoot,
        agentId,
        taskText,
        cliPath: agentRunner.runnableRecallCli(),
        ledger,
        retrieve: agentRunner.spawnRetrieverFor(wsRoot),
      });
      if (ledger && res.slugs.length) {
        const sessionId = paneId ? currentSessionId(paneId) : null;
        ledger.recordInjection({
          key: `${paneId || agentId}|${sessionId || ''}`,
          slugs: res.slugs,
          agentId,
          paneId: paneId || null,
          cwd: (entry && entry.cwd) || null,
          sessionId,
          stage: 'task',
        });
      }
      let engineBlock = null;
      try {
        const idxPath = paneContextScope.engineMemoryIndexPath({
          engineId: (entry && entry.command) || 'claude',
          cwd: (entry && entry.cwd) || wsRoot,
        });
        if (idxPath) {
          const plan = engineMemoryScope.planMemoryIndex({
            indexPath: idxPath,
            query: taskText,
            cliPath: agentRunner.runnableEngineMemorySearchCli(),
            opts: { rulesOnly: false, skipRules: true },
          });
          if (plan && plan.text && plan.stats.selected > 0) engineBlock = plan;
        }
      } catch (err) {
        logLine(`memory:taskBlock motor indeksi seçkisi atlandı: ${err.message}`);
      }
      const out = engineBlock
        ? { ...res, text: `${res.text ? `${res.text}\n` : ''}${engineBlock.text.trim()}`, engineMemory: engineBlock.stats }
        : res;
      logLine(
        `memory:taskBlock agent=${agentId} seçilen=${res.stats.kept ?? 0}/${res.stats.considered ?? 0} ` +
          `eşik=${res.stats.threshold ?? '-'} sebep=${res.stats.reason} ch=${res.stats.chars ?? 0}` +
          (engineBlock ? ` · motor-indeksi=${engineBlock.stats.selected}/${engineBlock.stats.indexed}` : ''),
      );
      return { ok: true, ...out };
    } catch (err) {
      logLine(`memory:taskBlock failed: ${err.message}`);
      return empty(err.message);
    }
  });

  // ── SEARCH-2: Search Index (query, status, reindex, syncTasks, setSessionsEnabled) ──
  ipcMain.handle('searchIndex:query', (_evt, payload) => {
    try {
      const p = payload && typeof payload === 'object' ? payload : {};
      return searchIndexer().query({
        text: String(p.text || ''),
        types: Array.isArray(p.types) && p.types.length ? p.types.map(String).slice(0, 12) : null,
        agent: p.agent ? String(p.agent) : null,
        perType: Number.isFinite(p.perType) ? Math.max(1, Math.min(20, p.perType)) : 5,
      });
    } catch (err) {
      logLine(`searchIndex:query failed: ${err.message}`);
      return { ok: false, reason: err.message, groups: {}, total: 0 };
    }
  });

  ipcMain.handle('searchIndex:status', () => {
    try {
      return searchIndexer().status();
    } catch (err) {
      return { running: false, phase: 'error', reason: err.message };
    }
  });

  ipcMain.handle('searchIndex:reindex', () => {
    try {
      return searchIndexer().start();
    } catch (err) {
      logLine(`searchIndex:reindex failed: ${err.message}`);
      return { ok: false, reason: err.message };
    }
  });

  ipcMain.handle('searchIndex:syncTasks', (_evt, rows) => {
    try {
      return searchIndexer().syncTasks(Array.isArray(rows) ? rows.slice(0, 20000) : []);
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  });

  ipcMain.handle('searchIndex:setSessionsEnabled', (_evt, enabled) => {
    try {
      const v = !!enabled;
      agentSettings.writeSettings({ memorySearch: { sessionsIndexed: v } });
      return searchIndexer().setSessionsEnabled(v);
    } catch (err) {
      logLine(`searchIndex:setSessionsEnabled failed: ${err.message}`);
      return { ok: false, reason: err.message };
    }
  });
}

module.exports = { registerMemoryIpc };

