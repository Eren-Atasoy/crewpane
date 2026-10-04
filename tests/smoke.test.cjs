'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');

test('Smoke: Next.js standalone distribution exists and has server.js', (t) => {
  const standaloneDir = path.join(ROOT_DIR, 'standalone');
  assert.ok(fs.existsSync(standaloneDir), 'standalone directory must exist');

  const serverJs = path.join(standaloneDir, 'server.js');
  assert.ok(fs.existsSync(serverJs), 'standalone/server.js must exist');

  const dotNext = path.join(standaloneDir, '.next');
  assert.ok(fs.existsSync(dotNext), 'standalone/.next directory must exist');
});

test('Smoke: Electron preload.js exists and is syntactically valid', (t) => {
  const preloadPath = path.join(ROOT_DIR, 'preload.js');
  assert.ok(fs.existsSync(preloadPath), 'preload.js must exist');

  // Verify syntax with node --check
  assert.doesNotThrow(() => {
    execFileSync(process.execPath, ['--check', preloadPath], { stdio: 'pipe' });
  }, 'preload.js should have valid JavaScript syntax');
});

test('Smoke: Electron main.js exists and is syntactically valid', (t) => {
  const mainPath = path.join(ROOT_DIR, 'main.js');
  assert.ok(fs.existsSync(mainPath), 'main.js must exist');

  // Verify syntax with node --check
  assert.doesNotThrow(() => {
    execFileSync(process.execPath, ['--check', mainPath], { stdio: 'pipe' });
  }, 'main.js should have valid JavaScript syntax');
});

test('Smoke: Renderer assets and fallback HTML are present', (t) => {
  const indexPath = path.join(ROOT_DIR, 'renderer', 'index.html');
  assert.ok(fs.existsSync(indexPath), 'renderer/index.html must exist');

  const content = fs.readFileSync(indexPath, 'utf8');
  assert.ok(content.includes('<html') || content.includes('<!DOCTYPE'), 'renderer/index.html should have HTML structure');
});
