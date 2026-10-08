'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createMobileGatewayLifecycle } = require('./mobileLifecycle');

const SHOT_BRIDGE_MAX_BYTES = 25 * 1024 * 1024; // makul PNG tavanı (5K tam ekran ~10MB)

const defaultMobileModules = {
  mobileGatewayMod: require('../../mobile/mobileGateway.js'),
  mobileReports: require('../../mobile/mobileReports.cjs'),
  mobileOffice: require('../../mobile/mobileOffice.cjs'),
  mobileUploads: require('../../mobile/mobileUploads.cjs'),
  mobileTranscript: require('../../mobile/mobileTranscript.cjs'),
  mobileDeviceStore: require('../../mobile/mobileDeviceStore.cjs'),
  delegationBridgeMod: require('../../agents/delegationBridge.js'),
  delegationQueueStore: require('../../agents/delegationQueueStore.cjs'),
  agentRunner: require('../../agents/agentRunner.js'),
  jarvisVoice: require('../../voice/jarvisVoice.js'),
};

function createMobilePathsHelper({ app, standaloneDir, repoRoot }) {
  function mobileSpriteDir() {
    const candidates = app.isPackaged
      ? [
          path.join(standaloneDir(), 'public', 'sprites', 'characters'),
          path.join(repoRoot, 'public', 'sprites', 'characters'),
        ]
      : [
          path.join(repoRoot, 'public', 'sprites', 'characters'),
          path.join(standaloneDir(), 'public', 'sprites', 'characters'),
        ];
    return candidates.find((d) => fs.existsSync(d)) || candidates[0];
  }

  function mobileWebRoot() {
    const candidates = app.isPackaged
      ? [path.join(process.resourcesPath, 'mobile-web'), path.join(repoRoot, 'mobile', 'dist')]
      : [path.join(repoRoot, 'mobile', 'dist'), path.join(process.resourcesPath, 'mobile-web')];
    return candidates.find((d) => fs.existsSync(path.join(d, 'index.html'))) || null;
  }

  return {
    mobileSpriteDir,
    mobileWebRoot,
  };
}

function createMobilePaneReader({
  ptys,
  delegationBridgeMod,
  secretRedactor,
  mobileTranscript,
  currentSessionId,
  agentRunner,
}) {
  function mobilePaneTail(paneId, opts = {}) {
    const entry = ptys.get(String(paneId || ''));
    if (!entry) return null;
    if (entry.screen) return entry.screen.tail(opts);
    const clean = delegationBridgeMod.cleanPaneTail(entry.buffer || '', opts.lines || 200);
    const arr = clean ? clean.split('\n') : [];
    return {
      entries: arr.map((text, i) => ({ seq: i + 1, text })),
      live: [],
      firstSeq: arr.length ? 1 : 0,
      lastSeq: arr.length,
      hasMore: false,
      truncated: (entry.bytes || 0) > (entry.buffer || '').length,
    };
  }

  function mobilePaneTranscript(paneId, opts = {}) {
    const entry = ptys.get(String(paneId || ''));
    if (!entry) return null;
    return secretRedactor.redactDeep(
      mobileTranscript.readTranscriptPage({
        cwd: entry.cwd,
        sessionId: currentSessionId(String(paneId || '')),
        startedAt: entry.startedAt ?? null,
        engine: entry.command ?? null,
        limit: opts.limit,
        before: opts.before,
        maxText: mobileTranscript.MAX_TEXT,
      })
    );
  }

  function mobileListPanes() {
    const out = [];
    for (const [paneId, e] of ptys) {
      const tail = e.screen
        ? e.screen.lastLine()
        : delegationBridgeMod.cleanPaneTail(e.buffer || '', 1).slice(0, 200);
      out.push({
        paneId,
        agentId: e.agentId ?? null,
        label: e.label ?? null,
        department: e.department ?? null,
        command: e.command,
        status: agentRunner.statusFor(e.lastDataAt, Date.now()),
        startedAt: e.startedAt,
        lastLine: tail || '',
      });
    }
    return out;
  }

  return {
    mobilePaneTail,
    mobilePaneTranscript,
    mobileListPanes,
  };
}

function createMobileRendererBridge({
  getAppWindow,
  mobilePending,
  mobileCommandPending,
}) {
  function mobileQueryRenderer(kind, params, timeoutMs = 8000) {
    const win = getAppWindow();
    if (!win || win.isDestroyed()) return Promise.reject(new Error('uygulama penceresi yok'));
    const requestId = crypto.randomBytes(12).toString('hex');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        mobilePending.delete(requestId);
        reject(new Error('renderer timeout'));
      }, timeoutMs);
      mobilePending.set(requestId, { resolve, timer });
      win.webContents.send('mobile:query', { requestId, kind, params: params || {} });
    });
  }

  function mobileCommandRenderer(kind, payload) {
    const win = getAppWindow();
    if (!win || win.isDestroyed()) return Promise.reject(new Error('uygulama penceresi yok'));
    const requestId = crypto.randomBytes(12).toString('hex');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        mobileCommandPending.delete(requestId);
        reject(new Error('renderer timeout'));
      }, 44000);
      mobileCommandPending.set(requestId, { resolve, timer });
      win.webContents.send('mobile:command', { requestId, kind, payload: payload || {} });
    });
  }

  return {
    mobileQueryRenderer,
    mobileCommandRenderer,
  };
}

function createShotBridge({
  mobileOfficeSnapshot,
  mobileCommandRenderer,
}) {
  async function shotBridgeAgents() {
    const office = await mobileOfficeSnapshot();
    return (office && Array.isArray(office.agents) ? office.agents : []).map((a) => ({
      agentId: a.agentId,
      displayName: a.displayName,
      department: a.department,
      role: a.role,
      status: a.status,
    }));
  }

  async function shotBridgeSend({ path: shotPath, paths, agentId, text }) {
    const list = Array.isArray(paths) && paths.length ? paths : (shotPath ? [shotPath] : []);
    if (!list.length) return { ok: false, reason: 'not-found', error: 'görsel yolu yok' };
    for (const p of list) {
      let st;
      try {
        st = fs.statSync(p);
      } catch {
        return { ok: false, reason: 'not-found', error: `görsel bulunamadı: ${p}` };
      }
      if (!st.isFile()) return { ok: false, reason: 'not-found', error: `görsel bir dosya değil: ${p}` };
      if (st.size > SHOT_BRIDGE_MAX_BYTES) return { ok: false, error: `görsel çok büyük (tavan 25MB): ${p}` };
    }
    return mobileCommandRenderer('prompt', {
      agentId,
      text: typeof text === 'string' ? text : '',
      attachmentPaths: list,
      submit: false,
    });
  }

  return {
    shotBridgeAgents,
    shotBridgeSend,
  };
}

function createMobileOfficeBridge({
  getAppWindow,
  mobileQueryRenderer,
  mobileOffice,
  delegationQueueStore,
  rendererSupabaseTarget,
  getMobileAppDbToken,
  mobileListPanes,
}) {
  async function mobileDelegationState() {
    const win = getAppWindow();
    if (win && !win.isDestroyed()) {
      try {
        return await mobileQueryRenderer('delegation-state', {}, 3000);
      } catch {
        /* renderer yok/yavaş → diske düş */
      }
    }
    return mobileOffice.delegationStateFromQueue(delegationQueueStore.loadQueueState());
  }

  function mobileOfficeSnapshot() {
    const target = rendererSupabaseTarget();
    return mobileOffice.officeSnapshot({
      supabase: { url: target.url, key: target.anonKey, schema: target.schema },
      accessToken: getMobileAppDbToken(),
      listPanes: mobileListPanes,
      delegationState: mobileDelegationState,
    });
  }

  return {
    mobileDelegationState,
    mobileOfficeSnapshot,
  };
}

function createMobileVoiceBridge({ jarvisVoice, repoRoot, planDenial }) {
  function mobileTranscribe(payload) {
    return jarvisVoice.transcribeWhisper({ ...(payload || {}), apiKey: jarvisVoice.openAiKey(repoRoot) });
  }

  function mobilePlanDenial({ notify = true } = {}) {
    return planDenial('mobileRemote', 0, { notify });
  }

  return {
    mobileTranscribe,
    mobilePlanDenial,
  };
}

function mobileStartFailure(err) {
  const i18nMod = require('../../../i18n/index.cjs');
  return require('../../mobile/mobileStartFailure.cjs').mobileStartFailure(err, (k) => i18nMod.t(k));
}

function createMobileService(rawOpts = {}) {
  const opts = Object.assign({}, defaultMobileModules, rawOpts);
  const {
    app,
    ptys,
    getAppWindow = () => null,
    rendererSupabaseTarget,
    getMobileAppDbToken = () => null,
    planDenial = () => null,
    delegationBridgeMod,
    secretRedactor,
    mobileTranscript,
    currentSessionId = () => null,
    agentRunner,
    delegationQueueStore,
    mobileOffice,
    jarvisVoice,
    mobileGatewayMod,
    mobileReports,
    mobileUploads,
    jarvisConv,
    mobileDeviceStore,
    logLine = () => {},
    repoRoot = '',
    shellCommit = '',
    standaloneDir = () => '',
  } = opts;

  const mobileSubscribers = new Set();
  const mobilePending = new Map();
  const mobileCommandPending = new Map();

  const { mobileSpriteDir, mobileWebRoot } = createMobilePathsHelper({ app, standaloneDir, repoRoot });
  const { mobilePaneTail, mobilePaneTranscript, mobileListPanes } = createMobilePaneReader({
    ptys,
    delegationBridgeMod,
    secretRedactor,
    mobileTranscript,
    currentSessionId,
    agentRunner,
  });
  const { mobileQueryRenderer, mobileCommandRenderer } = createMobileRendererBridge({
    getAppWindow,
    mobilePending,
    mobileCommandPending,
  });
  const { mobileDelegationState, mobileOfficeSnapshot } = createMobileOfficeBridge({
    getAppWindow,
    mobileQueryRenderer,
    mobileOffice,
    delegationQueueStore,
    rendererSupabaseTarget,
    getMobileAppDbToken,
    mobileListPanes,
  });
  const { shotBridgeAgents, shotBridgeSend } = createShotBridge({
    mobileOfficeSnapshot,
    mobileCommandRenderer,
  });
  const { mobileTranscribe, mobilePlanDenial } = createMobileVoiceBridge({
    jarvisVoice,
    repoRoot,
    planDenial,
  });

  function emitMobileEvent(event) {
    if (mobileSubscribers.size === 0) return;
    for (const cb of mobileSubscribers) {
      try {
        cb(event);
      } catch {
        /* tek dinleyici hatası akışı düşürmez */
      }
    }
  }

  const lifecycle = createMobileGatewayLifecycle({
    app,
    shellCommit,
    logLine,
    mobilePlanDenial,
    mobileGatewayMod,
    mobileSpriteDir,
    mobileWebRoot,
    mobileListPanes,
    mobilePaneTail,
    mobilePaneTranscript,
    mobileQueryRenderer,
    mobileOfficeSnapshot,
    mobileReports,
    mobileCommandRenderer,
    mobileTranscribe,
    mobileUploads,
    jarvisConv,
    mobileSubscribers,
    mobileDeviceStore,
    mobileStartFailure,
  });

  return {
    mobileSubscribers,
    mobilePending,
    mobileCommandPending,
    getMobileGateway: lifecycle.getMobileGateway,
    getMobileGatewayLastFailure: lifecycle.getMobileGatewayLastFailure,
    mobileSpriteDir,
    mobileWebRoot,
    emitMobileEvent,
    mobilePaneTail,
    mobilePaneTranscript,
    mobileListPanes,
    mobileQueryRenderer,
    mobileCommandRenderer,
    mobileDelegationState,
    mobileOfficeSnapshot,
    shotBridgeAgents,
    shotBridgeSend,
    mobileTranscribe,
    mobilePlanDenial,
    startMobile: lifecycle.startMobile,
    stopMobile: lifecycle.stopMobile,
    mobileStartFailure,
    mobileKillSwitch: lifecycle.mobileKillSwitch,
  };
}

module.exports = { createMobileService };
