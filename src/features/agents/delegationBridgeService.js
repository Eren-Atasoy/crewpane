'use strict';

/**
 * Delegation Bridge Service (Faz 3.6.39)
 * Encapsulates the loopback delegation bridge lifecycle (start, stop, query),
 * results directory resolution, and integration callbacks.
 */

const path = require('node:path');
const defaultDelegationBridgeMod = require('../../agents/delegationBridge.js');
const defaultCrewpaneEnv = require('../../config/crewpaneEnv.cjs');
const defaultCrewpanePaths = require('../../config/crewpanePaths.cjs');

const defaultDeps = {
  delegationBridgeMod: defaultDelegationBridgeMod,
  crewpaneEnv: defaultCrewpaneEnv,
  crewpanePaths: defaultCrewpanePaths,
  ensureDelegationSupervisor: () => {},
  resolveWindow: () => null,
  logLine: () => {},
  ipcMain: null,
  runBrowserAction: null,
  probeBrowserTarget: null,
  getBrowserGate: () => null,
  recycleWorkerPanes: null,
  telemetryBump: () => {},
  listPanesForControl: null,
  closePanesForControl: null,
  focusPaneForControl: null,
  authorizeTeamScopeInteractive: null,
  teamComposeRequest: null,
  setComposeTransport: () => {},
  getAgentWorkspaceRoot: () => null,
  shotBridgeAgents: null,
  shotBridgeSend: null,
  ingestTaskAttachment: null,
  notifyLog: null,
  resolveWorkerNotifyPath: () => null,
  appDbTokenFor: () => null,
  integrationsStatusFor: () => null,
  seatDenial: () => null,
  planWaveLimit: () => null,
  deliverDictationToFocusedSurface: () => null,
};

class DelegationBridgeService {
  constructor(deps = {}) {
    this.deps = deps;
    Object.assign(this, defaultDeps, deps);
    this.delegationBridge = null;
  }

  getBridge() {
    return this.delegationBridge;
  }

  resolveResultsDir() {
    const root = this.getAgentWorkspaceRoot();
    const dir =
      this.crewpaneEnv.readEnv('RESULTS_DIR') ||
      this.crewpanePaths.resultsDir(root) ||
      (root ? path.join(root, 'docs', 'agent-results') : null);
    if (!dir) throw new Error('workspace_not_configured: sonuç dizini için çalışma alanı gerekli');
    return dir;
  }

  _buildBridgeOptions() {
    return {
      resolveWindow: this.resolveWindow,
      log: this.logLine,
      ipcMain: this.ipcMain,
      onBrowserAction: this.runBrowserAction,
      onBrowserProbe: this.probeBrowserTarget,
      browserGate: this.getBrowserGate(),
      onRecyclePane: this.recycleWorkerPanes,
      onLeaderAck: (leaderId) => {
        try { this.ensureDelegationSupervisor().ack(String(leaderId || '')); } catch { /* best-effort */ }
      },
      onSupervisorStatus: (leaderId) => {
        try { return this.ensureDelegationSupervisor().leaderStatus(String(leaderId || '')); } catch { return null; }
      },
      onTelemetryBump: (key) => this.telemetryBump(key),
      onListPanes: this.listPanesForControl,
      onClosePane: this.closePanesForControl,
      onFocusPane: this.focusPaneForControl,
      onAuthorizeScope: ({ action, leaderId, targetScope }) =>
        this.authorizeTeamScopeInteractive({ action, leaderId, targetScope }),
      onTeamCompose: (payload, transport) => {
        this.setComposeTransport(transport);
        return this.teamComposeRequest(payload, transport);
      },
      resolveResultsDir: () => this.resolveResultsDir(),
      onShotAgents: this.shotBridgeAgents,
      onShotSend: this.shotBridgeSend,
      onTaskAttachment: (req) => (this.ingestTaskAttachment ? this.ingestTaskAttachment(req) : null),
      onReportNotify: (evt) => {
        if (this.notifyLog && this.resolveWorkerNotifyPath) {
          this.notifyLog.appendWorkerEvent(this.resolveWorkerNotifyPath(evt && evt.department), evt);
        }
      },
      onAppDbToken: () => (this.appDbTokenFor ? this.appDbTokenFor('bridge:/app-db/token') : null),
      onIntegrationsStatus: (req) => (this.integrationsStatusFor ? this.integrationsStatusFor(req) : null),
      onRequireSeat: (action) => (this.seatDenial ? this.seatDenial(action) : null),
      onPlanWave: (requested) => (this.planWaveLimit ? this.planWaveLimit(requested) : null),
      onDictation: (text) => (this.deliverDictationToFocusedSurface ? this.deliverDictationToFocusedSurface(text) : null),
    };
  }

  async startBridge() {
    try {
      this.ensureDelegationSupervisor();
    } catch (e) {
      this.logLine(`supervisor start failed: ${e.message}`);
    }
    if (this.delegationBridge) return this.delegationBridge;
    try {
      const opts = this._buildBridgeOptions();
      this.delegationBridge = await this.delegationBridgeMod.startDelegationBridge(opts);
      this.logLine(`delegation bridge ready port=${this.delegationBridge.info().port}`);
      return this.delegationBridge;
    } catch (err) {
      this.logLine(`delegation bridge failed to start: ${err.message}`);
      this.delegationBridge = null;
      return null;
    }
  }

  stopBridge() {
    const bridge = this.delegationBridge;
    this.delegationBridge = null;
    if (bridge && typeof bridge.stop === 'function') {
      try {
        bridge.stop();
      } catch (err) {
        this.logLine(`delegation bridge stop error: ${err.message}`);
      }
    }
  }
}

function createDelegationBridgeService(deps) {
  return new DelegationBridgeService(deps);
}

module.exports = {
  createDelegationBridgeService,
  DelegationBridgeService,
};
