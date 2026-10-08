'use strict';

const { registerJarvisWidgetIpc } = require('./jarvisWidgetIpc.js');
const { registerGrokIpc } = require('./grokIpc.js');
const { registerJarvisVoiceIpc } = require('./jarvisVoiceIpc.js');
const { registerJarvisConvIpc } = require('./jarvisConvIpc.js');
const {
  createJarvisConversationService,
  JarvisConversationService,
} = require('./jarvisConversationService.js');

/**
 * Faz 3.5 — Sıra 10: Jarvis, JarvisWidget ve Grok IPC yüzeylerini topluca kaydeder.
 */
function registerVoiceIpc(deps) {
  registerJarvisWidgetIpc(deps);
  const grok = registerGrokIpc(deps);
  registerJarvisVoiceIpc(deps);
  registerJarvisConvIpc(deps);
  return { grok };
}

module.exports = {
  registerVoiceIpc,
  registerJarvisWidgetIpc,
  registerGrokIpc,
  registerJarvisVoiceIpc,
  registerJarvisConvIpc,
  createJarvisConversationService,
  JarvisConversationService,
};
