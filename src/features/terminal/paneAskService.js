'use strict';

/**
 * Pane Ask & Decision Card Runtime Service (Faz 3.6.40)
 * Encapsulates detection and delivery of leader questions (decision cards),
 * screen reading from VT / pty buffers, desktop IPC broadcasting,
 * and mirroring to Jarvis conversation approvals.
 */

const { BrowserWindow: ElectronBrowserWindow } = require('electron');
const defaultPaneAskMod = require('../../terminal/paneAsk.cjs');
const defaultDelegationBridgeMod = require('../../agents/delegationBridge.js');

const PANE_ASK_MIRROR_MAX = 4;

const defaultDeps = {
  paneAskMod: defaultPaneAskMod,
  cleanPaneTail: defaultDelegationBridgeMod.cleanPaneTail,
  BrowserWindow: ElectronBrowserWindow,
  ptys: null,
  deliverToPane: null,
  getJarvisConv: () => null,
  appI18n: null,
  logLine: () => {},
  submitGapMs: 350,
  mirrorMax: PANE_ASK_MIRROR_MAX,
};

class PaneAskService {
  constructor(deps = {}) {
    this.deps = deps;
    Object.assign(this, defaultDeps, deps);
    this.paneAskMirrored = new Set();
    this.runtime = this._createRuntime();
    this.paneAskRuntime = this.runtime;
    this._wireMirrorResolved();
  }

  getRuntime() {
    return this.runtime;
  }

  _readScreenLines(paneId) {
    if (!this.ptys) return [];
    const e = this.ptys.get(paneId);
    if (!e) return null;
    if (e.screen && typeof e.screen.liveLines === 'function') {
      const lines = e.screen.liveLines();
      if (Array.isArray(lines)) return lines;
    }
    const clean = this.cleanPaneTail ? this.cleanPaneTail(e.buffer || '', 60) : '';
    return clean ? clean.split('\n') : [];
  }

  _paneInfo(paneId) {
    if (!this.ptys) return null;
    const e = this.ptys.get(paneId);
    return e ? { agentId: e.agentId || null } : null;
  }

  _deliver(paneId, text) {
    if (typeof this.deliverToPane === 'function') {
      return this.deliverToPane(paneId, text, {
        submitGapMs: this.submitGapMs,
        label: 'karar-kartı',
      });
    }
    return null;
  }

  _emit(event) {
    const windows = this.BrowserWindow ? this.BrowserWindow.getAllWindows() : [];
    for (const w of windows) {
      try {
        if (!w.isDestroyed()) w.webContents.send('paneAsk:changed', event);
      } catch {
        /* closing window does not break stream */
      }
    }
  }

  _mirrorOpen(ask) {
    if (!ask.options.length || ask.options.length > this.mirrorMax) return;
    const jarvisConv = this.getJarvisConv ? this.getJarvisConv() : null;
    if (!jarvisConv) return;
    const e = this.ptys ? this.ptys.get(ask.paneId) : null;
    const who = (e && (e.label || e.agentId)) || ask.agentId || '';
    const title = this.appI18n ? this.appI18n.t('main.ask.title', { agent: who }) : `Soru: ${who}`;
    const detail = `${ask.question}\n${ask.options.map((o, i) => `${i + 1}) ${o.label}`).join('\n')}`;
    const opened = jarvisConv.openApproval({
      id: ask.id,
      title,
      detail,
      source: 'desktop',
      choices: ask.options.map((o) => ({ id: o.id, label: o.label })),
    });
    if (opened) this.paneAskMirrored.add(ask.id);
  }

  _mirrorClose(askId) {
    if (!this.paneAskMirrored.delete(askId)) return;
    const jarvisConv = this.getJarvisConv ? this.getJarvisConv() : null;
    if (!jarvisConv) return;
    try {
      jarvisConv.closeApproval(askId, 'expired');
    } catch {
      /* already closed */
    }
  }

  _createRuntime() {
    return this.paneAskMod.createPaneAskRuntime({
      readScreenLines: (paneId) => this._readScreenLines(paneId),
      paneInfo: (paneId) => this._paneInfo(paneId),
      deliver: (paneId, text) => this._deliver(paneId, text),
      emit: (event) => this._emit(event),
      mirror: {
        open: (ask) => this._mirrorOpen(ask),
        close: (askId) => this._mirrorClose(askId),
      },
      log: (line) => this.logLine(line),
    });
  }

  _wireMirrorResolved() {
    const jarvisConv = this.getJarvisConv ? this.getJarvisConv() : null;
    if (!jarvisConv || typeof jarvisConv.onChange !== 'function') return;
    jarvisConv.onChange((event) => {
      if (!event || event.type !== 'approval-resolved') return;
      if (!this.paneAskMirrored.has(event.approvalId)) return;
      this.paneAskMirrored.delete(event.approvalId);
      if (event.status === 'expired') return;
      void this.runtime.onMirrorResolved(event.approvalId, event.status, event.choice || null);
    });
  }
}

function createPaneAskService(deps) {
  return new PaneAskService(deps);
}

module.exports = {
  createPaneAskService,
  PaneAskService,
  PANE_ASK_MIRROR_MAX,
};
