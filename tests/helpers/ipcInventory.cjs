'use strict';

/**
 * IPC inventory — statically extracts every IPC channel the main process registers
 * and every bridge/channel the preload exposes or calls.
 *
 * Used by tests/characterization.test.cjs to freeze the IPC surface during refactors:
 * moving a handler from main.js into src/features/<x>/ipc.js must NOT change this list.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

// Directories whose files may register main-process IPC handlers.
const MAIN_SCAN_ROOTS = ['main.js', 'src', 'sync', 'telemetry', 'platform', 'packages'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'ui']); // src/ui holds the preload copy

function walk(entry, out) {
  const full = path.join(ROOT, entry);
  if (!fs.existsSync(full)) return out;
  const stat = fs.statSync(full);
  if (stat.isFile()) {
    if (/\.(c?js|mjs)$/.test(full)) out.push(full);
    return out;
  }
  for (const name of fs.readdirSync(full)) {
    if (SKIP_DIRS.has(name)) continue;
    walk(path.join(entry, name), out);
  }
  return out;
}

const CHANNEL = String.raw`['"\`]([A-Za-z0-9_.:\-/]+)['"\`]`;
const MAIN_RE = new RegExp(String.raw`ipcMain\.(handle|handleOnce|on|once)\(\s*` + CHANNEL, 'g');
const EXPOSE_RE = new RegExp(String.raw`exposeInMainWorld\(\s*` + CHANNEL, 'g');
const RENDERER_RE = new RegExp(String.raw`ipcRenderer\.(invoke|send|sendSync|on|once)\(\s*` + CHANNEL, 'g');

function collect(re, text, kindIndex) {
  const out = [];
  for (const m of text.matchAll(re)) out.push(kindIndex ? `${m[1]} ${m[2]}` : m[1]);
  return out;
}

function sortedUnique(list) {
  return [...new Set(list)].sort();
}

function mainChannels() {
  const files = MAIN_SCAN_ROOTS.flatMap((e) => walk(e, []));
  const out = [];
  for (const f of files) out.push(...collect(MAIN_RE, fs.readFileSync(f, 'utf8'), true));
  return sortedUnique(out);
}

function preloadSurface(preloadPath = path.join(ROOT, 'preload.js')) {
  const text = fs.readFileSync(preloadPath, 'utf8');
  return {
    bridges: sortedUnique(collect(EXPOSE_RE, text, false)),
    rendererCalls: sortedUnique(collect(RENDERER_RE, text, true)),
  };
}

function inventory() {
  return { main: mainChannels(), preload: preloadSurface() };
}

module.exports = { inventory, mainChannels, preloadSurface, ROOT };

if (require.main === module) {
  process.stdout.write(JSON.stringify(inventory(), null, 2) + '\n');
}
