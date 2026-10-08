'use strict';

/**
 * Pane Transcript & Session Anchor Service (ENG-02 / ADP-705 / Phase 3.6.43)
 * Resolves current engine session IDs and provides engine-aware delivery verification probes.
 */
class PaneTranscriptService {
  constructor({
    ptys,
    paneSessionAnchor,
    transcriptProbe,
    codexRolloutProbe,
    livePaneRegistry,
    crewpaneHome = () => '',
    logLine = () => {},
  } = {}) {
    this._ptys = ptys;
    this._paneSessionAnchor = paneSessionAnchor;
    this._transcriptProbe = transcriptProbe;
    this._codexRolloutProbe = codexRolloutProbe;
    this._livePaneRegistry = livePaneRegistry;
    this._crewpaneHome = crewpaneHome;
    this._logLine = logLine;

    this.sessionAnchor = this._paneSessionAnchor.createSessionAnchor({
      listSessionHeads: (cwd, sinceMs) => this._transcriptProbe.listSessionHeads(cwd, undefined, { sinceMs }),
      log: (line) => this._logLine(line),
    });
  }

  currentSessionId(paneId) {
    const entry = this._ptys.get(paneId);
    if (!entry) return null;
    if (!this.sessionAnchor.isPending(paneId)) return entry.sessionId ?? null;

    const claimedIds = new Set();
    for (const [id, e] of this._ptys) {
      if (id !== paneId && e && e.sessionId) claimedIds.add(e.sessionId);
    }
    const found = this.sessionAnchor.resolve(paneId, {
      cwd: entry.cwd,
      claimedIds,
      knownSessionId: entry.sessionId ?? null,
    });
    if (!found) return null;
    entry.sessionId = found;
    try {
      if (this._livePaneRegistry) {
        this._livePaneRegistry.setSessionId(paneId, found, this._crewpaneHome());
      }
    } catch {
      /* kalıcı kayıt best-effort */
    }
    return found;
  }

  probeTranscriptContains(paneId, needle, o) {
    const entry = this._ptys.get(paneId);
    if (!entry) return { found: false, checked: false, file: null, reason: 'no-pane' };
    const clean = typeof needle === 'string' ? needle.slice(0, 200) : '';
    const engine = entry.command ?? 'claude';
    if (engine === 'claude') {
      const sessionId = o && 'sessionId' in o ? o.sessionId : this.currentSessionId(paneId);
      return this._transcriptProbe.transcriptContains({ cwd: entry.cwd, sessionId }, clean);
    }
    if (engine === 'codex') {
      return this._codexRolloutProbe.rolloutContains({ cwd: entry.cwd, startedAt: entry.startedAt }, clean);
    }
    return { found: false, checked: false, file: null, reason: 'engine-unsupported' };
  }

  probeTranscriptVerdict(paneId, needle, o) {
    const res = this.probeTranscriptContains(paneId, needle, o);
    return res && res.checked ? res.found : null;
  }

  probeTranscriptVerifiable(paneId) {
    const e = this._ptys.get(paneId);
    if (!e) return false;
    const engine = e.command ?? 'claude';
    if (engine === 'claude') return !!(e.sessionId && e.cwd);
    if (engine === 'codex') return this._codexRolloutProbe.rolloutVerifiable({ cwd: e.cwd, startedAt: e.startedAt });
    return false;
  }
}

function createPaneTranscriptService(deps) {
  return new PaneTranscriptService(deps);
}

module.exports = {
  createPaneTranscriptService,
  PaneTranscriptService,
};
