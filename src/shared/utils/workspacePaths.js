'use strict';

const path = require('node:path');
const fs = require('node:fs');

/** True iff `abs` is the workspace root itself or strictly inside it. */
function withinWorkspace(abs, workspaceRoot) {
  if (!workspaceRoot) return false;
  const rootWithSep = workspaceRoot.endsWith(path.sep) ? workspaceRoot : workspaceRoot + path.sep;
  return abs === workspaceRoot || abs.startsWith(rootWithSep);
}

/** True iff `abs` is, or is strictly inside, ANY currently-active root. */
function withinActiveRoots(abs, activeRoots) {
  if (!activeRoots) return false;
  for (const root of activeRoots) {
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
    if (abs === root || abs.startsWith(rootWithSep)) return true;
  }
  return false;
}

/**
 * Resolve a renderer-supplied path and reject anything outside EVERY active root.
 * Relative paths resolve under the workspace root (backward compat with the
 * workspace-relative tree); absolute paths are normalized then range-checked against
 * the active-root allow-list. Returns the absolute path, or null if denied.
 */
function resolveInRoots(p, { workspaceRoot, activeRoots } = {}) {
  if (typeof p !== 'string' || p.length === 0) return null;
  if (!path.isAbsolute(p) && !workspaceRoot) return null;
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(workspaceRoot, p);
  return withinActiveRoots(abs, activeRoots) ? abs : null;
}

/**
 * TASK-MQTIVZSDYPNRH — resolve the editor-supplied "active workspace" to a DIRECTORY inside an active root.
 */
function resolveSearchRoot(p, { workspaceRoot, activeRoots } = {}) {
  const abs = resolveInRoots(p, { workspaceRoot, activeRoots });
  if (abs) {
    try {
      return fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
    } catch {
      /* missing -> fall through */
    }
  }
  return workspaceRoot;
}

/**
 * The path form handed back to the renderer: workspace-relative for in-workspace paths,
 * and ABSOLUTE path for anything under a user-opened root.
 */
function displayPath(abs, workspaceRoot) {
  return withinWorkspace(abs, workspaceRoot) ? (path.relative(workspaceRoot, abs) || '.') : abs;
}

/** Read a file inside any active root as UTF-8. */
function readWorkspaceFile(p, { workspaceRoot, activeRoots, fileMaxBytes = 5 * 1024 * 1024, logLine = () => {} } = {}) {
  try {
    const abs = resolveInRoots(p, { workspaceRoot, activeRoots });
    if (!abs) return { ok: false, reason: 'path-denied' };
    const real = fs.existsSync(abs) ? fs.realpathSync(abs) : abs;
    if (!withinActiveRoots(real, activeRoots)) return { ok: false, reason: 'path-denied' };
    const st = fs.statSync(real);
    if (st.isDirectory()) return { ok: false, reason: 'is-directory' };
    if (st.size > fileMaxBytes) return { ok: false, reason: 'too-large' };
    const content = fs.readFileSync(real, 'utf8');
    logLine(`file:read ${displayPath(real, workspaceRoot)} (${st.size} bytes)`);
    return { ok: true, content, encoding: 'utf8', path: displayPath(real, workspaceRoot) };
  } catch (err) {
    return { ok: false, reason: 'read-failed', detail: err.message };
  }
}

/** Write UTF-8 content to a file inside any active root. */
function writeWorkspaceFile(payload, { workspaceRoot, activeRoots, fileMaxBytes = 5 * 1024 * 1024, logLine = () => {} } = {}) {
  try {
    if (!payload || typeof payload !== 'object') return { ok: false, reason: 'bad-request' };
    const { path: p, content } = payload;
    if (typeof content !== 'string') return { ok: false, reason: 'bad-data' };
    const abs = resolveInRoots(p, { workspaceRoot, activeRoots });
    if (!abs) return { ok: false, reason: 'path-denied' };
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > fileMaxBytes) return { ok: false, reason: 'too-large' };
    const parent = path.dirname(abs);
    const realParent = fs.existsSync(parent) ? fs.realpathSync(parent) : parent;
    if (!withinActiveRoots(realParent, activeRoots)) return { ok: false, reason: 'path-denied' };
    if (fs.existsSync(abs) && !withinActiveRoots(fs.realpathSync(abs), activeRoots)) {
      return { ok: false, reason: 'path-denied' };
    }
    fs.writeFileSync(abs, content, 'utf8');
    logLine(`file:write ${displayPath(abs, workspaceRoot)} (${bytes} bytes)`);
    return { ok: true, bytes, path: displayPath(abs, workspaceRoot) };
  } catch (err) {
    return { ok: false, reason: 'write-failed', detail: err.message };
  }
}

/** List a directory inside any active root (files + dirs, hidden + node_modules skipped). */
function listWorkspaceDir(dir, { workspaceRoot, activeRoots } = {}) {
  try {
    const abs = resolveInRoots(dir == null || dir === '' ? '.' : dir, { workspaceRoot, activeRoots });
    if (!abs) return { ok: false, reason: 'path-denied' };
    const real = fs.existsSync(abs) ? fs.realpathSync(abs) : abs;
    if (!withinActiveRoots(real, activeRoots)) return { ok: false, reason: 'path-denied' };
    const st = fs.statSync(real);
    if (!st.isDirectory()) return { ok: false, reason: 'not-a-directory' };
    const entries = fs
      .readdirSync(real, { withFileTypes: true })
      .filter((d) => !d.name.startsWith('.') && d.name !== 'node_modules')
      .map((d) => ({
        name: d.name,
        path: displayPath(path.join(real, d.name), workspaceRoot),
        type: d.isDirectory() ? 'dir' : 'file',
      }))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    return { ok: true, dir: displayPath(real, workspaceRoot), entries };
  } catch (err) {
    return { ok: false, reason: 'list-failed', detail: err.message };
  }
}

const GIT_BRANCH_TTL_MS = 5000;
const gitBranchCache = new Map();

function invalidateGitBranchCache(absDir) {
  if (typeof absDir === 'string' && absDir) gitBranchCache.delete(path.resolve(absDir));
  else gitBranchCache.clear();
}

function readGitBranch(startDir, { activeRoots } = {}) {
  let dir = startDir;
  for (let i = 0; i < 40; i++) {
    if (!withinActiveRoots(dir, activeRoots)) return null;
    const dotGit = path.join(dir, '.git');
    try {
      const st = fs.statSync(dotGit);
      let headPath;
      if (st.isDirectory()) {
        headPath = path.join(dotGit, 'HEAD');
      } else {
        const gitdir = fs.readFileSync(dotGit, 'utf8').trim().replace(/^gitdir:\s*/, '');
        headPath = path.join(path.isAbsolute(gitdir) ? gitdir : path.resolve(dir, gitdir), 'HEAD');
      }
      const head = fs.readFileSync(headPath, 'utf8').trim();
      const ref = head.match(/^ref: refs\/heads\/(.+)$/);
      return ref ? ref[1] : head.slice(0, 7);
    } catch {
      /* bu seviyede .git yok/okunamadı -> bir üst dizine */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

module.exports = {
  withinWorkspace,
  withinActiveRoots,
  resolveInRoots,
  resolveSearchRoot,
  displayPath,
  readWorkspaceFile,
  writeWorkspaceFile,
  listWorkspaceDir,
  GIT_BRANCH_TTL_MS,
  gitBranchCache,
  invalidateGitBranchCache,
  readGitBranch,
};
