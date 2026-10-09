# Refactoring Map: `src/voice/ttsProviders.cjs` (Phase 4.9)

## Overview
`src/voice/ttsProviders.cjs` (1,225 lines, 42 exports) provides the Text-To-Speech (TTS) provider layer, pricing and cost estimation, ElevenLabs and Azure synthesis, dynamic voice discovery and Turkish prosody filtering, fail-safe fallbacks, and user settings configuration.

This refactoring decomposes `ttsProviders.cjs` into 6 modular submodules under `src/voice/tts/`, ensuring all files are ≤ 300 lines while preserving 100% export, contract, and behavioral parity.

## Target Structure

```
src/voice/
├── ttsProviders.cjs         (thin facade forwarding to ./tts/index.cjs)
└── tts/
    ├── constants.cjs        (TTS_PROVIDERS, PRICING, ELEVEN_MODELS, URLs, hints, limits)
    ├── elevenAuth.cjs       (elevenApiBase, sanitizeApiKey, isHeaderSafeKey, parseProviderError, elevenAuthHint)
    ├── elevenVoices.cjs     (classifyTurkish, normalizeElevenVoice, sortVoicesTurkishFirst, fetchElevenVoices, listElevenVoices, elevenVoicesStatus)
    ├── costEngine.cjs       (estimateCost, resolveTtsEngine, isSupportedOn, freeEngineFor, hasKeyFor, pickVoiceFromSettings, fallbackNotice, resetNotices)
    ├── synthCloud.cjs       (escapeSsml, azureSsml, synthElevenLabs, synthAzure, synthesizeCloud, ttsConfig)
    └── index.cjs            (public API aggregator, 42 exported symbols)
```

## Public API Contract (42 Exports)
- Constants & Descriptions: `TTS_PROVIDERS`, `TTS_ENGINE_IDS`, `TTS_PREVIEW_TEXT_TR`, `PRICING`, `COST_ASSUMPTIONS`, `ELEVEN_MODELS`, `ELEVEN_DEFAULT_MODEL`, `AZURE_DEFAULT_REGION`, `ASSUMPTIONS`, `FREE_ENGINE`, `SHIPPED_DEFAULT_ENGINE`, `ELEVEN_VOICES_URL_V1`, `ELEVEN_VOICES_URL_V2`, `ELEVEN_API_BASE`, `ELEVEN_AUTH_HINTS`, `BAD_KEY_FORMAT_HINT`
- Engine Resolution & Costs: `estimateCost`, `resolveTtsEngine`, `isSupportedOn`, `freeEngineFor`, `hasKeyFor`, `pickVoiceFromSettings`, `fallbackNotice`, `resetNotices`
- ElevenLabs Auth & API: `elevenApiBase`, `isLoopbackUrl`, `parseProviderError`, `elevenAuthHint`, `sanitizeApiKey`, `isHeaderSafeKey`
- Voice Discovery & Turkish Prosody: `classifyTurkish`, `normalizeElevenVoice`, `sortVoicesTurkishFirst`, `fetchElevenVoices`, `listElevenVoices`, `elevenVoicesStatus`
- Cloud Synthesis & Config: `escapeSsml`, `azureSsml`, `synthElevenLabs`, `synthAzure`, `synthesizeCloud`, `ttsConfig`

## Verification
- Unit test in `tests/units.test.cjs` asserting 42/42 exports and contracts.
- Full test suite execution (`npm test`).
- ESLint verification (`npx eslint . --quiet`).
