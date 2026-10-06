'use strict';

/**
 * Feedback IPC Handlers (Faz 3.5 — Sıra 1)
 * Channels: feedback:logExcerpt, feedback:recentShots, feedback:shotPreview,
 *           feedback:seen:get, feedback:seen:set
 */
function registerFeedbackIpc({
  ipcMain,
  feedbackBridge,
  readFeedbackSeen,
  writeFeedbackSeen,
}) {
  ipcMain.handle('feedback:logExcerpt', (_event, opts) => feedbackBridge().logExcerpt(opts || {}));
  ipcMain.handle('feedback:recentShots', (_event, opts) => feedbackBridge().recentShots(opts || {}));
  ipcMain.handle('feedback:shotPreview', (_event, opts) => feedbackBridge().shotPreview(opts || {}));
  ipcMain.on('feedback:seen:get', (event) => { event.returnValue = readFeedbackSeen(); });
  ipcMain.handle('feedback:seen:set', (_event, state) => writeFeedbackSeen(state));
}

module.exports = { registerFeedbackIpc };
