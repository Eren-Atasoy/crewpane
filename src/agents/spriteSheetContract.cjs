'use strict';
// OFV-03 — pure contract shared by main validation, picker and Phaser.
const DIRECTIONS = ['down', 'left', 'right', 'up'];
const ACTIONS = ['idle', 'walk', 'sit', 'greet'];
const MAX_PIXELS = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 32 * 1024;
const ownKeysOnly = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(k => keys.includes(k));
const integer = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;

function resolveSpriteSheet(width, height, manifest) {
  const bad = error => ({ ok: false, error });
  if (!integer(width, 1, 8192) || !integer(height, 1, 8192) || width * height > MAX_PIXELS) {
    return bad('Sprite image dimensions exceed the supported pixel limit');
  }
  let frameWidth, frameHeight, anchor, animations, legacy;
  if (manifest === undefined) {
    if (width % 3 || height % 4 || width / 3 < 16 || height / 4 < 16) {
      return bad('Legacy sprite must contain a 3x4 grid with frames at least 16px per side');
    }
    legacy = true; frameWidth = width / 3; frameHeight = height / 4;
    anchor = { x: 0.5, y: 0.5 };
    animations = DIRECTIONS.flatMap((direction, row) => [
      { name: 'idle', direction, frameIndices: [row * 3 + 1], durationMs: 1000 / 6 },
      { name: 'walk', direction, frameIndices: [row * 3, row * 3 + 1, row * 3 + 2, row * 3 + 1], durationMs: 1000 / 6 },
    ]);
  } else {
    if (!ownKeysOnly(manifest, ['version', 'frameWidth', 'frameHeight', 'anchor', 'animations']) || manifest.version !== 1) {
      return bad('Unsupported sprite metadata version or fields');
    }
    ({ frameWidth, frameHeight, anchor, animations } = manifest);
    if (!integer(frameWidth, 1, 2048) || !integer(frameHeight, 1, 2048)
      || width % frameWidth || height % frameHeight) return bad('Sprite frames must fit the image grid exactly');
    if (!ownKeysOnly(anchor, ['x', 'y']) || ![anchor.x, anchor.y].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)) {
      return bad('Sprite anchor must be within the frame');
    }
    const frameCount = width / frameWidth * (height / frameHeight);
    if (frameCount > 4096 || !Array.isArray(animations) || animations.length < 1 || animations.length > 16) {
      return bad('Sprite animation or frame count is outside the supported limit');
    }
    const seen = new Set();
    for (const a of animations) {
      if (!ownKeysOnly(a, ['name', 'direction', 'frameIndices', 'durationMs'])
        || !ACTIONS.includes(a.name) || !DIRECTIONS.includes(a.direction)) return bad('Unknown sprite action or direction');
      const id = `${a.name}/${a.direction}`;
      if (seen.has(id)) return bad('Duplicate sprite action and direction');
      seen.add(id);
      if (!Array.isArray(a.frameIndices) || a.frameIndices.length < 1 || a.frameIndices.length > 120
        || !a.frameIndices.every(i => integer(i, 0, frameCount - 1))) return bad('Sprite animation references a missing frame');
      if (typeof a.durationMs !== 'number' || !Number.isFinite(a.durationMs) || a.durationMs < 16 || a.durationMs > 10000) {
        return bad('Sprite frame duration must be between 16 and 10000 milliseconds');
      }
    }
    if (!seen.has('idle/down')) return bad('Sprite must declare an idle/down frame');
    legacy = false;
    anchor = { x: anchor.x, y: anchor.y };
    animations = animations.map(a => ({ name: a.name, direction: a.direction, frameIndices: [...a.frameIndices], durationMs: a.durationMs }));
  }
  return { ok: true, layout: { version: 1, legacy, width, height, frameWidth, frameHeight, columns: width / frameWidth, rows: height / frameHeight, anchor, animations } };
}

function animationFor(layout, name, direction = 'down') {
  return layout.animations.find(a => a.name === name && a.direction === direction)
    ?? layout.animations.find(a => a.name === 'idle' && a.direction === 'down');
}

function frameRect(layout, index) {
  if (!integer(index, 0, layout.columns * layout.rows - 1)) throw new RangeError('Sprite frame index outside atlas');
  return { x: (index % layout.columns) * layout.frameWidth, y: Math.floor(index / layout.columns) * layout.frameHeight, width: layout.frameWidth, height: layout.frameHeight };
}

function pngDimensions(bytes) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!bytes || bytes.length < 33 || !sig.every((v, i) => bytes[i] === v)
    || bytes[12] !== 73 || bytes[13] !== 72 || bytes[14] !== 68 || bytes[15] !== 82) return null;
  const n = offset => (bytes[offset] * 0x1000000 + bytes[offset + 1] * 0x10000 + bytes[offset + 2] * 0x100 + bytes[offset + 3]);
  return { width: n(16), height: n(20) };
}

module.exports = { DIRECTIONS, ACTIONS, MAX_PIXELS, MAX_MANIFEST_BYTES, resolveSpriteSheet, animationFor, frameRect, pngDimensions };
