'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { findUnresolvedRequires } = require('./helpers/requireGraph.cjs');

test('Architecture: All 12 domains export correctly through src/index.js', (t) => {
  const crewpane = require('../src');
  const expectedDomains = [
    'core',
    'config',
    'agents',
    'voice',
    'memory',
    'terminal',
    'mcp',
    'security',
    'hand',
    'mobile',
    'services',
    'ui'
  ];

  for (const domain of expectedDomains) {
    assert.ok(crewpane[domain], `Domain ${domain} should be exported by src/index.js`);
    assert.strictEqual(typeof crewpane[domain], 'object', `Domain ${domain} should be an object`);
  }
});

test('Architecture: every literal require() resolves with plain Node resolution (no resolver hook)', () => {
  const problems = findUnresolvedRequires();
  assert.deepStrictEqual(problems, [], `Unresolvable requires:\n${problems.join('\n')}`);
});

test('Architecture: legacy src/resolver.cjs monkey-patch is gone', () => {
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'src', 'resolver.cjs')), false);
  const { listSourceFiles, ROOT } = require('./helpers/requireGraph.cjs');
  const patched = listSourceFiles()
    .filter((f) => /_resolveFilename\s*=[^=]/.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(ROOT, f));
  assert.deepStrictEqual(patched, [], 'Module._resolveFilename must not be monkey-patched');
});

test('Architecture: critical modules live in their expected domains', () => {
  const src = path.join(__dirname, '..', 'src');
  const expected = {
    'voice/jarvisVoice.js': true,
    'agents/agentRunner.js': true,
    'security/seatGate.cjs': true,
    'config/devChannel.cjs': true,
    'terminal/paneControl.cjs': true,
    'core/singleInstanceLock.cjs': true,
    'core/helperWatchdog.cjs': true,
  };
  for (const rel of Object.keys(expected)) {
    assert.ok(fs.existsSync(path.join(src, rel)), `${rel} should exist`);
  }
});

test('Architecture: Root directory remains clean (no loose cjs/js files)', (t) => {
  const rootFiles = fs.readdirSync(path.join(__dirname, '..')).filter(f => {
    if (/^\.env.*\.local$/.test(f)) return false; // machine-local secrets, gitignored
    return fs.statSync(path.join(__dirname, '..', f)).isFile();
  });

  const allowedRootFiles = new Set([
    // Tooling / repo hygiene
    '.dependency-cruiser.cjs',
    '.editorconfig',
    '.env.example',
    '.env.local',
    '.gitattributes',
    '.gitignore',
    '.prettierignore',
    '.prettierrc',
    'eslint.config.cjs',
    'package-lock.json',
    // Project
    'ARCHITECTURE.md',
    'README.md',
    'bakedBuild.json',
    'devChannelTarget.json',
    'main.js',
    'package.json',
    'preload.js',
    'schema.sql',
    'start.bat'
  ]);

  for (const f of rootFiles) {
    assert.ok(
      allowedRootFiles.has(f),
      `Unexpected loose file in root directory: ${f}. All module files should be in src/<domain>/`
    );
  }
});
