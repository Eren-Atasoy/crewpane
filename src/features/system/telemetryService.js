'use strict';

const crypto = require('node:crypto');
const os = require('node:os');
const telemetryMod = require('../../../telemetry/telemetry.cjs');
const heartbeatMod = require('../../../telemetry/heartbeat.cjs');
const analyticsMod = require('../../../telemetry/analytics.cjs');
const provisionStoreMod = require('../../../telemetry/provisionStore.cjs');
const telemetryProvisionMod = require('../../../telemetry/telemetryProvision.cjs');
const telemetryChannelMod = require('../../../telemetry/channel.cjs');

const ANALYTICS_FUNNEL_EVENT = Object.freeze({
  panes_opened: 'pane_opened',
  agents_spawned: 'agent_spawned',
  delegations: 'delegation_started',
  tasks_created: 'task_created',
});

function analyticsEngineOf(command, engineRegistry) {
  if (!command) return 'none';
  const id = String(command);
  return engineRegistry && engineRegistry.isRegisteredEngine(id) ? id : 'other';
}

function resolveAnalyticsBaseProps({ app, getSeatGate, agentSettings }) {
  let tier = 'none';
  try {
    const sg = getSeatGate();
    const s = sg ? sg.state() : null;
    if (s && s.tier) tier = s.tier;
  } catch {
    /* lisans okunamadı → 'none' */
  }
  let locale = 'other';
  try {
    locale = (agentSettings.readSettings().locale || '').slice(0, 2) || 'other';
  } catch {
    /* varsayılan */
  }
  return {
    app: 'crewpane',
    channel: telemetryChannelMod.resolveChannel(),
    app_version: app ? app.getVersion() : '0.0.0',
    platform: process.platform,
    arch: process.arch,
    os_release: os.release(),
    tier,
    locale,
  };
}

function recordAnalyticsFirstTime(marker, agentSettings) {
  try {
    const cur = agentSettings.sanitizeTelemetryState(agentSettings.readSettings().telemetryState);
    if (cur.milestones.includes(marker)) return false;
    agentSettings.writeSettings({
      telemetryState: { ...cur, milestones: [...cur.milestones, marker] },
    });
    return true;
  } catch {
    return false;
  }
}

function isTelemetryEnabled({ crewpaneEnv, instancePaths, agentSettings }) {
  if (crewpaneEnv.readEnv('TELEMETRY') === '0') return false;
  if (instancePaths.instanceId() === 'test' && crewpaneEnv.readEnv('TELEMETRY') !== '1') return false;
  return agentSettings.readSettings().telemetryEnabled !== false;
}

function getTelemetryStateForSend(agentSettings) {
  const s = agentSettings.readSettings();
  const st = agentSettings.sanitizeTelemetryState(s.telemetryState);
  if (!st.installId) {
    st.installId = crypto.randomUUID();
    st.sessions = 1;
    agentSettings.writeSettings({ telemetryState: st });
  }
  return st;
}

function createAnalyticsClient({
  telemetryEnvNow,
  telemetryChannelMod,
  telemetryStateForSend,
  telemetryEnabledNow,
  analyticsBaseProps,
  logLine,
}) {
  try {
    const env = telemetryEnvNow();
    const channel = telemetryChannelMod.resolveChannel();
    return analyticsMod.createAnalytics({
      apiKey: telemetryChannelMod.resolvePostHogKey(channel, env),
      host: telemetryChannelMod.resolvePostHogHost(env),
      distinctId: () => {
        try {
          return telemetryStateForSend().installId;
        } catch {
          return null;
        }
      },
      enabled: () => telemetryEnabledNow(),
      base: () => analyticsBaseProps(),
      flushIntervalMs: (() => {
        const raw = Number(env.CREWPANE_POSTHOG_FLUSH_MS);
        return Number.isFinite(raw) ? Math.min(Math.max(raw, 1000), 300000) : undefined;
      })(),
      log: (line) => logLine(line),
    });
  } catch (e) {
    try {
      logLine(`analytics: kurulamadı (${e && e.message})`);
    } catch {
      /* best-effort fallback */
    }
    return {
      track: () => ({ sent: false, reason: 'init-failed' }),
      flush: () => ({ sent: false, reason: 'init-failed' }),
      stats: () => ({}),
      pending: () => 0,
      enabledNow: () => false,
    };
  }
}

function createHeartbeatInstance({
  app,
  telemetryChannelMod,
  currentUpdateChannel,
  isAutoUpdaterActive,
  telemetryEnabledNow,
  rendererSupabaseTarget,
  appDbTokenFor,
  telemetryStateForSend,
  agentSettings,
  logLine,
}) {
  return heartbeatMod.createHeartbeat({
    enabled: telemetryEnabledNow,
    target: () => {
      const t = rendererSupabaseTarget();
      return t && t.url && t.anonKey ? { url: t.url, anonKey: t.anonKey, schema: t.schema } : null;
    },
    accessToken: () => appDbTokenFor('telemetry:heartbeat'),
    state: telemetryStateForSend,
    saveState: (patch) => {
      const cur = agentSettings.sanitizeTelemetryState(agentSettings.readSettings().telemetryState);
      agentSettings.writeSettings({ telemetryState: { ...cur, ...patch } });
    },
    info: () => ({
      app: 'crewpane',
      appVersion: app ? app.getVersion() : '0.0.0',
      buildChannel: telemetryChannelMod.resolveChannel(),
      updateChannel: currentUpdateChannel(),
      updaterMode: isAutoUpdaterActive() ? 'updater' : 'notify',
      platform: process.platform,
      osRelease: os.release(),
      arch: process.arch,
      uiLocale: (app && app.getLocale ? app.getLocale() || '' : '').slice(0, 5),
    }),
    log: (line) => logLine(line),
  });
}

function performTelemetryBump(key, by, props, { heartbeat, analyticsNow, analyticsFirstTime }) {
  try {
    heartbeat().bump(key, by);
  } catch {
    /* telemetri asla çağıranı düşürmez */
  }
  try {
    const event = ANALYTICS_FUNNEL_EVENT[key];
    if (!event) return;
    analyticsNow().track(event, { first_time: analyticsFirstTime(event), ...(props || {}) });
  } catch {
    /* analitik asla çağıranı düşürmez */
  }
}

function performStartHeartbeat({ agentSettings, heartbeat, telemetryEnabledNow, logLine }) {
  try {
    const s = agentSettings.readSettings();
    const st = agentSettings.sanitizeTelemetryState(s.telemetryState);
    agentSettings.writeSettings({
      telemetryState: {
        ...st,
        installId: st.installId || crypto.randomUUID(),
        sessions: (st.sessions || 0) + 1,
      },
    });
    heartbeat().start();
    if (!telemetryEnabledNow()) {
      logLine('telemetry: heartbeat KAPALI (opt-out / kill-switch / test instance)');
    }
  } catch (e) {
    logLine(`telemetry: heartbeat başlatılamadı (${e && e.message})`);
  }
}

/**
 * Unified Telemetry, Provisioning, Heartbeat & Analytics Service (Faz 3.6.11)
 */
function createTelemetryService(deps = {}) {
  const {
    app,
    instancePaths,
    agentSettings,
    crewpaneEnv,
    logLine = () => {},
    getSeatGate = () => null,
    appDbTokenFor = async () => ({ ok: false }),
    rendererSupabaseTarget = () => null,
    currentUpdateChannel = () => 'stable',
    isAutoUpdaterActive = () => false,
    resolveCredential = () => ({ ok: false }),
    engineRegistry,
    safeStorage = null,
  } = deps;

  let analyticsClient = null;
  let telemetryProvisionCore = null;
  let heartbeatInstance = null;

  function telemetryProvisioning() {
    if (telemetryProvisionCore) return telemetryProvisionCore;
    const store = provisionStoreMod.createProvisionStore({
      safeStorage,
      homeDir: instancePaths.crewpaneHome(),
      log: (line) => logLine(line),
    });
    const provisioner = telemetryProvisionMod.createTelemetryProvisioner({
      store,
      channel: () => telemetryChannelMod.resolveChannel(),
      appVersion: app ? app.getVersion() : '0.0.0',
      log: (line) => logLine(line),
    });
    telemetryProvisionCore = { store, provisioner };
    return telemetryProvisionCore;
  }

  function telemetryTokenFor(service) {
    const r = resolveCredential(service);
    return r.ok ? r.secret : null;
  }

  function telemetryEnvNow() {
    try {
      return telemetryMod.resolveTelemetryEnv({ provisionStore: telemetryProvisioning().store });
    } catch {
      return telemetryMod.loadDsnEnvFromCrewPane({});
    }
  }

  function telemetryEnabledNow() {
    return isTelemetryEnabled({ crewpaneEnv, instancePaths, agentSettings });
  }

  function telemetryStateForSend() {
    return getTelemetryStateForSend(agentSettings);
  }

  function analyticsBaseProps() {
    return resolveAnalyticsBaseProps({ app, getSeatGate, agentSettings });
  }

  function analyticsFirstTime(marker) {
    return recordAnalyticsFirstTime(marker, agentSettings);
  }

  function analyticsNow() {
    if (analyticsClient) return analyticsClient;
    analyticsClient = createAnalyticsClient({
      telemetryEnvNow,
      telemetryChannelMod,
      telemetryStateForSend,
      telemetryEnabledNow,
      analyticsBaseProps,
      logLine,
    });
    return analyticsClient;
  }

  function heartbeat() {
    if (heartbeatInstance) return heartbeatInstance;
    heartbeatInstance = createHeartbeatInstance({
      app,
      telemetryChannelMod,
      currentUpdateChannel,
      isAutoUpdaterActive,
      telemetryEnabledNow,
      rendererSupabaseTarget,
      appDbTokenFor,
      telemetryStateForSend,
      agentSettings,
      logLine,
    });
    return heartbeatInstance;
  }

  function telemetryBump(key, by, props) {
    performTelemetryBump(key, by, props, { heartbeat, analyticsNow, analyticsFirstTime });
  }

  function startHeartbeat() {
    performStartHeartbeat({ agentSettings, heartbeat, telemetryEnabledNow, logLine });
  }



  return {
    telemetryProvisioning,
    telemetryTokenFor,
    telemetryEnvNow,
    telemetryEnabledNow,
    telemetryStateForSend,
    analyticsNow,
    analyticsBaseProps,
    analyticsFirstTime,
    analyticsEngineOf: (cmd) => analyticsEngineOf(cmd, engineRegistry),
    heartbeat,
    telemetryBump,
    startHeartbeat,
    ANALYTICS_FUNNEL_EVENT,
  };
}

module.exports = {
  createTelemetryService,
  ANALYTICS_FUNNEL_EVENT,
  analyticsEngineOf,
};
