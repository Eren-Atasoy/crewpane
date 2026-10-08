'use strict';

/**
 * Task Cleaning & Summary IPC Handlers (Faz 3.5 — Sıra 11)
 * Channels:
 *   - task:cleanTeamDone
 *   - task:cleanAll
 *   - task:listSummary
 */
function registerTaskIpc({
  ipcMain,
  taskBrainService = null,
}) {
  const getService = () => taskBrainService || require('../../services/taskBrainService.cjs');

  ipcMain.handle('task:cleanTeamDone', async (_e, opts) => {
    try {
      return await getService().cleanTeamDoneTasks(opts);
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });

  ipcMain.handle('task:cleanAll', async () => {
    try {
      return await getService().cleanAllTasks();
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });

  ipcMain.handle('task:listSummary', async () => {
    try {
      return await getService().listTasksSummary();
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });
}

module.exports = { registerTaskIpc };
