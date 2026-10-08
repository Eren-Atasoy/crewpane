'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SHOT_BRIDGE_MAX_BYTES = 25 * 1024 * 1024; // makul PNG tavanı (5K tam ekran ~10MB)

function createMobileService({
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
}) {
  const mobileSubscribers = new Set();
  const mobilePending = new Map();
  const mobileCommandPending = new Map();

  let mobileGateway = null;
  let mobileGatewayLastFailure = null;
  let mobileUploadsSweepTimer = null;

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

  function mobileTranscribe(payload) {
    return jarvisVoice.transcribeWhisper({ ...(payload || {}), apiKey: jarvisVoice.openAiKey(repoRoot) });
  }

  function mobilePlanDenial({ notify = true } = {}) {
    return planDenial('mobileRemote', 0, { notify });
  }

  function mobileStartFailure(err) {
    const i18nMod = require('../../../i18n/index.cjs');
    return require('../../mobile/mobileStartFailure.cjs').mobileStartFailure(err, (k) => i18nMod.t(k));
  }

  async function startMobile() {
    if (mobileGateway) return mobileGateway;
    const planGate = mobilePlanDenial({ notify: false });
    if (planGate) {
      logLine(`mobile gateway: plan tavanı — kalkmadı (katman=${planGate.tier}); cihaz defteri diskte KORUNUYOR`);
      return null;
    }
    try {
      mobileGateway = await mobileGatewayMod.startMobileGateway({
        log: logLine,
        appInfo: { version: app.getVersion(), commit: shellCommit },
        spriteDir: mobileSpriteDir(),
        webRoot: mobileWebRoot(),
        listPanes: mobileListPanes,
        paneTail: mobilePaneTail,
        paneTranscript: mobilePaneTranscript,
        queryRenderer: mobileQueryRenderer,
        officeSnapshot: mobileOfficeSnapshot,
        reportsList: (params) => mobileReports.listReports({ params }),
        reportRead: (reportId, opts) => mobileReports.readReport({ reportId, page: opts && opts.page }),
        command: mobileCommandRenderer,
        transcribe: mobileTranscribe,
        saveUpload: (p) => mobileUploads.saveUpload(p),
        resolveUpload: (id) => mobileUploads.resolveUpload(id),
        jarvisHistory: (q) => jarvisConv.history(q),
        killSwitch: mobileKillSwitch,
        subscribe: (cb) => {
          mobileSubscribers.add(cb);
          return () => mobileSubscribers.delete(cb);
        },
      });
    } catch (err) {
      logLine(`mobile gateway failed to start: ${err.message}`);
      mobileGateway = null;
      mobileGatewayLastFailure = mobileStartFailure(err);
    }
    if (mobileGateway && !mobileUploadsSweepTimer) {
      const sweep = () => {
        try {
          const n = mobileUploads.sweepUploads({});
          if (n) logLine(`mobile uploads: ${n} eski gün klasörü temizlendi`);
        } catch (err) {
          logLine(`mobile uploads: temizlik hatası: ${err.message}`);
        }
      };
      sweep();
      mobileUploadsSweepTimer = setInterval(sweep, 24 * 60 * 60 * 1000);
      mobileUploadsSweepTimer.unref?.();
    }
    return mobileGateway;
  }

  function mobileKillSwitch() {
    const state = mobileDeviceStore.loadState();
    state.enabled = false;
    mobileDeviceStore.saveState(state);
    if (mobileGateway) {
      mobileGateway.stop();
      mobileGateway = null;
    }
    logLine('mobile gateway: KILL-SWITCH — mobil erişim kapatıldı');
    return { ok: true };
  }

  function stopMobile() {
    if (mobileGateway) {
      try {
        mobileGateway.stop();
      } catch {
        /* best-effort */
      }
      mobileGateway = null;
    }
    if (mobileUploadsSweepTimer) {
      clearInterval(mobileUploadsSweepTimer);
      mobileUploadsSweepTimer = null;
    }
  }

  return {
    mobileSubscribers,
    mobilePending,
    mobileCommandPending,
    getMobileGateway: () => mobileGateway,
    getMobileGatewayLastFailure: () => mobileGatewayLastFailure,
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
    startMobile,
    stopMobile,
    mobileStartFailure,
    mobileKillSwitch,
  };
}

module.exports = { createMobileService };
