'use strict';

/**
 * Memory & Search Indexing Service (Faz 3.6.35)
 * Encapsulates memoryIndexer, searchIndexer, memorySearcher,
 * memoryEmbedInstaller, spawn warming hook, and memory settle measurement.
 */

const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const defaultMemoryIndexService = require('../../memory/memoryIndexService.cjs');
const defaultSearchIndexService = require('../../memory/searchIndexService.cjs');
const defaultMemorySearchService = require('../../memory/memorySearchService.cjs');
const defaultMemoryEmbedInstall = require('../../memory/memoryEmbedInstall.cjs');
const defaultMemoryEmbedHosted = require('../../memory/memoryEmbedHosted.cjs');
const defaultInstancePaths = require('../../config/instancePaths.cjs');

class MemoryService {
  constructor(deps = {}) {
    this.deps = deps;
    this.memoryIndexService = deps.memoryIndexService || defaultMemoryIndexService;
    this.searchIndexService = deps.searchIndexService || defaultSearchIndexService;
    this.memorySearchService = deps.memorySearchService || defaultMemorySearchService;
    this.memoryEmbedInstall = deps.memoryEmbedInstall || defaultMemoryEmbedInstall;
    this.memoryEmbedHosted = deps.memoryEmbedHosted || defaultMemoryEmbedHosted;
    this.instancePaths = deps.instancePaths || defaultInstancePaths;

    this._memoryIndexerSingleton = null;
    this._searchIndexSingleton = null;
    this._searchIndexRootKey = '';
    this._memorySearcherSingleton = null;
    this._memoryEmbedInstallerSingleton = null;

    if (deps.setupWarm !== false) {
      this.setupSpawnMemoryWarm();
    }
  }

  get memoryIndexerSingleton() {
    return this._memoryIndexerSingleton;
  }

  get searchIndexSingleton() {
    return this._searchIndexSingleton;
  }

  hostedEmbedKeyEnv() {
    try {
      return this.memoryEmbedHosted.hostedKeyEnv();
    } catch (err) {
      const log = this.deps.logLine || (() => {});
      log(`memoryEmbed: barındırılan anahtar köprüsü kurulamadı (${err.message}) — çocuk kapıyı kendisi deneyecek`);
      return {};
    }
  }

  memoryIndexer() {
    if (!this._memoryIndexerSingleton) {
      const getAppWindow = this.deps.getAppWindow || (() => null);
      this._memoryIndexerSingleton = this.memoryIndexService.createIndexService({
        repoRoot: this.deps.repoRoot,
        logLine: this.deps.logLine || (() => {}),
        hostedKeyEnv: () => this.hostedEmbedKeyEnv(),
        onEvent: (payload) => {
          try {
            const appWindow = getAppWindow();
            if (appWindow && !appWindow.isDestroyed()) {
              appWindow.webContents.send('memoryIndex:event', payload);
            }
          } catch {
            /* pencere kapanıyor */
          }
        },
      });
    }
    return this._memoryIndexerSingleton;
  }

  searchIndexer() {
    const getRoot = this.deps.getAgentWorkspaceRoot || (() => '');
    const root = getRoot() || '';
    if (this._searchIndexSingleton && this._searchIndexRootKey !== root) {
      try {
        this._searchIndexSingleton.dispose();
      } catch {
        /* kapanıyor */
      }
      this._searchIndexSingleton = null;
    }
    if (!this._searchIndexSingleton) {
      const key = crypto.createHash('sha1').update(String(root || 'no-workspace')).digest('hex').slice(0, 12);
      this._searchIndexRootKey = root;
      const getAppWindow = this.deps.getAppWindow || (() => null);
      const readSettings = this.deps.readSettings || (this.deps.agentSettings ? () => this.deps.agentSettings.readSettings() : () => ({}));
      const homedir = os.homedir();
      this._searchIndexSingleton = this.searchIndexService.createSearchIndexService({
        dbFile: path.join(this.instancePaths.instanceHome(homedir), 'search-index', `${key}.db`),
        repoRoot: this.deps.repoRoot,
        workspaceRoot: root,
        home: process.env.CREWPANE_SEARCH_HOME || homedir,
        sessionsEnabled: (readSettings().memorySearch || {}).sessionsIndexed !== false,
        logLine: this.deps.logLine || (() => {}),
        onEvent: (payload) => {
          try {
            const appWindow = getAppWindow();
            if (appWindow && !appWindow.isDestroyed()) {
              appWindow.webContents.send('searchIndex:event', payload);
            }
          } catch {
            /* pencere kapanıyor */
          }
        },
      });
    }
    return this._searchIndexSingleton;
  }

  memorySearcher() {
    if (!this._memorySearcherSingleton) {
      const readSettings = this.deps.readSettings || (this.deps.agentSettings ? () => this.deps.agentSettings.readSettings() : () => ({}));
      this._memorySearcherSingleton = this.memorySearchService.createSearchService({
        repoRoot: this.deps.repoRoot,
        logLine: this.deps.logLine || (() => {}),
        semanticEnabled: () => (readSettings().memorySearch || {}).semanticEnabled !== false,
        hostedKeyEnv: () => this.hostedEmbedKeyEnv(),
      });
    }
    return this._memorySearcherSingleton;
  }

  memoryEmbedInstaller() {
    if (!this._memoryEmbedInstallerSingleton) {
      const getAppWindow = this.deps.getAppWindow || (() => null);
      this._memoryEmbedInstallerSingleton = this.memoryEmbedInstall.createInstaller({
        repoRoot: this.deps.repoRoot,
        logLine: this.deps.logLine || (() => {}),
        onEvent: (payload) => {
          try {
            const appWindow = getAppWindow();
            if (appWindow && !appWindow.isDestroyed()) {
              appWindow.webContents.send('memoryEmbed:event', payload);
            }
          } catch {
            /* pencere kapanıyor */
          }
        },
      });
    }
    return this._memoryEmbedInstallerSingleton;
  }

  setupSpawnMemoryWarm() {
    const agentRunner = this.deps.agentRunner;
    if (!agentRunner || typeof agentRunner.setSpawnMemoryWarm !== 'function') return;
    const log = this.deps.logLine || (() => {});
    agentRunner.setSpawnMemoryWarm(({ workspaceRoot, query }) => {
      try {
        this.memorySearcher()
          .warmQuery({ workspaceRoot, query })
          .catch((err) => log(`memorySearch: spawn ısıtma başarısız: ${err.message}`));
      } catch (err) {
        log(`memorySearch: spawn ısıtma başlatılamadı: ${err.message}`);
      }
    });
  }

  settleMemoryUsage(opts = {}) {
    try {
      const agentRunner = this.deps.agentRunner;
      if (!agentRunner || typeof agentRunner.memoryLedger !== 'function') return null;
      const ledger = agentRunner.memoryLedger();
      if (!ledger) return null;
      const transcriptProbe = this.deps.transcriptProbe;
      const res = ledger.settle(
        (entry) => {
          if (!entry || !entry.cwd || !entry.sessionId || !transcriptProbe) return null;
          const file = transcriptProbe.resolveTranscriptFile(entry.cwd, entry.sessionId);
          if (!file) return null;
          const tail = transcriptProbe.readTail(file);
          if (tail === null) return null;
          return (entry.slugs || []).filter((s) => tail.includes(s));
        },
        {
          filter: opts.paneId ? (e) => e.paneId === opts.paneId : undefined,
          maxAgeMs: 7 * 24 * 60 * 60 * 1000,
        },
      );
      if (res && (res.settled || res.unmeasured)) {
        const log = this.deps.logLine || (() => {});
        log(`memory ledger: ${res.settled} enjeksiyon kapandı, ${res.used} kullanım, ${res.unmeasured} ölçülemedi`);
      }
      return res;
    } catch (err) {
      const log = this.deps.logLine || (() => {});
      log(`memory ledger settle failed: ${err.message}`);
      return null;
    }
  }

  shutdown() {
    if (this._memoryIndexerSingleton && typeof this._memoryIndexerSingleton.shutdown === 'function') {
      try {
        this._memoryIndexerSingleton.shutdown();
      } catch {
        /* best-effort */
      }
    }
    if (this._searchIndexSingleton && typeof this._searchIndexSingleton.stop === 'function') {
      try {
        this._searchIndexSingleton.stop();
      } catch {
        /* best-effort */
      }
    }
  }
}

function createMemoryService(deps) {
  return new MemoryService(deps);
}

module.exports = {
  createMemoryService,
  MemoryService,
};
