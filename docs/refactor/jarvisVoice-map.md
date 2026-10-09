# JarvisVoice Decomposition Map (Phase 4.3)

## Objective
Decompose `src/voice/jarvisVoice.js` (3,370 lines, 78 exports) into cohesive submodules under `src/voice/jarvis/`, keeping every file ≤ 800 lines (soft ≤ 400 lines) and preserving 100% contract parity, zero behavioral regression, and green tests.

## Target Submodule Structure (`src/voice/jarvis/`)

1. **`constants.cjs`** (~150 lines)
   - VAD timing thresholds (`DEFAULT_SILENCE_MS`, `MIN_SILENCE_MS`, `MAX_SILENCE_MS`, `DEFAULT_ENDPOINT_MAX_MS`, `DEFAULT_SLEEP_AFTER_MS`, `MIN_SLEEP_AFTER_MS`, `MAX_SLEEP_AFTER_MS`, `DEFAULT_NO_SPEECH_MS`, `MIN_NO_SPEECH_MS`, `MAX_NO_SPEECH_MS`).
   - Normalizers: `normalizeSilenceMs`, `normalizeEndpointMaxMs`, `normalizeSleepAfterMs`, `normalizeNoSpeechMs`.
   - Engine URLs & defaults: `OPENAI_TRANSCRIBE_URL`, `OPENAI_TTS_URL`, `WHISPER_MODEL`, `SAY_VOICE`, `CLAUDE_TIMEOUT_MS`.
   - Voice configuration: `TTS_VOICES`, `DEFAULT_TTS_VOICE`, `DEFAULT_TTS_MODEL`, `TTS_PREVIEW_TEXT`.

2. **`envAuth.cjs`** (~70 lines)
   - `.env.local` parser & credential gate wrappers:
   - `parseEnvFile`, `loadEnvLocal`, `openAiKey`, `openAiKeyMissingMessage`, `openAiKeySettingsTarget`.

3. **`stt.cjs`** (~270 lines)
   - Audio file mime/extension mapping: `extForMime`, `resolveExt`.
   - STT error messages & formatting: `sttErrorMessage`, `withUserMessage`, `dumpAudioForDebug`.
   - Vocabulary hinting: `buildVocabPrompt`.
   - Silence / hallucination detection: `isHallucinatedSilence`.
   - Whisper & local dispatch: `transcribeWhisper`, `resolveSttEngine`, `DEFAULT_STT_ENGINE`, `transcribeSpeech`.

4. **`brainPrompt.cjs`** (~180 lines)
   - Master prompt text: `ORCH_SYSTEM`, `BRAIN_TERSE_RULE`.
   - System & turn message builders: `buildBrainSystemPrompt`, `buildBrainTurnMessage`, `buildBrainPrompt`.
   - JSON extraction & envelope parsing: `extractJsonObject`, `parseClaudeDecision`.

5. **`decisionNormalize.cjs`** (~370 lines)
   - Valid actions & op registries: `JARVIS_ACTIONS`, `TERMINAL_OPS`, `BROWSER_OPS`, `NAVIGATE_OPS`, `INPUT_OPS`, `BOARD_OPS`, `SPRINT_OPS`, `SETTINGS_OPS`, `MEMORY_OPS`, `REPORT_OPS`, `AGENT_OPS`, `SCREEN_OPS`, `OFFICE_OPS`, `BOARD_STATUSES`.
   - Normalizers: `str`, `reply`, `normalizeInputDecision`, `normalizeBoardDecision`, `normalizeBrowserDecision`, `normalizeNavigateDecision`, `normalizeDecision`.

6. **`intentPatterns.cjs`** (~290 lines)
   - Morphological helper wrappers: `hasV`, `negV`.
   - Theme base detection: `THEME_BASE_PRESET`, `themeBaseRe`, `detectThemeBase`.
   - Intent regexes for Turkish & English cues.
   - Entities & department resolution: `detectAgentName`, `normalizeBoardStatusWord`, `detectDepartment`, `departmentLabel`.

7. **`intentParser.cjs`** (~580 lines)
   - Deterministic Turkish intent parser: `parseIntent`.

8. **`executorPolicy.cjs`** (~330 lines)
   - Rule priority gates: `applyRulePriorityGates`.
   - Fanout & approval executor policy: `applyExecutorPolicy`, `echoTarget`, `routePromptClass`, `applyExecutorPolicyInner`.

9. **`brainSession.cjs`** (~180 lines)
   - One-shot Claude execution: `decideWithClaude`.
   - Persistent Claude brain session lifecycle: `brainSession`, `warmupBrain`, `stopBrain`, `brainStats`, `killBrainForTest`, `decideWithSession`.

10. **`decider.cjs`** (~140 lines)
    - Fast path & orchestration: `fastLocalDecision`, `fastPathEnabled`, `decide`.

11. **`audioProcess.cjs`** (~280 lines)
    - Child audio processes & zombie cleanup: `_installExitHooksOnce`, `trackLocalAudioChild`, `untrackLocalAudioChild`, `killLocalAudioChildren`, `liveLocalAudioChildren`, `sweepOrphanSayProcesses`.
    - Local macOS say: `queueSayRender`, `speakSay`, `SAY_TIMEOUT_MS`.

12. **`ttsDelivery.cjs`** (~420 lines)
    - Audio cache: `ttsCacheDir`, `ttsCacheFile`, `readTtsCache`, `writeTtsCache`, `TTS_CACHE_MAX_CHARS`.
    - Synthesis & playback: `speakOpenAI`, `deliverAudioBuffer`, `speakWithSettings`, `speakStreamWithSettings`, `ttsPreview`, `stopPlayback`.

13. **`index.cjs`** (~160 lines)
    - Re-exports all 78 symbols to form the identical public contract.
