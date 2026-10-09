'use strict';

const ENGINE_REGISTRY = Object.freeze({
  claude: require('./claude.cjs'),
  codex: require('./codex.cjs'),
  copilot: require('./copilot.cjs'),
  goose: require('./goose.cjs'),
  droid: require('./droid.cjs'),
  gemini: require('./gemini.cjs'),
  qwen: require('./qwen.cjs'),
  opencode: require('./opencode.cjs'),
  amp: require('./amp.cjs'),
  cursor: require('./cursor.cjs'),
  kimi: require('./kimi.cjs'),
  crush: require('./crush.cjs'),
  antigravity: require('./antigravity.cjs'),
  muse: require('./muse.cjs'),
  jev: require('./jev.cjs'),
});

module.exports = {
  ENGINE_REGISTRY,
};
