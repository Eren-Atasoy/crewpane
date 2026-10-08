'use strict';

/**
 * Preference Projection Handlers (Faz 3.6.3)
 */
function createPrefsHandlers(options) {
  const {
    agentSettings,
    getBoundAccount,
    prefsProjectorFactory,
    logLine,
    broadcastLocale,
    getAppWindow,
    getPopoutWindows,
  } = options;

  let _prefsProjector = null;
  let _prefsProjectorRoot = null;

  function prefsProjector() {
    const boundAccount = getBoundAccount();
    const root = (boundAccount && boundAccount.root) || null;
    if (!root) {
      _prefsProjector = null;
      _prefsProjectorRoot = null;
      return null;
    }
    if (_prefsProjector && _prefsProjectorRoot === root) return _prefsProjector;
    try {
      _prefsProjector = prefsProjectorFactory.createPrefsProjector({
        dir: root,
        deviceId: (boundAccount && boundAccount.deviceId) || null,
        readSettings: () => agentSettings.readSettings(),
        writeSettings: (patch) => agentSettings.writeSettings(patch),
        getEnabled: () => {
          const st = agentSettings.readSettings();
          return st.cloudSyncEnabled === true && st.prefsSyncEnabled !== false;
        },
        log: (l) => logLine(l),
      });
      _prefsProjectorRoot = root;
    } catch (err) {
      logLine(`[prefs] projektör kurulamadı: ${err.message}`);
      _prefsProjector = null;
      _prefsProjectorRoot = null;
    }
    return _prefsProjector;
  }

  function prefsProjectNow(reason) {
    const p = prefsProjector();
    if (!p) return;
    try {
      const r = p.projectSettings();
      if (r && r.ok && r.changed && r.changed.length) {
        logLine(`[prefs] projeksiyon güncellendi (${reason}): ${r.changed.join(', ')}`);
      }
    } catch (err) {
      logLine(`[prefs] projeksiyon hatası: ${err.message}`);
    }
  }

  let _prefsApplyQueued = false;
  function prefsApplySoon() {
    if (_prefsApplyQueued) return;
    _prefsApplyQueued = true;
    setImmediate(() => {
      _prefsApplyQueued = false;
      const p = prefsProjector();
      if (!p) return;
      let applied = [];
      try {
        const r = p.applyToSettings();
        applied = (r && r.applied) || [];
      } catch (err) {
        logLine(`[prefs] uygulama hatası: ${err.message}`);
        return;
      }
      if (applied.includes('locale')) {
        try {
          broadcastLocale();
        } catch {
          /* dil yayını kritik değil */
        }
      }
      try {
        const payload = { applied, at: new Date().toISOString() };
        const appWin = getAppWindow();
        if (appWin && !appWin.isDestroyed()) appWin.webContents.send('prefs:changed', payload);
        const popouts = getPopoutWindows();
        if (popouts && typeof popouts.values === 'function') {
          for (const w of popouts.values()) {
            if (w && !w.isDestroyed()) w.webContents.send('prefs:changed', payload);
          }
        }
      } catch {
        /* pencere kapanmış olabilir */
      }
    });
  }

  return {
    prefsProjector,
    prefsProjectNow,
    prefsApplySoon,
  };
}

/**
 * Cloud Sync Runtime Instance (Faz 3.6.3)
 */
function createSyncRuntimeInstance(options) {
  const {
    agentSettings,
    getBoundAccount,
    getAgentWorkspaceRoot,
    publicSupabaseEnv,
    accountScope,
    getSeatGate,
    appDbTokenFor,
    memoryIndexDerive,
    pushPlanLimit,
    logLine,
    prefsProjector,
    prefsApplySoon,
    syncBoot,
  } = options;

  return syncBoot.createSyncRuntime({
    getEnabled: () => agentSettings.readSettings().cloudSyncEnabled === true,
    getRoots: () => {
      const boundAccount = getBoundAccount();
      return {
        workspaceRoot: getAgentWorkspaceRoot() || null,
        accountRoot: (boundAccount && boundAccount.root) || null,
      };
    },
    getTarget: () => {
      const env = publicSupabaseEnv();
      const boundAccount = getBoundAccount();
      let companyId = null;
      try {
        const meta = (boundAccount && boundAccount.root) ? accountScope.readAccountMeta(boundAccount.root) : null;
        companyId = (meta && typeof meta.companyId === 'string' && meta.companyId.trim()) ? meta.companyId.trim() : null;
      } catch {
        companyId = null;
      }
      return {
        url: env.NEXT_PUBLIC_CREWPANE_SUPABASE_URL,
        key: env.NEXT_PUBLIC_CREWPANE_SUPABASE_ANON_KEY,
        schema: env.NEXT_PUBLIC_CREWPANE_SUPABASE_SCHEMA || null,
        companyId,
      };
    },
    getPlanSnapshot: () => {
      const seatGate = getSeatGate();
      return seatGate ? seatGate.state() : null;
    },
    getDeviceId: () => {
      const boundAccount = getBoundAccount();
      return (boundAccount && boundAccount.deviceId) || null;
    },
    getToken: () => appDbTokenFor('sync:cloud'),
    deriveIndexes: memoryIndexDerive.createDeriveIndexesHook({
      roots: () => {
        const boundAccount = getBoundAccount();
        return {
          workspaceRoot: getAgentWorkspaceRoot() || null,
          accountRoot: (boundAccount && boundAccount.root) || null,
        };
      },
      write: true,
      log: (l) => logLine(l),
    }),
    transformIncoming: ({ class: cls, buf }) => {
      if (cls !== 'prefs') return null;
      const p = prefsProjector();
      if (!p) return null;
      const merged = p.mergeIncoming(buf);
      prefsApplySoon();
      return merged;
    },
    onPlanDenied: (denial) => pushPlanLimit(denial),
    log: (l) => logLine(l),
  });
}

/**
 * Sync and Preferences Service (Faz 3.6.3)
 */
function _resolveSyncCoreDeps(deps) {
  return {
    agentSettings: deps.agentSettings,
    getBoundAccount: typeof deps.getBoundAccount === 'function' ? deps.getBoundAccount : () => null,
    getAgentWorkspaceRoot: typeof deps.getAgentWorkspaceRoot === 'function' ? deps.getAgentWorkspaceRoot : () => null,
    publicSupabaseEnv: typeof deps.publicSupabaseEnv === 'function' ? deps.publicSupabaseEnv : () => ({}),
    accountScope: deps.accountScope || require('../../config/accountScope.cjs'),
    getSeatGate: typeof deps.getSeatGate === 'function' ? deps.getSeatGate : () => null,
    appDbTokenFor: typeof deps.appDbTokenFor === 'function' ? deps.appDbTokenFor : async () => null,
    memoryIndexDerive: deps.memoryIndexDerive || require('../../memory/memoryIndexDerive.cjs'),
  };
}

function _resolveSyncAuxDeps(deps) {
  return {
    pushPlanLimit: typeof deps.pushPlanLimit === 'function' ? deps.pushPlanLimit : () => {},
    logLine: typeof deps.logLine === 'function' ? deps.logLine : () => {},
    broadcastLocale: typeof deps.broadcastLocale === 'function' ? deps.broadcastLocale : () => {},
    getAppWindow: typeof deps.getAppWindow === 'function' ? deps.getAppWindow : () => null,
    getPopoutWindows: typeof deps.getPopoutWindows === 'function' ? deps.getPopoutWindows : () => new Map(),
    prefsProjectorFactory: deps.prefsProjectorFactory || require('../../../prefs/prefsProjector.cjs'),
    syncBoot: deps.syncBoot || require('../../../sync/syncBoot.cjs'),
    syncSurface: deps.syncSurface || require('../../../sync/syncIpc.cjs'),
  };
}

function _resolveSyncDeps(deps = {}) {
  return {
    ..._resolveSyncCoreDeps(deps),
    ..._resolveSyncAuxDeps(deps),
  };
}

/**
 * Sync Service Factory (Faz 3.6.3)
 */
function createSyncService(rawDeps = {}) {
  const deps = _resolveSyncDeps(rawDeps);

  const { prefsProjector, prefsProjectNow, prefsApplySoon } = createPrefsHandlers(deps);

  const syncRuntime = createSyncRuntimeInstance({
    ...deps,
    prefsProjector,
    prefsApplySoon,
  });

  const syncIpcSurface = deps.syncSurface.createSyncIpc({
    getEngine: () => syncRuntime.getEngine(),
    getSetup: () => syncRuntime.describe(),
    log: (l) => deps.logLine(l),
  });

  return {
    prefsProjector,
    prefsProjectNow,
    prefsApplySoon,
    syncRuntime,
    syncIpcSurface,
    getSyncRuntime: () => syncRuntime,
    getSyncIpcSurface: () => syncIpcSurface,
  };
}

module.exports = {
  createSyncService,
};
