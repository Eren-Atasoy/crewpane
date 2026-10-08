'use strict';

/**
 * Code Index & Repository Freshness Service (Faz 3.6.37)
 * Encapsulates codeIndex resolver, project repository resolution,
 * git commit/dirty diff freshness measurement, and job registry.
 */

const os = require('node:os');
const { execFileSync } = require('node:child_process');

const defaultCodeIndexStore = require('../../services/codeIndex.cjs');
const defaultProjectRepos = require('../../config/projectRepos.cjs');

class CodeIndexService {
  constructor(deps = {}) {
    this.deps = deps;
    this.codeIndexStore = deps.codeIndexStore || defaultCodeIndexStore;
    this.projectRepos = deps.projectRepos || defaultProjectRepos;
    this.worktreeStore = deps.worktreeStore;
    this.agentSettings = deps.agentSettings;
    this.crewpaneHome = deps.crewpaneHome || (() => '');
    this.getAgentWorkspaceRoot = deps.getAgentWorkspaceRoot || (() => '');
    this.logLine = deps.logLine || (() => {});
    this.env = deps.env || process.env;
    this.homedir = deps.homedir || os.homedir();
    this.execFileSync = deps.execFileSync || execFileSync;

    this.codeIndexJobs = new Map();
  }

  codeIndexResolverOrNull() {
    try {
      return this.codeIndexStore.createResolver({
        readSettings: () => (this.agentSettings ? this.agentSettings.readSettings() : {}),
        env: this.env,
        homedir: this.homedir,
        log: this.logLine,
      });
    } catch (e) {
      this.logLine(`kod indeksi çözümleyicisi kurulamadı: ${e.message}`);
      return null;
    }
  }

  codeIndexRepoPath(slug) {
    try {
      const workspaceRoot = this.getAgentWorkspaceRoot();
      const settings = this.agentSettings ? this.agentSettings.readSettings() : {};
      const repo = this.projectRepos.resolveProjectRepo(slug, workspaceRoot, {
        settings,
        store: this.worktreeStore,
        homedir: this.crewpaneHome(),
        log: () => {},
      });
      return repo ? repo.repoPath : null;
    } catch {
      return null;
    }
  }

  codeIndexFreshness(repoPath, indexedSha) {
    if (!repoPath || !indexedSha) {
      return this.codeIndexStore.freshness({ indexedSha: indexedSha || null });
    }
    const git = (args) => {
      try {
        return this.execFileSync('git', ['-C', repoPath, ...args], {
          encoding: 'utf8',
          timeout: 4000,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      } catch {
        return null;
      }
    };
    const headSha = git(['rev-parse', 'HEAD']);
    if (!headSha) return this.codeIndexStore.freshness({ indexedSha });

    const committed = git(['diff', '--name-only', `${indexedSha}..HEAD`]);
    const dirty = git(['status', '--porcelain', '--untracked-files=no']);
    if (committed === null && dirty === null) {
      return { ...this.codeIndexStore.freshness({ indexedSha }), headSha };
    }
    const files = new Set();
    for (const line of (committed || '').split('\n')) {
      const f = line.trim();
      if (f) files.add(f);
    }
    for (const line of (dirty || '').split('\n')) {
      const f = line.slice(3).trim();
      if (f) files.add(f);
    }
    return {
      ...this.codeIndexStore.freshness({ indexedSha, headSha, changedFiles: [...files] }),
      headSha,
    };
  }
}

function createCodeIndexService(deps) {
  return new CodeIndexService(deps);
}

module.exports = {
  createCodeIndexService,
  CodeIndexService,
};
