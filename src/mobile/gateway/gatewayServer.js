// CrewPane — Mobile Gateway HTTP & SSE Server (Phase 4.12)
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const auth = require('../mobileAuth.cjs');
const store = require('../mobileDeviceStore.cjs');
const instancePaths = require('../../config/instancePaths.cjs');

const {
  DEFAULT_PORT,
  SSE_PING_MS,
  RATE_MAX,
} = require('./constants.js');

const { handleGatewayRequest } = require('./requestRouter.js');

/**
 * @param {object} opts
 * @param {() => Array} opts.listPanes
 * @param {(paneId:string, opts:{lines:number,before:?number,since:?number}) => object|null} opts.paneTail
 * @param {(kind:'delegations'|'tasks'|'task'|'agents', params:object) => Promise<object>} opts.queryRenderer
 * @param {() => Promise<{agents:Array, delegations:object, alerts:Array}>} opts.officeSnapshot
 * @param {(cb:(event:object)=>void) => (()=>void)} opts.subscribe
 * @param {(msg:string)=>void} [opts.log]
 * @param {number} [opts.port]
 */
async function startMobileGateway(opts) {
  const log = opts.log || (() => {});
  const spriteDir = opts.spriteDir || null;
  const webRoot = (() => {
    try {
      const d = opts.webRoot ? path.resolve(String(opts.webRoot)) : null;
      return d && fs.existsSync(path.join(d, 'index.html')) ? d : null;
    } catch {
      return null;
    }
  })();
  const port = Number(opts.port || process.env.CREWPANE_MOBILE_PORT || DEFAULT_PORT);
  const bind = store.resolveBindHost();
  const instance = instancePaths.instanceId();
  const appInfo = opts.appInfo || {};
  const appVersion = appInfo.version != null ? String(appInfo.version) : null;
  const appCommit = appInfo.commit != null ? String(appInfo.commit) : null;

  let state = store.loadState();
  if (!state.enabled) {
    log(`mobile gateway: KAPALI (kill-switch) — ~/.crewpane*/mobile-devices.json enabled:false`);
    return null;
  }

  const pending = new Map(); // eşleşme kodu → {expiresAt}
  const allow = auth.makeRateLimiter(RATE_MAX, 60_000);
  const sseClients = new Set();

  function reloadState() {
    state = store.loadState();
    return state;
  }
  function persist() {
    store.saveState(state);
  }
  function audit(fields) {
    store.appendAudit(auth.auditLine(fields));
  }

  function openStream(req, res, device) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    const write = (event) => {
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        /* kapanmış istemci */
      }
    };
    write({ type: 'hello', instance, scope: device.scope, at: Date.now() });
    const ping = setInterval(() => write({ type: 'ping', at: Date.now() }), SSE_PING_MS);
    const client = { write, device };
    sseClients.add(client);
    store.appendAudit(auth.auditLine({ deviceId: device.id, deviceName: device.name, method: 'GET', path: '/m/stream', status: 200, note: 'SSE açıldı' }));
    req.on('close', () => {
      clearInterval(ping);
      sseClients.delete(client);
    });
  }

  const ctx = {
    bind,
    instance,
    appVersion,
    appCommit,
    webRoot,
    spriteDir,
    pending,
    allow,
    getState: () => state,
    reloadState,
    persist,
    audit,
    openStream,
    opts,
    log,
  };

  const server = http.createServer((req, res) => handleGatewayRequest(req, res, ctx));

  /** DI'dan gelen canlı olayları tüm SSE istemcilerine yay (READ kapsamı yeter). */
  const unsubscribe = opts.subscribe
    ? opts.subscribe((event) => {
        for (const c of sseClients) c.write(event);
      })
    : () => {};

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bind.host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const actual = server.address();
  log(
    `mobile gateway: ${bind.host}:${actual.port} (${bind.kind}${bind.reason ? ` — ${bind.reason}` : ''}) ` +
      `instance=${instance} cihaz=${state.devices.filter((d) => !d.revokedAt).length} ` +
      `web=${webRoot ? webRoot : 'YOK (yalnız API — mobile/dist üretilmemiş)'}`,
  );

  return {
    info: () => ({
      host: bind.host,
      port: actual.port,
      bindKind: bind.kind,
      bindReason: bind.reason || null,
      instance,
      baseUrl: `http://${bind.host}:${actual.port}`,
      webUi: !!webRoot,
      devices: store.loadState().devices.map((d) => ({ id: d.id, name: d.name, scope: d.scope, revokedAt: d.revokedAt, lastSeenAt: d.lastSeenAt })),
    }),
    createPairing: () => {
      const { code, expiresAt } = auth.mintPairingCode();
      pending.set(code, { expiresAt });
      const payload = { v: 1, baseUrl: `http://${bind.host}:${actual.port}`, code, instance };
      store.appendAudit(auth.auditLine({ method: 'LOCAL', path: '/pair/create', status: 200, note: 'eşleşme kodu üretildi' }));
      return { ...payload, expiresAt, qr: JSON.stringify(payload) };
    },
    setDeviceScope: (deviceId, scope) => {
      const next = scope === 'command' ? 'command' : 'read';
      const s = store.loadState();
      const d = s.devices.find((x) => x.id === deviceId);
      if (!d || d.revokedAt) return false;
      d.scope = next;
      store.saveState(s);
      state = s;
      store.appendAudit(
        auth.auditLine({ deviceId, deviceName: d.name, method: 'LOCAL', path: '/device/scope', status: 200, note: `yetki → ${next}` }),
      );
      log(`mobile gateway: cihaz yetkisi ${deviceId} → ${next}`);
      return true;
    },
    revokeDevice: (deviceId) => {
      const s = store.loadState();
      const d = s.devices.find((x) => x.id === deviceId);
      if (!d) return false;
      d.revokedAt = Date.now();
      store.saveState(s);
      state = s;
      store.appendAudit(auth.auditLine({ deviceId, method: 'LOCAL', path: '/device/revoke', status: 200, note: 'cihaz iptal edildi' }));
      log(`mobile gateway: cihaz iptal edildi ${deviceId}`);
      return true;
    },
    stop: () => {
      try {
        unsubscribe();
      } catch {
        /* ignore */
      }
      for (const c of sseClients) {
        try {
          c.write({ type: 'alert', severity: 'warning', title: 'Mobil erişim kapatıldı', detail: 'kill-switch', at: Date.now() });
        } catch {
          /* ignore */
        }
      }
      sseClients.clear();
      server.close();
      try {
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
      } catch {
        /* eski Node: en azından yeni bağlantı kabul edilmiyor */
      }
      store.appendAudit(auth.auditLine({ method: 'LOCAL', path: '/gateway/stop', status: 200, note: 'gateway durduruldu' }));
      log('mobile gateway: durduruldu (kill-switch)');
    },
  };
}

module.exports = {
  startMobileGateway,
};
