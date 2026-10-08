'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { renameWithRetrySync } = require('../../../platform/atomicWrite.cjs');
const {
  withinActiveRoots: rawWithinActiveRoots,
  resolveInRoots: rawResolveInRoots,
  resolveSearchRoot: rawResolveSearchRoot,
  displayPath: rawDisplayPath,
  readWorkspaceFile: rawReadWorkspaceFile,
  writeWorkspaceFile: rawWriteWorkspaceFile,
  listWorkspaceDir: rawListWorkspaceDir,
  readGitBranch: rawReadGitBranch,
} = require('../../shared/utils');

const DEFAULT_FILE_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

const DEFAULT_DEPS = {
  activeRoots: null,
  getWorkspaceRoot: () => null,
  getUserDataPath: () => '',
  ptys: null,
  dialog: null,
  appI18n: { t: (k) => k },
  fileMaxBytes: DEFAULT_FILE_MAX_BYTES,
  logLine: () => {},
  renameWithRetry: renameWithRetrySync,
};

class WorkspaceFileService {
  constructor(deps = {}) {
    this.deps = Object.assign({}, DEFAULT_DEPS, deps);
    this.activeRoots = this.deps.activeRoots || new Set();
  }

  getWorkspaceRoot() {
    return this.deps.getWorkspaceRoot();
  }

  withinActiveRoots(abs) {
    return rawWithinActiveRoots(abs, this.activeRoots);
  }

  resolveInRoots(p) {
    return rawResolveInRoots(p, {
      workspaceRoot: this.getWorkspaceRoot(),
      activeRoots: this.activeRoots,
    });
  }

  readGitBranch(startDir) {
    return rawReadGitBranch(startDir, { activeRoots: this.activeRoots });
  }

  resolveSearchRoot(p) {
    return rawResolveSearchRoot(p, {
      workspaceRoot: this.getWorkspaceRoot(),
      activeRoots: this.activeRoots,
    });
  }

  displayPath(abs) {
    return rawDisplayPath(abs, this.getWorkspaceRoot());
  }

  readWorkspaceFile(p) {
    return rawReadWorkspaceFile(p, {
      workspaceRoot: this.getWorkspaceRoot(),
      activeRoots: this.activeRoots,
      fileMaxBytes: this.deps.fileMaxBytes,
      logLine: this.deps.logLine,
    });
  }

  writeWorkspaceFile(payload) {
    return rawWriteWorkspaceFile(payload, {
      workspaceRoot: this.getWorkspaceRoot(),
      activeRoots: this.activeRoots,
      fileMaxBytes: this.deps.fileMaxBytes,
      logLine: this.deps.logLine,
    });
  }

  listWorkspaceDir(dir) {
    return rawListWorkspaceDir(dir, {
      workspaceRoot: this.getWorkspaceRoot(),
      activeRoots: this.activeRoots,
    });
  }

  async openFolderDialog(win) {
    let result;
    try {
      result = await this.deps.dialog.showOpenDialog(win ?? undefined, {
        title: this.deps.appI18n.t('main.dialog.openFolder.title'),
        properties: ['openDirectory', 'createDirectory'],
      });
    } catch (err) {
      return { ok: false, reason: 'dialog-failed', detail: err.message };
    }
    if (!result || result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
      return { ok: false, reason: 'canceled' };
    }
    let chosen = result.filePaths[0];
    try {
      chosen = fs.realpathSync(chosen);
    } catch {
      // dir must exist; fall through to stat
    }
    try {
      if (!fs.statSync(chosen).isDirectory()) {
        return { ok: false, reason: 'not-a-directory' };
      }
    } catch (err) {
      return { ok: false, reason: 'read-failed', detail: err.message };
    }
    this.activeRoots.add(chosen);
    this.persistGrantedRoots();
    this.deps.logLine(`file:openDialog added root ${chosen}`);
    return { ok: true, root: this.displayPath(chosen), name: path.basename(chosen) || chosen };
  }

  allowPaneRoot(paneId) {
    const ptys = this.deps.ptys;
    const entry = ptys ? ptys.get(paneId) : null;
    if (!entry) return { ok: false, reason: 'no-pane' };
    let cwd = entry.cwd;
    if (typeof cwd !== 'string' || cwd.length === 0) return { ok: false, reason: 'no-cwd' };
    try {
      cwd = fs.realpathSync(cwd);
    } catch {
      // cwd may be gone; use as recorded
    }
    this.activeRoots.add(cwd);
    this.deps.logLine(`file:allowPaneRoot paneId=${paneId} root=${cwd}`);
    return { ok: true, cwd, home: os.homedir(), workspaceRoot: this.getWorkspaceRoot() };
  }

  editorStatePath() {
    return path.join(this.deps.getUserDataPath(), 'editor-state.json');
  }

  grantedRootsPath() {
    return path.join(this.deps.getUserDataPath(), 'editor-granted-roots.json');
  }

  persistGrantedRoots() {
    try {
      const root = this.getWorkspaceRoot();
      const extra = [...this.activeRoots].filter((r) => r !== root);
      fs.writeFileSync(this.grantedRootsPath(), JSON.stringify(extra), 'utf8');
    } catch {
      // best-effort
    }
  }

  rehydrateGrantedRoots() {
    let list;
    try {
      list = JSON.parse(fs.readFileSync(this.grantedRootsPath(), 'utf8'));
    } catch {
      return; // none saved
    }
    if (!Array.isArray(list)) return;
    for (const r of list) {
      if (typeof r !== 'string') continue;
      let abs = r;
      try {
        abs = fs.realpathSync(r);
      } catch {
        continue;
      }
      try {
        if (!fs.statSync(abs).isDirectory()) continue;
      } catch {
        continue;
      }
      this.activeRoots.add(abs);
    }
    this.deps.logLine(`rehydrated ${this.activeRoots.size - 1} granted editor root(s)`);
  }

  readEditorState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.editorStatePath(), 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  writeEditorState(state) {
    try {
      if (state == null) {
        try {
          fs.unlinkSync(this.editorStatePath());
        } catch {
          // already gone
        }
        return { ok: true };
      }
      fs.writeFileSync(this.editorStatePath(), JSON.stringify(state), 'utf8');
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e) };
    }
  }

  officeStatePath() {
    return path.join(this.deps.getUserDataPath(), 'office-state.json');
  }

  readOfficeState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.officeStatePath(), 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  writeOfficeState(state) {
    try {
      const file = this.officeStatePath();
      if (state == null) {
        try {
          fs.unlinkSync(file);
        } catch {
          // already gone
        }
        return { ok: true };
      }
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
      this.deps.renameWithRetry(tmp, file);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e) };
    }
  }

  feedbackSeenPath() {
    return path.join(this.deps.getUserDataPath(), 'feedback-seen.json');
  }

  readFeedbackSeen() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.feedbackSeenPath(), 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  writeFeedbackSeen(state) {
    try {
      const file = this.feedbackSeenPath();
      if (state == null) {
        try {
          fs.unlinkSync(file);
        } catch {
          // already gone
        }
        return { ok: true };
      }
      if (typeof state !== 'object' || Array.isArray(state)) {
        return { ok: false, error: 'invalid' };
      }
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
      this.deps.renameWithRetry(tmp, file);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }
}

function createWorkspaceFileService(deps) {
  return new WorkspaceFileService(deps);
}

module.exports = {
  WorkspaceFileService,
  createWorkspaceFileService,
};
