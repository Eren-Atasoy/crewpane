'use strict';

// Static require-graph helper (Phase 1).
// Replaces the old runtime monkey-patch in src/resolver.cjs: every literal require()
// in first-party code must resolve with plain Node resolution.

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..', '..');
const SKIP = new Set(['node_modules', 'standalone', 'mobile-web', '.git', 'dist', 'out', '.next', 'app.asar.unpacked', 'scratch']);
const BUILTIN = new Set(Module.builtinModules);
const HOST_PROVIDED = new Set(['electron', 'original-fs']);
// Optional deps loaded inside try/catch (absence is a supported state).
const OPTIONAL = new Set(['@sentry/electron/main']);

function listSourceFiles(dir = ROOT, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listSourceFiles(p, out);
    else if (/\.(c?js)$/.test(e.name)) out.push(p);
  }
  return out;
}

function resolveFrom(request, fromFile) {
  try {
    const m = new Module(fromFile, null);
    m.filename = fromFile;
    m.paths = Module._nodeModulePaths(path.dirname(fromFile));
    return Module._resolveFilename(request, m, false);
  } catch {
    return null;
  }
}

const REQUIRE_RE = /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g;

function findUnresolvedRequires() {
  const problems = [];
  for (const file of listSourceFiles()) {
    const src = fs.readFileSync(file, 'utf8');
    let m;
    REQUIRE_RE.lastIndex = 0;
    while ((m = REQUIRE_RE.exec(src))) {
      const req = m[2];
      if (BUILTIN.has(req) || req.startsWith('node:') || HOST_PROVIDED.has(req) || OPTIONAL.has(req)) continue;
      if (!/^[.@a-z0-9_]/i.test(req)) continue; // e.g. text inside comments like require('…')
      if (resolveFrom(req, file)) continue;
      const line = src.slice(0, m.index).split('\n').length;
      problems.push(`${path.relative(ROOT, file)}:${line} → ${req}`);
    }
  }
  return problems;
}

module.exports = { ROOT, listSourceFiles, resolveFrom, findUnresolvedRequires };
