'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const {
  IPC_TIMEOUT_MS,
  HANDSHAKE_RETRY_DELAYS_MS,
  HANDSHAKE_REFRESH_MS,
} = require('./constants.cjs');
const { mintToken, paneRecordForAgent } = require('./securityToken.cjs');
const { writeHandshake, removeHandshake } = require('./handshake.cjs');
const { createBridgeRequestHandler } = require('./httpRouter.cjs');

function startDelegationBridge(opts) {
  const {
    resolveWindow,
    log = () => {},
    ipcMain,
    onBrowserAction,
    onBrowserProbe,
    browserGate,
    resolveResultsDir,
    onRecyclePane,
    onListPanes,
    onClosePane,
    onFocusPane,
    onShotAgents,
    onShotSend,
    onTaskAttachment,
    onReportNotify,
    onAppDbToken,
    onRequireSeat,
    onPlanWave,
    onLeaderAck,
    onSupervisorStatus,
    onAuthorizeScope,
    onIntegrationsStatus,
    resolveAgentRecord,
    onTelemetryBump,
    onDictation,
    onTeamCompose,
  } = opts || {};

  const token = mintToken();
  const resolveDelegateAgent =
    typeof resolveAgentRecord === 'function' ? resolveAgentRecord : (agentId) => paneRecordForAgent(agentId);

  // Pending main→renderer round-trips, keyed by requestId.
  const pending = new Map();

  // One result listener for delegate + status + browser-approval; by requestId.
  const onResult = (_event, res) => {
    if (!res || typeof res.requestId !== 'string') return;
    const entry = pending.get(res.requestId);
    if (!entry) return;
    pending.delete(res.requestId);
    clearTimeout(entry.timer);
    entry.resolve(res);
  };

  ipcMain.on('delegation:start:result', onResult);
  ipcMain.on('delegation:status:result', onResult);
  ipcMain.on('browser:approval:result', onResult); // ADP-095
  ipcMain.on('sprint:start:result', onResult); // ADP-242
  ipcMain.on('sprint:status:result', onResult); // ADP-242
  ipcMain.on('sprint:stop:result', onResult); // DF-03
  ipcMain.on('team-compose:propose:result', onResult);
  ipcMain.on('team-compose:apply:result', onResult);
  ipcMain.on('team-compose:undo:result', onResult);

  async function authorizeScope(action, leaderId, targetScope) {
    if (typeof onAuthorizeScope !== 'function') return { ok: true };
    try {
      const res = await onAuthorizeScope({ action, leaderId, targetScope });
      return res && typeof res === 'object' ? res : { ok: true };
    } catch (err) {
      log(`kapsam kararı verilemedi (${action}): ${String((err && err.message) || err)}`);
      return { ok: true };
    }
  }

  function callRenderer(channel, payload, timeoutMs = IPC_TIMEOUT_MS) {
    const win = resolveWindow();
    if (!win || win.isDestroyed()) return Promise.reject(new Error('no app window'));
    const requestId = crypto.randomBytes(12).toString('hex');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error('renderer timeout'));
      }, timeoutMs);
      pending.set(requestId, { resolve, timer });
      win.webContents.send(channel, { requestId, ...payload });
    });
  }

  const handler = createBridgeRequestHandler({
    token,
    log,
    callRenderer,
    authorizeScope,
    resolveDelegateAgent,
    resolveResultsDir,
    onBrowserAction,
    onBrowserProbe,
    browserGate,
    onRecyclePane,
    onListPanes,
    onClosePane,
    onFocusPane,
    onShotAgents,
    onShotSend,
    onTaskAttachment,
    onReportNotify,
    onAppDbToken,
    onRequireSeat,
    onPlanWave,
    onLeaderAck,
    onSupervisorStatus,
    onIntegrationsStatus,
    onTelemetryBump,
    onDictation,
    onTeamCompose,
  });

  const server = http.createServer(handler);

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const retryTimers = [];
      if (!writeHandshake(port, token, log)) {
        for (const delayMs of HANDSHAKE_RETRY_DELAYS_MS) {
          const t = setTimeout(() => writeHandshake(port, token, log), delayMs);
          if (typeof t.unref === 'function') t.unref();
          retryTimers.push(t);
        }
      }
      const refreshTimer = setInterval(() => writeHandshake(port, token, log), HANDSHAKE_REFRESH_MS);
      if (typeof refreshTimer.unref === 'function') refreshTimer.unref();
      log(`delegation bridge listening on 127.0.0.1:${port}`);
      resolve({
        port,
        token,
        info: () => ({ port, token }),
        stop: () => {
          ipcMain.removeListener('delegation:start:result', onResult);
          ipcMain.removeListener('delegation:status:result', onResult);
          ipcMain.removeListener('browser:approval:result', onResult);
          ipcMain.removeListener('sprint:start:result', onResult);
          ipcMain.removeListener('sprint:status:result', onResult);
          ipcMain.removeListener('sprint:stop:result', onResult);
          ipcMain.removeListener('team-compose:propose:result', onResult);
          ipcMain.removeListener('team-compose:apply:result', onResult);
          ipcMain.removeListener('team-compose:undo:result', onResult);
          for (const { timer } of pending.values()) clearTimeout(timer);
          pending.clear();
          clearInterval(refreshTimer);
          for (const t of retryTimers) clearTimeout(t);
          try {
            server.close();
          } catch {
            /* already closed */
          }
          removeHandshake(log);
        },
      });
    });
  });
}

module.exports = {
  startDelegationBridge,
};
