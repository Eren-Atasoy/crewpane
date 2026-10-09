// CrewPane — TTS Providers Public API Aggregator.
'use strict';

const {
  TTS_PROVIDERS,
  TTS_ENGINE_IDS,
  TTS_PREVIEW_TEXT_TR,
  PRICING,
  COST_ASSUMPTIONS,
  ELEVEN_MODELS,
  ELEVEN_DEFAULT_MODEL,
  AZURE_DEFAULT_REGION,
  ASSUMPTIONS,
  FREE_ENGINE,
  SHIPPED_DEFAULT_ENGINE,
  ELEVEN_VOICES_URL_V1,
  ELEVEN_VOICES_URL_V2,
  ELEVEN_API_BASE,
  ELEVEN_AUTH_HINTS,
  BAD_KEY_FORMAT_HINT,
} = require('./constants.cjs');

const {
  freeEngineFor,
  estimateCost,
  resolveTtsEngine,
  isSupportedOn,
  hasKeyFor,
  pickVoiceFromSettings,
  fallbackNotice,
  resetNotices,
} = require('./costEngine.cjs');

const {
  escapeSsml,
  azureSsml,
  synthElevenLabs,
  synthAzure,
  synthesizeCloud,
  ttsConfig,
} = require('./synthCloud.cjs');

const {
  fetchElevenVoices,
  listElevenVoices,
  elevenVoicesStatus,
  normalizeElevenVoice,
  classifyTurkish,
  sortVoicesTurkishFirst,
} = require('./elevenVoices.cjs');

const {
  elevenApiBase,
  isLoopbackUrl,
  parseProviderError,
  elevenAuthHint,
  sanitizeApiKey,
  isHeaderSafeKey,
} = require('./elevenAuth.cjs');

module.exports = {
  TTS_PROVIDERS,
  TTS_ENGINE_IDS,
  TTS_PREVIEW_TEXT_TR,
  PRICING,
  COST_ASSUMPTIONS,
  ELEVEN_MODELS,
  ELEVEN_DEFAULT_MODEL,
  AZURE_DEFAULT_REGION,
  ASSUMPTIONS,
  FREE_ENGINE,
  freeEngineFor,
  SHIPPED_DEFAULT_ENGINE,
  estimateCost,
  resolveTtsEngine,
  isSupportedOn,
  hasKeyFor,
  pickVoiceFromSettings,
  fallbackNotice,
  resetNotices,
  escapeSsml,
  azureSsml,
  synthElevenLabs,
  synthAzure,
  synthesizeCloud,
  ttsConfig,
  fetchElevenVoices,
  listElevenVoices,
  elevenVoicesStatus,
  normalizeElevenVoice,
  classifyTurkish,
  sortVoicesTurkishFirst,
  ELEVEN_VOICES_URL_V1,
  ELEVEN_VOICES_URL_V2,
  ELEVEN_API_BASE,
  elevenApiBase,
  isLoopbackUrl,
  ELEVEN_AUTH_HINTS,
  BAD_KEY_FORMAT_HINT,
  parseProviderError,
  elevenAuthHint,
  sanitizeApiKey,
  isHeaderSafeKey,
};
