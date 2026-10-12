'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// 1. CrewPane Platform & Perf aliases (for backward compatibility)
const platformStr = String(process.platform || '');
contextBridge.exposeInMainWorld('crewpanePlatform', platformStr);

const perfNum = (name, fallback) => {
  const raw = String(process.env[name] ?? '').trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const perfFlag = (name, fallback) => {
  const raw = String(process.env[name] ?? '').trim();
  if (!raw) return fallback;
  return raw !== '0' && raw.toLowerCase() !== 'false';
};

const perfSettings = {
  termFlushHz: perfNum('CREWPANE_TERM_FLUSH_HZ', 30),
  termHiddenFlushHz: perfNum('CREWPANE_TERM_HIDDEN_FLUSH_HZ', 4),
  termWriteRecovery: perfFlag('CREWPANE_TERM_WRITE_RECOVERY', true),
  termBlankRecovery: perfFlag('CREWPANE_TERM_BLANK_RECOVERY', true),
};
contextBridge.exposeInMainWorld('crewpanePerf', perfSettings);

// 2. CrewPane Doctor alias
contextBridge.exposeInMainWorld('crewpaneDoctor', {
  runProbe: () => ipcRenderer.invoke('doctor:probe'),
  fixPermissions: () => ipcRenderer.invoke('doctor:fix-permissions'),
});

// 3. CrewPane Locale alias
let localeState = null;
try {
  const prefix = '--crewpane-locale=';
  const arg = (process.argv || []).find((a) => typeof a === 'string' && a.startsWith(prefix));
  if (arg) {
    const raw = arg.slice(prefix.length);
    const parsed = JSON.parse(decodeURIComponent(raw));
    if (parsed && typeof parsed.lang === 'string') {
      localeState = Object.freeze({
        lang: parsed.lang,
        direction: parsed.direction === 'rtl' ? 'rtl' : 'ltr',
        source: parsed.source || 'default',
        messages: Object.freeze(parsed.messages && typeof parsed.messages === 'object' ? { ...parsed.messages } : {}),
      });
    }
  }
} catch {
  localeState = null;
}
if (localeState) contextBridge.exposeInMainWorld('crewpaneLocale', localeState);

// 4. CrewPane Database alias
contextBridge.exposeInMainWorld('crewpaneDb', {
  listRecentProjects: () => ipcRenderer.invoke('db:projects:recent'),
  listRecentAgents: () => ipcRenderer.invoke('db:agents:recent'),
  getProject: (slug) => ipcRenderer.invoke('db:project:get', slug),
  saveProject: (proj) => ipcRenderer.invoke('db:project:save', proj),
  deleteProject: (slug) => ipcRenderer.invoke('db:project:delete', slug),
  openDbFolder: () => ipcRenderer.invoke('db:folder:open'),
  syncStatus: () => ipcRenderer.invoke('db:sync:status'),
});

// 5. CrewPane Auth API alias
contextBridge.exposeInMainWorld('crewpaneApi', {
  get: () => ipcRenderer.invoke('crewpane:get'),
  signIn: () => ipcRenderer.invoke('crewpane:signIn'),
  signOut: (opts) => ipcRenderer.invoke('crewpane:signOut', opts),
  schemeHealth: (opts) => ipcRenderer.invoke('crewpane:schemeHealth', opts),
  secretBackend: () => ipcRenderer.invoke('crewpane:secretBackend'),
  pasteCallback: (url) => ipcRenderer.invoke('crewpane:pasteCallback', url),
  refresh: () => ipcRenderer.invoke('crewpane:refresh'),
  openBilling: () => ipcRenderer.invoke('crewpane:openBilling'),
  devices: () => ipcRenderer.invoke('crewpane:devices'),
  deviceRevoke: (deviceId) => ipcRenderer.invoke('crewpane:deviceRevoke', deviceId),
  deviceReleaseOthers: () => ipcRenderer.invoke('crewpane:deviceReleaseOthers'),
  onState: (cb) => {
    const listener = (_e, state) => cb(state);
    ipcRenderer.on('crewpane:state', listener);
    return () => ipcRenderer.removeListener('crewpane:state', listener);
  },
});

// 6. Task API (task cleanup)
contextBridge.exposeInMainWorld('taskApi', {
  cleanTeamDone: (opts) => ipcRenderer.invoke('task:cleanTeamDone', opts),
  cleanAll: () => ipcRenderer.invoke('task:cleanAll'),
  listSummary: () => ipcRenderer.invoke('task:listSummary'),
});
