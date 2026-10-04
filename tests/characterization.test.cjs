'use strict';

/**
 * Characterization tests — freeze observable contracts BEFORE refactoring.
 *
 * These tests do not judge whether behavior is correct; they detect whether it CHANGED.
 * If a change is intentional, regenerate snapshots:
 *   UPDATE_SNAPSHOTS=1 npm test          (PowerShell: $env:UPDATE_SNAPSHOTS=1; npm test)
 * and review the snapshot diff in the same commit.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');


const { inventory, preloadSurface, ROOT } = require('./helpers/ipcInventory.cjs');

const SNAP_DIR = path.join(__dirname, '__snapshots__');
const UPDATE = process.env.UPDATE_SNAPSHOTS === '1';

function matchSnapshot(name, value) {
  const file = path.join(SNAP_DIR, `${name}.json`);
  const serialized = JSON.stringify(value, null, 2) + '\n';
  if (UPDATE || !fs.existsSync(file)) {
    fs.mkdirSync(SNAP_DIR, { recursive: true });
    fs.writeFileSync(file, serialized);
    return;
  }
  const expected = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  assert.equal(serialized, expected, `Snapshot "${name}" changed. If intentional, rerun with UPDATE_SNAPSHOTS=1.`);
}

/** Stable serializer: functions → source, RegExp → string, keys sorted. */
function stable(value, seen = new WeakSet()) {
  if (typeof value === 'function') return `[fn] ${value.toString()}`;
  if (value instanceof RegExp) return `[re] ${value.toString()}`;
  if (value === undefined) return '[undefined]';
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => stable(v, seen));
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = stable(value[key], seen);
  return out;
}

test('Characterization: IPC surface (main handlers + preload bridges) is unchanged', () => {
  matchSnapshot('ipc-surface', inventory());
});

test('Characterization: bundled preload exposes 65 bridges and valid surface', () => {
  const bundled = preloadSurface(path.join(ROOT, 'dist', 'preload.js'));
  assert.equal(bundled.bridges.length, 65);
});

test('Characterization: every preload invoke/send channel has a main-process handler', () => {
  const inv = inventory();
  const handled = new Set(inv.main.map((e) => e.split(' ')[1]));
  const outbound = inv.preload.rendererCalls
    .filter((e) => /^(invoke|send|sendSync) /.test(e))
    .map((e) => e.split(' ')[1]);
  const orphans = outbound.filter((ch) => !handled.has(ch));
  // Orphans are frozen too: a NEW orphan means a bridge points at a missing handler.
  matchSnapshot('ipc-orphans', orphans);
});

test('Characterization: ENGINE_REGISTRY descriptors are unchanged', () => {
  const { ENGINE_REGISTRY } = require('../src/agents/engineRegistry.cjs');
  assert.ok(ENGINE_REGISTRY && typeof ENGINE_REGISTRY === 'object', 'ENGINE_REGISTRY must be exported');
  matchSnapshot('engine-registry', stable(ENGINE_REGISTRY));
});
