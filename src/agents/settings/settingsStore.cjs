// CrewPane — Agent Settings persistent store, caching, and atomic persistence.
'use strict';

const fs = require('fs');
const path = require('path');
const instancePaths = require('../../config/instancePaths.cjs');
const codeIndex = require('../../services/codeIndex.cjs');
const updateChannel = require('../../services/updateChannel.cjs');
const teamScope = require('../teamScope.cjs');
const settingsMigrations = require('../../services/settingsMigrations.cjs');
const leaderRefreshPolicy = require('../leaderRefreshPolicy.cjs');
const handOverlayContract = require('../../hand/handOverlayContract.cjs');
const customProvider = require('../../services/customProvider.cjs');
const { atomicWriteFileSync } = require('../../../platform/atomicWrite.cjs');

const {
  defaults,
  PUSH_TO_TALK_KEYS,
  DEFAULT_PUSH_TO_TALK_KEY,
  LEGACY_PINNED_TTS_MODEL,
} = require('./constants.cjs');

const {
  sanitizeDepartmentDirs,
  sanitizeProjectIsolation,
  sanitizeTheme,
  sanitizeTerminalFontScale,
  sanitizeLocale,
  sanitizeVoiceLocale,
  sanitizePaneMoveShortcut,
  sanitizePaneZoomShortcut,
  sanitizeBrowserTrust,
  sanitizeTeamCompose,
  sanitizeMemorySearch,
  sanitizeEngines,
  mergeEngines,
  sanitizeResourceGovernor,
  sanitizeAnnouncementsRead,
  sanitizeTelemetryState,
  sanitizeJev,
} = require('./sanitizers.cjs');

let _lastPersist = { ok: true, code: null, reason: 'no-write-yet', inPlace: false, file: null };
let _persistLogger = null;
let _cache = null;

function settingsDir() {
  return instancePaths.crewpaneHome();
}

function settingsPath() {
  return path.join(settingsDir(), 'settings.json');
}

/** Read settings (cached). A missing/corrupt file → defaults. Never throws. */
function readSettings() {
  if (_cache) return _cache;
  const out = defaults();
  try {
    settingsMigrations.migrateSettingsFile({ file: settingsPath() });
  } catch {
    /* temizlik asla ayar okumayı düşüremez */
  }
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    if (raw && typeof raw === 'object') {
      if (typeof raw.workspaceRoot === 'string' && raw.workspaceRoot) out.workspaceRoot = raw.workspaceRoot;
      if (Array.isArray(raw.knownWorkspaces)) {
        out.knownWorkspaces = raw.knownWorkspaces.filter((r) => typeof r === 'string' && r.trim());
      }
      if ('departmentDirs' in raw) out.departmentDirs = sanitizeDepartmentDirs(raw.departmentDirs);
      if ('projectRepos' in raw) out.projectRepos = sanitizeDepartmentDirs(raw.projectRepos);
      if ('projectIsolation' in raw) out.projectIsolation = sanitizeProjectIsolation(raw.projectIsolation);
      if ('codeIndex' in raw) out.codeIndex = codeIndex.sanitizeCodeIndex(raw.codeIndex);
      if (raw.apiKeys && typeof raw.apiKeys === 'object') {
        out.apiKeys = { ...raw.apiKeys };
      }
      if ('customProvider' in raw) {
        out.customProvider = customProvider.customProviderOrNull(raw.customProvider);
      }
      if (typeof raw.pushToTalkKey === 'string' && PUSH_TO_TALK_KEYS.includes(raw.pushToTalkKey)) {
        out.pushToTalkKey = raw.pushToTalkKey;
      }
      if (typeof raw.wakeModelPath === 'string' && raw.wakeModelPath) out.wakeModelPath = raw.wakeModelPath;
      if (typeof raw.keepExitedPanes === 'boolean') out.keepExitedPanes = raw.keepExitedPanes;
      if (typeof raw.autoModelByTaskClass === 'boolean') out.autoModelByTaskClass = raw.autoModelByTaskClass;
      if ('jev' in raw) out.jev = sanitizeJev(raw.jev);
      if (typeof raw.leaderAutoRefresh === 'string') {
        out.leaderAutoRefresh = leaderRefreshPolicy.normalizeMode(raw.leaderAutoRefresh);
      }
      if (typeof raw.cloudSyncEnabled === 'boolean') out.cloudSyncEnabled = raw.cloudSyncEnabled;
      if (typeof raw.prefsSyncEnabled === 'boolean') out.prefsSyncEnabled = raw.prefsSyncEnabled;
      if (typeof raw.telemetryEnabled === 'boolean') out.telemetryEnabled = raw.telemetryEnabled;
      if (typeof raw.telemetryNoticeShown === 'boolean') out.telemetryNoticeShown = raw.telemetryNoticeShown;
      if ('telemetryState' in raw) out.telemetryState = sanitizeTelemetryState(raw.telemetryState);
      if ('paneZoomShortcut' in raw) out.paneZoomShortcut = sanitizePaneZoomShortcut(raw.paneZoomShortcut);
      if ('paneMoveShortcut' in raw) out.paneMoveShortcut = sanitizePaneMoveShortcut(raw.paneMoveShortcut);
      if ('terminalFontScale' in raw) out.terminalFontScale = sanitizeTerminalFontScale(raw.terminalFontScale);
      if ('locale' in raw) out.locale = sanitizeLocale(raw.locale);
      if ('voiceLocale' in raw) out.voiceLocale = sanitizeVoiceLocale(raw.voiceLocale);
      if (typeof raw.updateAutoCheck === 'boolean') out.updateAutoCheck = raw.updateAutoCheck;
      if (typeof raw.updateDismissedVersion === 'string' && raw.updateDismissedVersion) {
        out.updateDismissedVersion = raw.updateDismissedVersion;
      }
      if (typeof raw.foreignHookNoticeDismissed === 'boolean') {
        out.foreignHookNoticeDismissed = raw.foreignHookNoticeDismissed;
      }
      if (typeof raw.productTourDone === 'boolean') out.productTourDone = raw.productTourDone;
      if (typeof raw.onboardingGuideDone === 'boolean') out.onboardingGuideDone = raw.onboardingGuideDone;
      if (typeof raw.updateChannel === 'string') out.updateChannel = raw.updateChannel;
      if ('announcementsRead' in raw) out.announcementsRead = sanitizeAnnouncementsRead(raw.announcementsRead);
      if (raw.mcpServers && typeof raw.mcpServers === 'object') out.mcpServers = { ...raw.mcpServers };
      if ('theme' in raw) out.theme = sanitizeTheme(raw.theme);
      if ('browserTrust' in raw) out.browserTrust = sanitizeBrowserTrust(raw.browserTrust);
      if ('teamScope' in raw) out.teamScope = teamScope.sanitizeTeamScope(raw.teamScope);
      if ('teamCompose' in raw) out.teamCompose = sanitizeTeamCompose(raw.teamCompose);
      if ('memorySearch' in raw) out.memorySearch = sanitizeMemorySearch(raw.memorySearch);
      if ('engines' in raw) out.engines = sanitizeEngines(raw.engines);
      if ('resourceGovernor' in raw) out.resourceGovernor = sanitizeResourceGovernor(raw.resourceGovernor);
      if (raw.jarvis && typeof raw.jarvis === 'object') out.jarvis = { ...out.jarvis, ...raw.jarvis };
      if (out.jarvis && out.jarvis.ttsModel === LEGACY_PINNED_TTS_MODEL) delete out.jarvis.ttsModel;
      if ('handControl' in raw) out.handControl = handOverlayContract.sanitizeHandControl(raw.handControl);
      if (raw.notifications && typeof raw.notifications === 'object') {
        out.notifications = {
          ...out.notifications,
          ...raw.notifications,
          toast: { ...out.notifications.toast, ...(raw.notifications.toast || {}) },
        };
      }
    }
  } catch {
    /* no file yet / bad JSON → defaults */
  }
  settingsMigrations.purgeRemovedKeys(out);
  _cache = out;
  return out;
}

/**
 * Merge `patch` into settings, persist, bust the cache. Returns the new settings.
 */
function writeSettings(patch, opts) {
  const cur = readSettings();
  const next = {
    ...cur,
    ...patch,
    apiKeys: { ...cur.apiKeys, ...(patch && patch.apiKeys) },
    customProvider: patch && 'customProvider' in patch
      ? customProvider.customProviderOrNull(patch.customProvider)
      : cur.customProvider,
    mcpServers: { ...cur.mcpServers, ...(patch && patch.mcpServers) },
    jarvis: { ...cur.jarvis, ...(patch && patch.jarvis) },
    memorySearch: { ...cur.memorySearch, ...(patch && patch.memorySearch) },
    engines: sanitizeEngines(mergeEngines(cur.engines, patch && patch.engines)),
    resourceGovernor: sanitizeResourceGovernor({ ...cur.resourceGovernor, ...(patch && patch.resourceGovernor) }),
    notifications: {
      ...cur.notifications,
      ...(patch && patch.notifications),
      toast: { ...cur.notifications.toast, ...(patch && patch.notifications && patch.notifications.toast) },
    },
    handControl: handOverlayContract.sanitizeHandControl({
      overlay: {
        ...(cur.handControl && cur.handControl.overlay),
        ...(patch && patch.handControl && patch.handControl.overlay),
      },
      camera: {
        ...(cur.handControl && cur.handControl.camera),
        ...(patch && patch.handControl && patch.handControl.camera),
      },
      zoom: {
        ...(cur.handControl && cur.handControl.zoom),
        ...(patch && patch.handControl && patch.handControl.zoom),
      },
      tuning: {
        ...(cur.handControl && cur.handControl.tuning),
        ...(patch && patch.handControl && patch.handControl.tuning),
      },
    }),
  };

  settingsMigrations.purgeRemovedKeys(next);
  if (!PUSH_TO_TALK_KEYS.includes(next.pushToTalkKey)) next.pushToTalkKey = DEFAULT_PUSH_TO_TALK_KEY;
  next.keepExitedPanes = next.keepExitedPanes === true;
  next.autoModelByTaskClass = next.autoModelByTaskClass === true;
  next.leaderAutoRefresh = leaderRefreshPolicy.normalizeMode(next.leaderAutoRefresh);
  next.cloudSyncEnabled = next.cloudSyncEnabled === true;
  next.prefsSyncEnabled = next.prefsSyncEnabled !== false;
  next.knownWorkspaces = Array.isArray(next.knownWorkspaces)
    ? next.knownWorkspaces.filter((r) => typeof r === 'string' && r.trim())
    : [];
  next.productTourDone = next.productTourDone === true;
  next.onboardingGuideDone = next.onboardingGuideDone === true;
  if (next.jarvis) {
    next.jarvis.view = next.jarvis.view === 'mini' || next.jarvis.view === 'panel' ? next.jarvis.view : null;
    next.jarvis.silentSleep = next.jarvis.silentSleep === true;
    next.jarvis.wakeLegacy = next.jarvis.wakeLegacy === true;
  }
  next.paneZoomShortcut = sanitizePaneZoomShortcut(next.paneZoomShortcut);
  next.paneMoveShortcut = sanitizePaneMoveShortcut(next.paneMoveShortcut);
  next.terminalFontScale = sanitizeTerminalFontScale(next.terminalFontScale);
  next.locale = sanitizeLocale(next.locale);
  next.voiceLocale = sanitizeVoiceLocale(next.voiceLocale);
  next.updateAutoCheck = next.updateAutoCheck !== false;
  next.foreignHookNoticeDismissed = next.foreignHookNoticeDismissed === true;
  next.updateDismissedVersion =
    typeof next.updateDismissedVersion === 'string' && next.updateDismissedVersion
      ? next.updateDismissedVersion
      : null;
  next.updateChannel = updateChannel.normalizeChannel(next.updateChannel) || 'auto';
  if (patch && 'departmentDirs' in patch) next.departmentDirs = sanitizeDepartmentDirs(patch.departmentDirs);
  if (patch && 'projectRepos' in patch) next.projectRepos = sanitizeDepartmentDirs(patch.projectRepos);
  if (patch && 'projectIsolation' in patch) next.projectIsolation = sanitizeProjectIsolation(patch.projectIsolation);
  if (patch && 'codeIndex' in patch) next.codeIndex = codeIndex.sanitizeCodeIndex(patch.codeIndex);
  if (patch && 'theme' in patch) next.theme = sanitizeTheme(patch.theme);
  next.browserTrust = sanitizeBrowserTrust(
    patch && 'browserTrust' in patch ? patch.browserTrust : cur.browserTrust,
  );
  next.teamScope = teamScope.sanitizeTeamScope(
    patch && 'teamScope' in patch ? patch.teamScope : cur.teamScope,
  );
  next.teamCompose = sanitizeTeamCompose(
    patch && 'teamCompose' in patch ? patch.teamCompose : cur.teamCompose,
  );
  next.jev = sanitizeJev(
    patch && 'jev' in patch ? { ...(cur.jev || {}), ...patch.jev } : cur.jev,
  );

  const curScope = teamScope.sanitizeTeamScope(cur.teamScope);
  if (teamScope.mandateArmed(curScope)) {
    next.teamScope.enforcedSince = curScope.enforcedSince;
    next.teamScope.enforcedBy = curScope.enforcedBy;
  }

  const io = (opts && opts.io) || {};
  const file = settingsPath();
  const payload = JSON.stringify(next, null, 2);
  let outcome = { ok: true, code: null, reason: 'written', inPlace: false, file };
  try {
    const w = atomicWriteFileSync(file, payload, {
      encoding: 'utf8',
      dirMode: undefined,
      inPlaceFallback: true,
      ...io,
    });
    outcome.inPlace = w.inPlace === true;
    const back = JSON.parse(fs.readFileSync(file, 'utf8'));
    if ((back.workspaceRoot ?? null) !== (next.workspaceRoot ?? null)) {
      outcome = { ok: false, code: 'READBACK_MISMATCH', reason: 'readback-mismatch', inPlace: outcome.inPlace, file };
    }
  } catch (e) {
    outcome = {
      ok: false,
      code: (e && e.code) || 'ERR',
      reason: e instanceof SyntaxError ? 'readback-corrupt' : 'write-failed',
      inPlace: outcome.inPlace,
      file,
      err: e,
    };
  }
  if (!outcome.ok) {
    const line = `settings persist FAILED (${outcome.code}/${outcome.reason}): ${file} — `
      + 'ayar bu oturumda geçerli ama DİSKE YAZILAMADI (yeniden açılışta kaybolur)';
    if (typeof io.log === 'function') { try { io.log(line, outcome.err); } catch { /* best-effort */ } }
    else if (_persistLogger) { try { _persistLogger(line); } catch { /* best-effort */ } }
    else { try { process.stderr.write(`[settings] ${line}\n`); } catch { /* best-effort */ } }
  } else if (outcome.inPlace && _persistLogger) {
    try { _persistLogger(`settings persist: rename bloklandı, YERİNDE yazıldı (atomik değil): ${file}`); } catch { /* best-effort */ }
  }
  _lastPersist = outcome;
  _cache = next;
  return next;
}

/** Son `writeSettings` yazımının hükmü: `{ ok, code, reason, inPlace, file }`. */
function lastPersistOutcome() {
  const { err, ..._public } = _lastPersist;
  void err;
  return _public;
}

/** main.js açılışta `logLine`ı takar. */
function setPersistLogger(fn) {
  _persistLogger = typeof fn === 'function' ? fn : null;
}

/**
 * ADP-232 — apply a settings patch and say whether a restart is needed.
 */
function applySettingsPatch(patch) {
  const prevWorkspaceRoot = readSettings().workspaceRoot;
  const next = writeSettings(patch || {});
  const persist = lastPersistOutcome();
  return {
    next,
    restartRequired: next.workspaceRoot !== prevWorkspaceRoot,
    persisted: persist.ok,
    persistError: persist.ok ? null : `${persist.code}/${persist.reason}`,
  };
}

/** The OpenAI API key from settings (apiKeys.openai), or '' if unset. */
function openAiKeyFromSettings() {
  const s = readSettings();
  const k = s.apiKeys && s.apiKeys.openai;
  return typeof k === 'string' ? k.trim() : '';
}

function invalidateCache() {
  _cache = null;
}

module.exports = {
  settingsDir,
  settingsPath,
  readSettings,
  writeSettings,
  lastPersistOutcome,
  setPersistLogger,
  applySettingsPatch,
  openAiKeyFromSettings,
  invalidateCache,
  _resetCache: invalidateCache,
};
