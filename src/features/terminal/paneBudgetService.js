'use strict';

/**
 * Pane Budget & Spend Guard Enforcement Service (TOK-C / D-02 v2 / Phase 3.6.43)
 * Provides single point of spend guard enforcement across automated and human pane writes.
 */
class PaneBudgetService {
  constructor({
    ptys,
    currentSessionId = () => null,
    paneBudgetStore,
    tokenUsage,
    spendGuard,
    getAppWindow = () => null,
    logLine = () => {},
  } = {}) {
    this._ptys = ptys;
    this._currentSessionId = currentSessionId;
    this._paneBudgetStore = paneBudgetStore;
    this._tokenUsage = tokenUsage;
    this._spendGuard = spendGuard;
    this._getAppWindow = getAppWindow;
    this._logLine = logLine;
  }

  paneBudgetDecisionFor(paneId, entry) {
    const e = entry || this._ptys.get(paneId);
    if (!e) return null;
    try {
      return this._paneBudgetStore.decide(
        paneId,
        this._tokenUsage.usageForPane({
          paneId,
          engine: e.command ?? null,
          cwd: e.cwd ?? null,
          sessionId: this._currentSessionId(paneId),
          startedAt: e.startedAt ?? null,
        }),
      );
    } catch (err) {
      this._logLine(`pane bütçe kararı alınamadı paneId=${paneId}: ${err.message}`);
      return null;
    }
  }

  enforcePaneBudget({ paneId, entry, origin, source }) {
    const verdict = this._spendGuard.allowWrite({ origin, decision: null });
    if (verdict.allow && verdict.reason === 'human-input') {
      return { allow: true, decision: null, reason: verdict.reason };
    }
    const decision = this.paneBudgetDecisionFor(paneId, entry);
    const res = this._spendGuard.allowWrite({ origin, decision });
    if (res.allow) return { allow: true, decision, reason: res.reason };

    this._logLine(
      `${source} BÜTÇE DURAKLATTI paneId=${paneId} ölçüt=${decision.metric} ` +
        `kullanılan=${decision.used} limit=${decision.effectiveLimit} devam=${decision.resumeCount}`,
    );

    const e = entry || this._ptys.get(paneId);
    const win = this._getAppWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('pty:budget-event', {
        kind: 'blocked',
        source,
        paneId,
        agentId: (e && e.agentId) || null,
        budget: decision,
      });
    }
    return { allow: false, decision, reason: res.reason };
  }
}

function createPaneBudgetService(deps) {
  return new PaneBudgetService(deps);
}

module.exports = {
  createPaneBudgetService,
  PaneBudgetService,
};
