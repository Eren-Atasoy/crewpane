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
  paneControlService: null,
  teamComposeService: null,
  delegationSupervisorService: null,
  telemetryService: null,
  mediaService: null,
  ptyResumeService: null,
  ensureDelegationSupervisor: null,
  resolveWindow: () => null,
  logLine: () => {},
  ipcMain: null,
  runBrowserAction: null,
  probeBrowserTarget: null,
  getBrowserGate: () => null,
  recycleWorkerPanes: null,
  telemetryBump: null,
  listPanesForControl: null,
  closePanesForControl: null,
  focusPaneForControl: null,
  authorizeTeamScopeInteractive: null,
  teamComposeRequest: null,
  setComposeTransport: () => {},
  getAgentWorkspaceRoot: () => null,
  mobileService: null,
  shotBridgeAgents: null,
  shotBridgeSend: null,
  ingestTaskAttachment: null,
  notifyLog: null,
  resolveWorkerNotifyPath: null,
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

  _ensureSupervisor() {
    if (this.delegationSupervisorService) {
      try { return this.delegationSupervisorService.ensureDelegationSupervisor(); } catch { return null; }
    }
    if (typeof this.ensureDelegationSupervisor === 'function') {
      try { return this.ensureDelegationSupervisor(); } catch { return null; }
    }
    return null;
  }

  _buildBridgeOptions() {
    const ctl = this.paneControlService;
    const tc = this.teamComposeService;
    const rst = this.ptyResumeService;
    const med = this.mediaService;
    return {
      resolveWindow: this.resolveWindow,
      log: this.logLine,
      ipcMain: this.ipcMain,
      onBrowserAction: this.runBrowserAction,
      onBrowserProbe: this.probeBrowserTarget,
      browserGate: this.getBrowserGate(),
      onRecyclePane: this.recycleWorkerPanes || (ctl ? (a, m) => ctl.recycleWorkerPanes(a, m) : null),
      onLeaderAck: (leaderId) => {
        const s = this._ensureSupervisor();
        if (s) { try { s.ack(String(leaderId || '')); } catch { /* best-effort */ } }
      },
      onSupervisorStatus: (leaderId) => {
        const s = this._ensureSupervisor();
        return (s && typeof s.leaderStatus === 'function') ? s.leaderStatus(String(leaderId || '')) : null;
      },
      onTelemetryBump: (key) => (this.telemetryBump ? this.telemetryBump(key) : (this.telemetryService ? this.telemetryService.telemetryBump(key) : null)),
      onListPanes: this.listPanesForControl || (ctl ? (c) => ctl.listPanesForControl(c) : null),
      onClosePane: this.closePanesForControl || (ctl ? (p) => ctl.closePanesForControl(p) : null),
      onFocusPane: this.focusPaneForControl || (ctl ? (p, c) => ctl.focusPaneForControl(p, c) : null),
      onAuthorizeScope: this.authorizeTeamScopeInteractive || (ctl ? (opts) => ctl.authorizeTeamScopeInteractive(opts) : null),
      onTeamCompose: (payload, transport) => {
        this.setComposeTransport(transport);
        if (tc) {
          tc.setComposeTransport(transport);
          return tc.teamComposeRequest(payload, transport);
        }
        return this.teamComposeRequest ? this.teamComposeRequest(payload, transport) : null;
      },
      resolveResultsDir: () => this.resolveResultsDir(),
      onShotAgents: this.shotBridgeAgents || (this.deps.mobileService ? () => this.deps.mobileService.shotBridgeAgents() : null),
      onShotSend: this.shotBridgeSend || (this.deps.mobileService ? (opts) => this.deps.mobileService.shotBridgeSend(opts) : null),
      onTaskAttachment: (req) => (this.ingestTaskAttachment ? this.ingestTaskAttachment(req) : (med ? med.ingestTaskAttachment(req) : null)),
      onReportNotify: (evt) => {
        const resolvePath = this.resolveWorkerNotifyPath || (rst ? (d) => rst.resolveWorkerNotifyPath(d) : null);
        if (this.notifyLog && resolvePath) {
          this.notifyLog.appendWorkerEvent(resolvePath(evt && evt.department), evt);
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
      this._ensureSupervisor();
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
