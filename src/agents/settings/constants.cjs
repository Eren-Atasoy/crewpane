// CrewPane — Agent Settings constants and default settings factory.
'use strict';

const handOverlayContract = require('../../hand/handOverlayContract.cjs');
const teamCompose = require('../teamCompose.cjs');

// The key codes the renderer's keydown handler matches against (event.code).
const PUSH_TO_TALK_KEYS = ['MetaRight', 'ControlRight', 'MetaLeft', 'AltRight'];
const DEFAULT_PUSH_TO_TALK_KEY = 'MetaRight'; // right ⌘

const LEGACY_PINNED_TTS_MODEL = 'tts-1-hd';

const THEME_MODES = ['dark', 'light', 'system'];
const THEME_ACCENT_RE = /^#[0-9a-fA-F]{6}$/;
const THEME_PRESET_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

const TERMINAL_FONT_SCALES = ['small', 'medium', 'large'];

const MAX_TRUST_RULES = 200;
const MAX_TRUST_RULE_LEN = 200;

const MAX_READ_ENTRIES = 200;

const DENIED_CODES = new Set(['EPERM', 'EACCES']);

const VENDOR_HOSTED_POLICIES = Object.freeze(['allow', 'block']);

function defaults() {
  return {
    workspaceRoot: null,
    knownWorkspaces: [],
    departmentDirs: null,
    projectRepos: null,
    projectIsolation: null,
    codeIndex: null,
    apiKeys: {},
    customProvider: null,
    handControl: {
      overlay: { ...handOverlayContract.DEFAULT_HAND_CONTROL.overlay },
      camera: { ...handOverlayContract.DEFAULT_HAND_CONTROL.camera },
      zoom: { ...handOverlayContract.DEFAULT_HAND_CONTROL.zoom },
      tuning: { ...handOverlayContract.DEFAULT_HAND_CONTROL.tuning },
    },
    notifications: {
      toast: { workerDone: false, delegationDone: true, approval: true, error: true, limit: true },
    },
    keepExitedPanes: false,
    autoModelByTaskClass: false,
    jev: {
      mode: 'suggest',
      policy: 'balanced',
    },
    leaderAutoRefresh: 'warn',
    cloudSyncEnabled: false,
    prefsSyncEnabled: true,
    telemetryEnabled: true,
    telemetryNoticeShown: false,
    telemetryState: { installId: null, sessions: 0, daysSeen: 0, lastDay: null, counters: {} },
    updateAutoCheck: true,
    updateDismissedVersion: null,
    foreignHookNoticeDismissed: false,
    productTourDone: false,
    onboardingGuideDone: false,
    announcementsRead: {},
    updateChannel: 'auto',
    paneZoomShortcut: null,
    paneMoveShortcut: null,
    terminalFontScale: 'medium',
    locale: 'system',
    voiceLocale: 'follow-ui',
    pushToTalkKey: DEFAULT_PUSH_TO_TALK_KEY,
    wakeModelPath: null,
    mcpServers: {},
    theme: null,
    browserTrust: { mode: 'normal', trustedOrigins: [], blockedOrigins: [] },
    teamCompose: { autonomy: teamCompose.DEFAULT_AUTONOMY },
    memorySearch: { semanticConsent: null, semanticEnabled: true, autoIndex: true, sessionsIndexed: true },
    engines: {},
    resourceGovernor: { enabled: false, warnFreePct: 1, criticalFreePct: 0 },
    jarvis: {
      ttsEngine: 'openai',
      ttsVoice: 'nova',
      view: null,
      ttsModel: null,
      silenceMs: null,
      endpointMaxMs: null,
      sleepAfterMs: null,
      noSpeechMs: null,
      silentSleep: false,
      wakeLegacy: false,
      sttEngine: null,
      whisperModelPath: null,
      silenceGate: {
        rmsThreshold: null,
        minSpeechMs: null,
        loudFloor: null,
        minDynamicDb: null,
        draftMinDynamicDb: null,
      },
      voiceMode: null,
      grokModel: null,
      grokVoice: null,
      elevenModel: null,
      elevenVoiceId: null,
      elevenVoiceName: null,
      azureRegion: null,
      azureVoice: null,
    },
  };
}

module.exports = {
  PUSH_TO_TALK_KEYS,
  DEFAULT_PUSH_TO_TALK_KEY,
  LEGACY_PINNED_TTS_MODEL,
  THEME_MODES,
  THEME_ACCENT_RE,
  THEME_PRESET_RE,
  TERMINAL_FONT_SCALES,
  MAX_TRUST_RULES,
  MAX_TRUST_RULE_LEN,
  MAX_READ_ENTRIES,
  DENIED_CODES,
  VENDOR_HOSTED_POLICIES,
  defaults,
};
