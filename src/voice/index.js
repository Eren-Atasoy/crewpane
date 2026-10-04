'use strict';
/**
 * CrewPane Domain: VOICE
 */
const path = require('node:path');

module.exports = {
  get dictationDelivery() { return require(path.join(__dirname, "dictationDelivery.cjs")); },
  get grokVoice() { return require(path.join(__dirname, "grokVoice.cjs")); },
  get groqResponsesShim() { return require(path.join(__dirname, "groqResponsesShim.cjs")); },
  get jarvisConversation() { return require(path.join(__dirname, "jarvisConversation.cjs")); },
  get jarvisVoice() { return require(path.join(__dirname, "jarvisVoice.js")); },
  get jarvisWidget() { return require(path.join(__dirname, "jarvisWidget.cjs")); },
  get sttHallucinationGuard() { return require(path.join(__dirname, "sttHallucinationGuard.cjs")); },
  get sttSilenceGate() { return require(path.join(__dirname, "sttSilenceGate.cjs")); },
  get ttsMute() { return require(path.join(__dirname, "ttsMute.cjs")); },
  get ttsProviders() { return require(path.join(__dirname, "ttsProviders.cjs")); },
  get ttsStream() { return require(path.join(__dirname, "ttsStream.cjs")); },
  get turkishMorph() { return require(path.join(__dirname, "turkishMorph.cjs")); },
  get voiceName() { return require(path.join(__dirname, "voiceName.cjs")); },
  get whisperLocal() { return require(path.join(__dirname, "whisperLocal.cjs")); },
};
