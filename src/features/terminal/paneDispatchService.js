'use strict';

/**
 * Terminal Pane Dispatch & Leader Refresh Service (Faz 3.6.33)
 * Encapsulates dispatch decisions, context refresh, handoff summaries,
 * and autonomous leader session refresh policies.
 */

const REFRESH_ESC_GAP_MS = 150;
const REFRESH_SUBMIT_GAP_MS = 400;
const REFRESH_GRACE_MS = 3000;
const HANDOFF_POLL_MS = 1_500;
const HANDOFF_MAX_CHARS = 4_000;
const LEADER_GATE_SAMPLE_MS = 400;

const dispatchSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getHandoffTimeoutMs() {
  const raw = Number(process.env.CREWPANE_HANDOFF_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 1_000 && raw < 90_000 ? raw : 90_000;
}

function calculateIdleMinutes(last) {
  if (!last || typeof last.atMs !== 'number') return null;
  return Math.floor(Math.max(0, Date.now() - last.atMs) / 60_000);
}

function paneScreenText(entry) {
  if (!entry) return '';
  if (entry.screen && typeof entry.screen.liveLines === 'function') {
    try {
      const lines = entry.screen.liveLines();
      if (Array.isArray(lines) && lines.length) return lines.join('\n');
    } catch {
      /* degrade -> ham tampon */
    }
  }
  return entry.buffer || '';
}

class PaneDispatchService {
  constructor(deps) {
    this.deps = deps;
    const { tokenCost, dispatchPolicy, createDeliverPrompt, agentxDeliverMod } = deps;
    const corpusWindow =
      (((tokenCost.DEFAULT_PRICING.contextEconomics || {}).dispatch || {}).relatedness || {}).corpusWindow || 50;
    this.dispatchStore = dispatchPolicy.createStore({ corpusWindow });
    this.dispatchApplied = new Map();
    this.leaderRefreshState = new Map();

    this.deliverToPane = createDeliverPrompt({
      readPaneBuffer: (paneId) => {
        const e = this.deps.ptys.get(paneId);
        return e ? e.buffer || '' : '';
      },
      writePane: (paneId, data) => {
        const e = this.deps.ptys.get(paneId);
        if (!e) return false;
        try { e.child.write(data); return true; } catch { return false; }
      },
      sleep: dispatchSleep,
      now: () => Date.now(),
      livePaneCount: () => this.deps.ptys.size,
      log: (line) => this.deps.logLine(line),
    });

    this.deliverToPaneAgentx = createDeliverPrompt({
      readPaneBuffer: (paneId) => paneScreenText(this.deps.ptys.get(paneId)),
      writePane: (paneId, data) => {
        const e = this.deps.ptys.get(paneId);
        if (!e) return false;
        try { e.child.write(data); return true; } catch { return false; }
      },
      sleep: dispatchSleep,
      now: () => Date.now(),
      livePaneCount: () => this.deps.ptys.size,
      log: (line) => this.deps.logLine(line),
    });

    this.agentxDeliverer = agentxDeliverMod.createAgentxDeliver(
      this._buildAgentxDeliverDeps(),
      this._buildAgentxDeliverOpts(),
    );
  }

  _buildAgentxDeliverDeps() {
    return {
      listPanes: () => {
        const out = [];
        for (const [paneId, e] of this.deps.ptys) {
          out.push({ paneId, agentId: e.agentId || null, department: e.department || null, bytes: e.bytes || 0, buffer: paneScreenText(e) });
        }
        return out;
      },
      readPaneBuffer: (paneId) => paneScreenText(this.deps.ptys.get(paneId)),
      deliver: (paneId, text, opts) => this.deliverToPaneAgentx(paneId, text, opts),
      transcriptHas: (paneId, needle) => {
        const entry = this.deps.ptys.get(paneId);
        if (!entry) return null;
        const res = this.deps.transcriptProbe.transcriptContains(
          { cwd: entry.cwd, sessionId: this.deps.currentSessionId(paneId) },
          typeof needle === 'string' ? needle.slice(0, 200) : '',
        );
        return res && res.checked ? res.found : null;
      },
      authorize: ({ actor, target }) => {
        const a = actor && typeof actor === 'object' ? actor : {};
        if (a.kind === 'agent') {
          return this.deps.authorizeTeamScope({ action: 'delegate', leaderId: a.agentId || '', targetScope: target.teamId || '' });
        }
        return { ok: true, via: 'owner' };
      },
      emit: (receipt) => {
        try {
          const win = this.deps.getAppWindow();
          if (win && !win.isDestroyed()) win.webContents.send('agentx:receipt', receipt);
        } catch { /* ignore */ }
        try {
          const w = this.deps.jarvisWidgetAlive();
          if (w) w.webContents.send('agentx:receipt', receipt);
        } catch { /* ignore */ }
      },
      sleep: dispatchSleep,
      now: () => Date.now(),
      log: (line) => this.deps.logLine(line),
    };
  }

  _buildAgentxDeliverOpts() {
    return {
      ...(Number.isFinite(Number(process.env.CREWPANE_AGENTX_VERIFY_MS)) && process.env.CREWPANE_AGENTX_VERIFY_MS ? { verifyMs: Number(process.env.CREWPANE_AGENTX_VERIFY_MS) } : {}),
      ...(Number.isFinite(Number(process.env.CREWPANE_AGENTX_QUEUE_TICK_MS)) && process.env.CREWPANE_AGENTX_QUEUE_TICK_MS ? { queueTickMs: Number(process.env.CREWPANE_AGENTX_QUEUE_TICK_MS) } : {}),
    };
  }

  calculateRelatedness(paneId, textOpt, th) {
    const nextText = typeof textOpt === 'string' ? textOpt : null;
    const cfg = th ? th.relatedness : null;
    return this.deps.dispatchPolicy.relatedness({
      prevText: this.dispatchStore.lastText(paneId),
      nextText,
      corpus: this.dispatchStore.corpus(),
      cfg,
    });
  }

  paneDispatchDecisionFor(paneId, entry, opts = {}) {
    const e = entry || this.deps.ptys.get(paneId);
    if (!e) return null;
    try {
      const isStandard = e.command === 'claude' || e.command === 'codex';
      const engine = isStandard ? e.command : null;
      const usage = this.deps.tokenUsage.usageForPane({
        paneId,
        engine: e.command || null,
        cwd: e.cwd || null,
        sessionId: this.deps.currentSessionId(paneId),
        startedAt: e.startedAt || null,
      });
      const th = this.deps.dispatchPolicy.thresholdsFrom(this.deps.tokenCost.DEFAULT_PRICING, engine);
      const last = usage.lastRequest || null;
      const idleMinutes = calculateIdleMinutes(last);
      const rel = this.calculateRelatedness(paneId, opts.text, th);
      const decision = this.deps.dispatchPolicy.decide({
        measured: usage.sessionFound === true,
        ctxTokens: last ? last.ctxTokens : null,
        idleMinutes,
        requests: typeof usage.sessionRequests === 'number' ? usage.sessionRequests : null,
        related: rel.related,
        thresholds: th,
      });
      return { ...decision, relatedness: rel, engine, applied: this.dispatchApplied.get(paneId) || null };
    } catch (err) {
      this.deps.logLine(`dağıtım kararı alınamadı paneId=${paneId}: ${err.message}`);
      return null;
    }
  }

  logDispatchDecision(paneId, decision, source) {
    const m = (decision && decision.measured) || {};
    const why = (decision.reasons || []).map((r) => `${r.code}(${r.value}≥${r.threshold})`).join(',') || '-';
    this.deps.logLine(
      `dispatch-policy ${String(decision.action).toUpperCase()} paneId=${paneId} kaynak=${source} ` +
        `sebep=${decision.code} bağlam=${m.ctxTokens ?? '?'} boşta=${m.idleMinutes ?? '?'}dk ` +
        `istek=${m.requests ?? '?'} ilişki=${m.related === null || m.related === undefined ? 'ölçülemedi' : m.related} ` +
        `devir=${decision.handoff ? 'evet' : 'hayır'} gerekçe=${why}`,
    );
  }

  sendDispatchEvent(payload) {
    const win = this.deps.getAppWindow();
    if (win && !win.isDestroyed()) win.webContents.send('pty:dispatch-event', payload);
  }

  async writePromptToPane(paneId, text) {
    const res = await this.deliverToPane(paneId, text, {
      submitGapMs: REFRESH_SUBMIT_GAP_MS,
      label: 'devir-özeti',
    });
    return res.delivered;
  }

  async requestHandoffSummary(paneId, entry, decision) {
    const read = () =>
      this.deps.transcriptProbe.lastAssistantMessage({ cwd: entry.cwd, sessionId: this.deps.currentSessionId(paneId) });
    const before = read();
    const baseline = before.checked ? before.text : null;
    const ctxText = decision && decision.measured ? `${decision.measured.ctxTokens} jeton` : 'ölçülen bağlam';
    const prompt =
      `[OTOMATİK DEVİR — bu oturum tazelenecek (${ctxText}); sıradaki iş TAZE bir oturumda başlayacak] ` +
      'TEK mesajda devir özeti yaz: (1) nerede kaldın, (2) dokunduğun dosyalar (yol), ' +
      '(3) açık/riskli nokta, (4) sıradaki adım. En fazla 15 satır. Araç çağırma, başka iş yapma.';
    try {
      await this.writePromptToPane(paneId, prompt);
    } catch (err) {
      return { ok: false, text: null, reason: `write-failed:${err.message}` };
    }
    const deadline = Date.now() + getHandoffTimeoutMs();
    while (Date.now() < deadline) {
      await dispatchSleep(HANDOFF_POLL_MS);
      if (!this.deps.ptys.has(paneId)) return { ok: false, text: null, reason: 'pane-gone' };
      const now = read();
      if (now.checked && typeof now.text === 'string' && now.text.trim() && now.text !== baseline) {
        const clean = this.deps.secretRedactor.redactDeep({ text: now.text.trim() }).text;
        return { ok: true, text: clean.slice(0, HANDOFF_MAX_CHARS), reason: 'ok' };
      }
    }
    return { ok: false, text: null, reason: 'timeout' };
  }

  checkRefreshPreconditions(paneId) {
    const entry = this.deps.ptys.get(paneId);
    if (!entry) return { ok: false, reason: 'no-pane', handoff: null };
    const guard = this.deps.enforcePaneBudget({ paneId, entry, origin: this.deps.spendGuard.SYSTEM_ORIGIN, source: 'dispatch-refresh' });
    if (!guard.allow) return { ok: false, reason: 'budget-paused', handoff: null, budget: guard.decision };
    const resetCmd = entry.command === 'claude' ? '/clear' : entry.command === 'codex' ? '/new' : null;
    if (!resetCmd) return { ok: false, reason: 'engine-not-resettable', handoff: null };
    return { ok: true, entry, resetCmd };
  }

  async deliverPaneReset(paneId, entry, resetCmd) {
    try {
      entry.child.write('\x1b');
      await dispatchSleep(REFRESH_ESC_GAP_MS);
      entry.child.write(resetCmd);
    } catch (err) {
      return { ok: false, reason: `reset-write-failed:${err.message}` };
    }
    try {
      const res = await this.deliverToPane(paneId, resetCmd, {
        mode: 'submit-only',
        submitGapMs: REFRESH_SUBMIT_GAP_MS,
        label: `sıfırlama(${resetCmd})`,
      });
      const resetDelivered = res.delivered;
      if (!resetDelivered) {
        this.deps.logLine(
          `dispatch-policy SIFIRLAMA DOĞRULANAMADI paneId=${paneId} komut=${resetCmd} ` +
            `hüküm=${res.outcome} enter=${res.enters} — ` +
            `oturum SIFIRLANMAMIŞ olabilir (session-anchor bunu ayrıca ölçer)`,
        );
      }
      return { ok: true, resetDelivered };
    } catch (err) {
      return { ok: false, reason: `reset-write-failed:${err.message}` };
    }
  }

  recordRefreshApplied(paneId, entry, { decision, source, handoffResult, resetDelivered }) {
    this.deps.sessionAnchor.markReset(paneId);
    this.dispatchStore.clear(paneId);
    const applied = {
      atMs: Date.now(),
      code: decision ? decision.code : null,
      reasons: decision ? decision.reasons : [],
      handoff: handoffResult.ok,
      handoffReason: handoffResult.reason,
      resetDelivered,
      source: source || null,
    };
    this.dispatchApplied.set(paneId, applied);
    const handoffStr = handoffResult.ok
      ? `evet(${(handoffResult.text || '').length} karakter)`
      : `hayır(${handoffResult.reason})`;
    this.deps.logLine(
      `dispatch-policy TAZELENDİ paneId=${paneId} kaynak=${source} sebep=${applied.code} devir=${handoffStr}`,
    );
    this.sendDispatchEvent({
      kind: 'refreshed',
      paneId,
      agentId: entry.agentId || null,
      decision: decision || null,
      applied,
    });
    return applied;
  }

  async refreshPaneSession(paneId, { handoff, decision, source, requireHandoff }) {
    const pre = this.checkRefreshPreconditions(paneId);
    if (!pre.ok) return pre;
    const { entry, resetCmd } = pre;

    let handoffResult = { ok: false, text: null, reason: 'not-requested' };
    if (handoff) handoffResult = await this.requestHandoffSummary(paneId, entry, decision);
    if (!this.deps.ptys.has(paneId)) return { ok: false, reason: 'pane-gone', handoff: handoffResult };

    const resetGate = this.deps.leaderRefreshPolicy.resetGate({
      requireHandoff,
      handoffRequested: handoff === true,
      handoffOk: handoffResult.ok === true,
    });
    if (resetGate.block) {
      this.deps.logLine(
        `dispatch-policy TAZELEME İPTAL paneId=${paneId} kaynak=${source} sebep=handoff-missing(${handoffResult.reason}) ` +
          '— sıfırlama YAZILMADI, bağlam DURUYOR (LDR-F1 G3)',
      );
      this.sendDispatchEvent({
        kind: 'refresh-blocked',
        paneId,
        agentId: entry.agentId || null,
        decision: decision || null,
        reason: 'handoff-missing',
        handoffReason: handoffResult.reason,
      });
      return { ok: false, reason: 'handoff-missing', handoff: handoffResult };
    }

    const resetRes = await this.deliverPaneReset(paneId, entry, resetCmd);
    if (!resetRes.ok) return { ok: false, reason: resetRes.reason, handoff: handoffResult };

    await dispatchSleep(REFRESH_GRACE_MS);
    const applied = this.recordRefreshApplied(paneId, entry, {
      decision,
      source,
      handoffResult,
      resetDelivered: resetRes.resetDelivered,
    });
    return { ok: true, reason: 'ok', handoff: handoffResult, applied };
  }

  leaderRefreshEntry(paneId) {
    let st = this.leaderRefreshState.get(paneId);
    if (!st) {
      st = {
        attempts: 0,
        lastAttemptAtMs: 0,
        lastRefreshAtMs: 0,
        running: false,
        reason: null,
        lastFailure: null,
        retryAtMs: null,
      };
      this.leaderRefreshState.set(paneId, st);
    }
    return st;
  }

  isLeaderPane(entry) {
    if (!entry) return false;
    return this.deps.leaderRole.isLeaderRoleSlug(entry.role) && entry.disallowSubagent !== true;
  }

  leaderAutoRefreshMode() {
    try {
      return this.deps.leaderRefreshPolicy.normalizeMode(this.deps.agentSettings.readSettings().leaderAutoRefresh);
    } catch {
      return this.deps.leaderRefreshPolicy.DEFAULT_MODE;
    }
  }

  leaderAutoRefreshConfig() {
    try {
      return this.deps.leaderRefreshPolicy.leaderConfigFrom(this.deps.tokenCost.DEFAULT_PRICING);
    } catch {
      return this.deps.leaderRefreshPolicy.leaderConfigFrom(null);
    }
  }

  async sampleLeaderGate(paneId) {
    const before = this.deps.ptys.get(paneId);
    if (!before) return { safe: false, reason: 'no-pane' };
    const prev = before.buffer || '';
    await dispatchSleep(LEADER_GATE_SAMPLE_MS);
    const after = this.deps.ptys.get(paneId);
    if (!after) return { safe: false, reason: 'no-pane' };
    return this.deps.leaderComposer.injectionGate(prev, after.buffer || '', {
      lastInputAt: typeof after.lastInputAt === 'number' ? after.lastInputAt : null,
      lastSubmitAt: typeof after.lastSubmitAt === 'number' ? after.lastSubmitAt : null,
      now: Date.now(),
    });
  }

  leaderRefreshViewFor(paneId, entry, decision) {
    const leader = this.isLeaderPane(entry);
    const mode = this.leaderAutoRefreshMode();
    const cfg = this.leaderAutoRefreshConfig();
    const badge = this.deps.leaderRefreshPolicy.badgeState({ decision, mode, cfg });
    const st = this.leaderRefreshState.get(paneId) || null;
    return {
      isLeader: leader,
      mode,
      state: badge.state,
      pct: badge.pct,
      ctxTokens: badge.ctxTokens,
      threshold: badge.threshold,
      code: badge.code,
      warnPct: Math.round(cfg.warnRatio * 100),
      lastReason: st ? st.reason : null,
      lastFailure: st ? st.lastFailure : null,
      attempts: st ? st.attempts : 0,
      retryAtMs: st ? st.retryAtMs : null,
      lastRefreshAtMs: st ? st.lastRefreshAtMs : 0,
      running: !!(st && st.running),
    };
  }

  async restoreLeaderContext(paneId, entry, handoffText) {
    const text = this.deps.leaderRefreshPolicy.composeLeaderRestorePrompt({
      handoffText,
      openSubtasks: this.deps.delegationSupervisorService.leaderOpenSubtasks(entry.agentId),
      taskCode: entry.taskId || this.deps.labelTaskCodeOf(entry.label) || null,
    });
    if (!text) return { ok: false, reason: 'nothing-to-restore', chars: 0 };
    const gate = await this.sampleLeaderGate(paneId);
    if (!gate.safe) {
      this.deps.logLine(`lider-tazeleme GERİ YÜKLEME ERTELENDİ paneId=${paneId} sebep=enjeksiyon-iptal(${gate.reason})`);
      return { ok: false, reason: `unsafe:${gate.reason}`, chars: text.length };
    }
    const delivered = await this.writePromptToPane(paneId, text);
    this.deps.logLine(
      `lider-tazeleme GERİ YÜKLENDİ paneId=${paneId} karakter=${text.length} teslim=${delivered ? 'ölçüldü' : 'ölçülemedi'}`,
    );
    return { ok: true, reason: delivered ? 'delivered' : 'unverified', chars: text.length };
  }

  leaderRefreshTick(paneId, entry, decision) {
    const st = this.leaderRefreshEntry(paneId);
    if (st.running) return;
    const mode = this.leaderAutoRefreshMode();
    const cfg = this.leaderAutoRefreshConfig();
    const leader = this.isLeaderPane(entry);
    const pre = this.deps.leaderRefreshPolicy.refreshGate({
      decision,
      mode,
      isLeader: leader,
      nowMs: Date.now(),
      attempts: st.attempts,
      lastAttemptAtMs: st.lastAttemptAtMs,
      lastRefreshAtMs: st.lastRefreshAtMs,
      inFlight: 0,
      gate: { safe: true, reason: 'not-sampled' },
      cfg,
    });
    if (!pre.go) {
      st.reason = pre.reason;
      st.retryAtMs = pre.retryAtMs;
      return;
    }

    st.running = true;
    void (async () => {
      try {
        const inFlight = this.deps.delegationSupervisorService.leaderInFlightCount(entry.agentId);
        const gate = inFlight > 0 ? { safe: false, reason: 'delegation-in-flight' } : await this.sampleLeaderGate(paneId);
        const verdict = this.deps.leaderRefreshPolicy.refreshGate({
          decision,
          mode,
          isLeader: leader,
          nowMs: Date.now(),
          attempts: st.attempts,
          lastAttemptAtMs: st.lastAttemptAtMs,
          lastRefreshAtMs: st.lastRefreshAtMs,
          inFlight,
          gate,
          cfg,
        });
        st.reason = verdict.reason;
        st.retryAtMs = verdict.retryAtMs;
        if (!verdict.go) {
          this.deps.logLine(`lider-tazeleme ERTELENDİ paneId=${paneId} sebep=${verdict.reason} bağlam=${(decision.measured || {}).ctxTokens ?? '?'}`);
          return;
        }
        this.logDispatchDecision(paneId, decision, 'leader-auto');
        const res = await this.refreshPaneSession(paneId, {
          handoff: decision.handoff,
          requireHandoff: true,
          decision,
          source: 'leader-auto',
        });
        if (!res.ok) {
          st.attempts += 1;
          st.lastAttemptAtMs = Date.now();
          st.reason = res.reason;
          st.lastFailure = res.reason;
          st.retryAtMs = this.deps.leaderRefreshPolicy.nextRetryAtMs(st.attempts, st.lastAttemptAtMs, cfg);
          this.deps.logLine(
            `lider-tazeleme BAŞARISIZ paneId=${paneId} sebep=${res.reason} deneme=${st.attempts}/${cfg.maxAttempts} ` +
              `sonraki=${new Date(st.retryAtMs).toISOString()}`,
          );
          return;
        }
        st.attempts = 0;
        st.lastAttemptAtMs = Date.now();
        st.lastRefreshAtMs = Date.now();
        st.retryAtMs = null;
        st.reason = 'refreshed';
        st.lastFailure = null;
        const live = this.deps.ptys.get(paneId);
        if (live) await this.restoreLeaderContext(paneId, live, res.handoff && res.handoff.text);
      } catch (err) {
        st.reason = `error:${err.message}`;
        this.deps.logLine(`lider-tazeleme patladı paneId=${paneId}: ${err.message}`);
      } finally {
        st.running = false;
      }
    })();
  }
}

function createPaneDispatchService(deps) {
  return new PaneDispatchService(deps);
}

module.exports = {
  createPaneDispatchService,
  PaneDispatchService,
  dispatchSleep,
  paneScreenText,
  calculateIdleMinutes,
  REFRESH_ESC_GAP_MS,
  REFRESH_SUBMIT_GAP_MS,
  REFRESH_GRACE_MS,
  HANDOFF_POLL_MS,
  HANDOFF_MAX_CHARS,
  LEADER_GATE_SAMPLE_MS,
};
