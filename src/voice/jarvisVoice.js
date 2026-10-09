// CrewPane — ADP-121 (ADR-009 Faz 120a) Jarvis voice core facade (MAIN side).
//
// Three capabilities, each a THIN wrapper over an existing local/remote facility
// (ADR-009 "reuse over rebuild"):
//   • STT   — OpenAI Whisper (whisper-1) & local whisper.cpp server.
//   • Brain — Claude orchestrator via `claude -p` (headless/session) → STRICT JSON
//             decision {action, department, objective, speak}. Falls back to a
//             deterministic Turkish intent parser when claude is unavailable.
//   • TTS   — macOS `say` (Yelda tr_TR, local/free) / OpenAI / ElevenLabs / Azure.
//
// Refactored in Phase 4.3 into modular submodules under `./jarvis/`:
//   • constants.cjs        - VAD timing thresholds, engine URLs & defaults
//   • envAuth.cjs          - .env.local & credential gate resolution
//   • stt.cjs              - Speech-to-text dispatch & transcription
//   • brainPrompt.cjs      - Master prompt templates & JSON extraction
//   • decisionNormalize.cjs- Action normalizers & schema validation
//   • intentPatterns.cjs   - Morphological stems, regexes & entity resolution
//   • intentParser.cjs     - Deterministic Turkish intent parser
//   • executorPolicy.cjs   - Fanout rules, gate priorities & prompt routing
//   • brainSession.cjs     - Claude one-shot & persistent session lifecycle
//   • decider.cjs          - Fast path decision & master decide pipeline
//   • audioProcess.cjs     - Process management & local say execution
//   • ttsDelivery.cjs      - Audio cache & multi-provider TTS delivery
//   • index.cjs            - Aggregator exporting all 78 symbols
//
// Main process requires this facade; units and characterization test suites
// exercise it directly.

'use strict';

module.exports = require('./jarvis/index.cjs');
