'use strict';

/**
 * Jarvis Conversation Service (Faz 3.6.40)
 * Encapsulates the main-side Jarvis conversation store, desktop window event broadcasting,
 * and mobile SSE event forwarding.
 */

const { BrowserWindow: ElectronBrowserWindow } = require('electron');
const defaultJarvisConversationMod = require('../../voice/jarvisConversation.cjs');

class JarvisConversationService {
  constructor(deps = {}) {
    this.deps = deps;
    this.jarvisConversationMod = deps.jarvisConversationMod || defaultJarvisConversationMod;
    this.logLine = deps.logLine || (() => {});
    this.BrowserWindow = deps.BrowserWindow || ElectronBrowserWindow;
    this.emitMobileEvent = deps.emitMobileEvent || (() => {});

    this.conversation = this.jarvisConversationMod.createConversation({ log: this.logLine });
    this._wireBroadcaster();
  }

  getConversation() {
    return this.conversation;
  }

  _wireBroadcaster() {
    this.conversation.onChange((event) => {
      if (!event) return;
      // 1) Desktop panel — send to all open windows
      const windows = this.BrowserWindow ? this.BrowserWindow.getAllWindows() : [];
      for (const w of windows) {
        try {
          if (!w.isDestroyed()) w.webContents.send('jarvis:conv:changed', event);
        } catch {
          /* closing window does not break stream */
        }
      }
      // 2) Phone — SSE (/m/stream)
      if (event.type === 'turn') {
        this.emitMobileEvent({ type: 'jarvis-turn', turn: event.turn, at: event.turn.at });
      } else if (event.type === 'approval') {
        const a = event.approval;
        this.emitMobileEvent({
          type: 'approval',
          approvalId: a.id,
          title: a.title,
          detail: a.detail,
          choices: a.choices,
          at: a.at,
        });
      } else if (event.type === 'approval-resolved') {
        this.emitMobileEvent({
          type: 'approval-resolved',
          approvalId: event.approvalId,
          status: event.status,
          choice: event.choice ?? null,
          at: Date.now(),
        });
      }
    });
  }
}

function createJarvisConversationService(deps) {
  return new JarvisConversationService(deps);
}

module.exports = {
  createJarvisConversationService,
  JarvisConversationService,
};
