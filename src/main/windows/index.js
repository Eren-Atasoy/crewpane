'use strict';

const path = require('node:path');
const electron = require('electron');

const { tagTestWindow, E2E_WINDOW_TAG } = require('./tagTestWindow');
const { createSharedWebPreferences } = require('./sharedPreferences');
const { attachHtmlFullscreenGuard } = require('./htmlFullscreenGuard');
const { applyGuestPermissionPolicy, attachWebviewGuards } = require('./webviewGuards');
const { createAppWindow } = require('./mainWindow');
const { createSpikeWindow } = require('./spikeWindow');
const {
  popoutWindows,
  popoutWindowFor,
  popoutPaneIdForWindow,
  sendPaneEvent,
  notifyPopoutState,
  openPopoutWindow,
  closePopoutWindow,
  listPopoutPanes,
  broadcastPaneView,
  broadcastPaneDraft,
  broadcastClipChanged,
} = require('./popoutWindow');
const {
  DESIGN_WINDOW_KEY,
  DESIGN_WINDOW_MIN,
  designWindowAlive,
  getDesignWindow,
  setDesignWindow,
  notifyDesignWindowOpen,
  openDesignWindow,
  closeDesignWindow,
} = require('./designWindow');
const {
  JARVIS_WIDGET_KEY,
  jarvisWidgetAlive,
  getJarvisWidgetWindow,
  setJarvisWidgetWindow,
  getJarvisWidgetSnapshot,
  setJarvisWidgetSnapshot,
  jarvisWidgetPayload,
  broadcastJarvisWidget,
  notifyJarvisWidgetOpen,
  jarvisWidgetWorkArea,
  openJarvisWidgetWindow,
  closeJarvisWidgetWindow,
  moveJarvisWidget,
} = require('./jarvisWidgetWindow');
const {
  handOverlayWindows,
  handTuningConfig,
  handOverlayPrefs,
  handOverlayAnyAlive,
  getHandOverlayLastCost,
  setHandOverlayLastCost,
  getHandOverlayLastFeedAt,
  getHandOverlayDebugInfo,
  openHandOverlayWindows,
  closeHandOverlayWindows,
  rebuildHandOverlayWindows,
  hookHandOverlayScreenEvents,
  startHandOverlayWatchdog,
  stopHandOverlayWatchdog,
  feedHandOverlay,
  applyHandOverlaySettings,
} = require('./handOverlayWindows');
const {
  handDetectAlive,
  openHandDetectWindow,
  scheduleHandControlWarmup,
} = require('./handDetectWindow');

function agentxDraftTargets(deps) {
  const out = [];
  const appWindow = typeof deps.getAppWindow === 'function' ? deps.getAppWindow() : null;
  if (appWindow && !appWindow.isDestroyed()) out.push(appWindow);
  const jw = jarvisWidgetAlive();
  if (jw) out.push(jw);
  for (const w of popoutWindows.values()) {
    if (w && !w.isDestroyed()) out.push(w);
  }
  return out;
}

function broadcastAgentxDraft(snapshot, deps) {
  for (const w of agentxDraftTargets(deps)) w.webContents.send('agentxDraft:changed', snapshot);
}

function broadcastAgentxDraftConfirmed(confirmed, deps) {
  for (const w of agentxDraftTargets(deps)) w.webContents.send('agentxDraft:confirmed', confirmed);
}

function showAppFromJarvisWidget(deps) {
  const appWindow = typeof deps.getAppWindow === 'function' ? deps.getAppWindow() : null;
  if (appWindow && !appWindow.isDestroyed()) {
    if (appWindow.isMinimized()) appWindow.restore();
    appWindow.show();
    appWindow.focus();
    return { ok: true, created: false };
  }
  const appBaseUrl = typeof deps.getAppBaseUrl === 'function' ? deps.getAppBaseUrl() : null;
  if (!appBaseUrl) return { ok: false, error: 'uygulama adresi yok' };
  createAppWindow(appBaseUrl, deps);
  return { ok: true, created: true };
}

const defaultStaticWindowManagerDeps = {
  BrowserWindow: electron.BrowserWindow,
  shell: electron.shell,
  screen: electron.screen,
  Notification: electron.Notification,
  app: electron.app,
  preloadPath: path.join(__dirname, '..', '..', '..', 'dist', 'preload.js'),
  supabaseTarget: require('../../config/supabaseTarget.cjs'),
  crashWatchdog: require('../../core/crashWatchdog.cjs'),
  reportsWatcher: require('../../services/reportsWatcher.cjs'),
  quitFunnel: require('../../core/quitFunnel.cjs'),
  appI18n: require('../../../i18n/index.cjs'),
};

function createWindowManager(deps = {}) {
  const mergedDeps = { ...defaultStaticWindowManagerDeps, ...deps };
  const sharedWebPreferences = () => createSharedWebPreferences(mergedDeps);
  const enrichedDeps = { ...mergedDeps, sharedWebPreferences };

  return {
    sharedWebPreferences,
    tagTestWindow: (win, base) => tagTestWindow(win, base, mergedDeps.isTest),
    attachHtmlFullscreenGuard: (win, wc) => attachHtmlFullscreenGuard(win, wc, mergedDeps.logLine),
    applyGuestPermissionPolicy: (ses) => applyGuestPermissionPolicy(ses, enrichedDeps),
    attachWebviewGuards: (win) => attachWebviewGuards(win, enrichedDeps),
    createAppWindow: (url) => createAppWindow(url, enrichedDeps),
    createSpikeWindow: () => createSpikeWindow(enrichedDeps),
    popoutWindows,
    popoutWindowFor,
    popoutPaneIdForWindow,
    sendPaneEvent,
    notifyPopoutState: (channel, payload) => notifyPopoutState(channel, payload, enrichedDeps),
    openPopoutWindow: (options) => openPopoutWindow(options, enrichedDeps),
    closePopoutWindow,
    listPopoutPanes,
    broadcastPaneView: (paneId, readable) => broadcastPaneView(paneId, readable, enrichedDeps),
    broadcastPaneDraft: (paneId, text) => broadcastPaneDraft(paneId, text, enrichedDeps),
    broadcastClipChanged: () => broadcastClipChanged(enrichedDeps),
    agentxDraftTargets: () => agentxDraftTargets(enrichedDeps),
    broadcastAgentxDraft: (snapshot) => broadcastAgentxDraft(snapshot, enrichedDeps),
    broadcastAgentxDraftConfirmed: (confirmed) => broadcastAgentxDraftConfirmed(confirmed, enrichedDeps),
    showAppFromJarvisWidget: () => showAppFromJarvisWidget(enrichedDeps),
    DESIGN_WINDOW_KEY,
    DESIGN_WINDOW_MIN,
    designWindowAlive,
    getDesignWindow,
    setDesignWindow,
    notifyDesignWindowOpen: () => notifyDesignWindowOpen(enrichedDeps),
    openDesignWindow: () => openDesignWindow(enrichedDeps),
    closeDesignWindow,
    JARVIS_WIDGET_KEY,
    jarvisWidgetAlive,
    getJarvisWidgetWindow,
    setJarvisWidgetWindow,
    getJarvisWidgetSnapshot,
    setJarvisWidgetSnapshot,
    jarvisWidgetPayload: () => jarvisWidgetPayload(enrichedDeps),
    broadcastJarvisWidget: () => broadcastJarvisWidget(enrichedDeps),
    notifyJarvisWidgetOpen: () => notifyJarvisWidgetOpen(enrichedDeps),
    jarvisWidgetWorkArea,
    openJarvisWidgetWindow: () => openJarvisWidgetWindow(enrichedDeps),
    closeJarvisWidgetWindow,
    moveJarvisWidget,
    handOverlayWindows,
    handTuningConfig,
    handOverlayPrefs,
    handOverlayAnyAlive,
    getHandOverlayLastCost,
    setHandOverlayLastCost,
    getHandOverlayLastFeedAt,
    getHandOverlayDebugInfo,
    openHandOverlayWindows: () => openHandOverlayWindows(enrichedDeps),
    closeHandOverlayWindows: (reason) => closeHandOverlayWindows(reason, mergedDeps.logLine),
    rebuildHandOverlayWindows: () => rebuildHandOverlayWindows(enrichedDeps),
    hookHandOverlayScreenEvents: () => hookHandOverlayScreenEvents(enrichedDeps),
    startHandOverlayWatchdog,
    stopHandOverlayWatchdog,
    feedHandOverlay: (rawEvents) => feedHandOverlay(rawEvents, enrichedDeps),
    applyHandOverlaySettings,
    handDetectAlive: () => handDetectAlive(enrichedDeps),
    openHandDetectWindow: () => openHandDetectWindow(enrichedDeps),
    scheduleHandControlWarmup: (attempt) => scheduleHandControlWarmup(attempt, enrichedDeps),
  };
}

module.exports = {
  createWindowManager,
  tagTestWindow,
  E2E_WINDOW_TAG,
  createSharedWebPreferences,
  attachHtmlFullscreenGuard,
  applyGuestPermissionPolicy,
  attachWebviewGuards,
  createAppWindow,
  createSpikeWindow,
  popoutWindows,
  popoutWindowFor,
  popoutPaneIdForWindow,
  sendPaneEvent,
  notifyPopoutState,
  openPopoutWindow,
  closePopoutWindow,
  listPopoutPanes,
  broadcastPaneView,
  broadcastPaneDraft,
  broadcastClipChanged,
  DESIGN_WINDOW_KEY,
  DESIGN_WINDOW_MIN,
  designWindowAlive,
  getDesignWindow,
  setDesignWindow,
  notifyDesignWindowOpen,
  openDesignWindow,
  closeDesignWindow,
  JARVIS_WIDGET_KEY,
  jarvisWidgetAlive,
  getJarvisWidgetWindow,
  setJarvisWidgetWindow,
  getJarvisWidgetSnapshot,
  setJarvisWidgetSnapshot,
  jarvisWidgetPayload,
  broadcastJarvisWidget,
  notifyJarvisWidgetOpen,
  jarvisWidgetWorkArea,
  openJarvisWidgetWindow,
  closeJarvisWidgetWindow,
  moveJarvisWidget,
  handOverlayWindows,
  handTuningConfig,
  handOverlayPrefs,
  handOverlayAnyAlive,
  getHandOverlayLastCost,
  setHandOverlayLastCost,
  getHandOverlayLastFeedAt,
  getHandOverlayDebugInfo,
  openHandOverlayWindows,
  closeHandOverlayWindows,
  rebuildHandOverlayWindows,
  hookHandOverlayScreenEvents,
  startHandOverlayWatchdog,
  stopHandOverlayWatchdog,
  feedHandOverlay,
  applyHandOverlaySettings,
  handDetectAlive,
  openHandDetectWindow,
  scheduleHandControlWarmup,
  agentxDraftTargets,
  broadcastAgentxDraft,
  broadcastAgentxDraftConfirmed,
  showAppFromJarvisWidget,
};
