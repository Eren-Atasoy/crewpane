'use strict';

/**
 * Workspace Management & Worker Notification IPC Handlers (Faz 3.5 — Sıra 11)
 * Channels:
 *   - notify:workerEvent
 *   - workspace:provision
 *   - workspace:switch
 */
function registerWorkspaceIpc({
  ipcMain,
  app,
  BrowserWindow,
  dialog,
  appI18n,
  supervisorFor = () => ({ run: (_name, fn, fallback) => { try { return fn(); } catch { return fallback; } } }),
  notifyGate = () => ({ admit: () => ({ accepted: true }) }),
  workspacePlanDenial = () => null,
  workspaceOnboarding,
  rememberWorkspaceRoot = () => {},
  switchWorkspaceRoot = () => ({ ok: false }),
  logLine = () => {},
}) {
  ipcMain.handle('notify:workerEvent', (_event, evt) =>
    supervisorFor('notify-log').run(
      'workerEvent',
      () => {
        const res = notifyGate().admit(evt || {});
        return { ok: res.accepted, duplicate: res.duplicate === true };
      },
      { ok: false },
    ));

  ipcMain.handle('workspace:provision', async (event, req) => {
    const mode = req && typeof req === 'object' ? req.mode : null;
    const forbiddenPrefix = app.isPackaged ? process.resourcesPath : null;

    const planReject = (denial) => {
      logLine(`workspace:provision REDDEDİLDİ (plan): ${denial.tier} tavan=${denial.limit} kullanım=${denial.current}`);
      return {
        ok: false,
        reason: 'plan_limit',
        error: denial.message,
        title: denial.title,
        limit: denial.limit,
        current: denial.current,
        tier: denial.tier,
        requiredTier: denial.requiredTier,
        action: 'upgrade',
      };
    };

    if (mode === 'create') {
      const gate = workspacePlanDenial(workspaceOnboarding.defaultWorkspaceDir());
      if (gate) return planReject(gate);
      const res = workspaceOnboarding.provisionDefaultWorkspace({ forbiddenPrefix });
      logLine(`workspace:provision create → ${res.ok ? res.root : `FAIL ${res.reason}`}`);
      if (res.ok) rememberWorkspaceRoot(res.root);
      return res;
    }

    if (mode === 'pick') {
      const win = BrowserWindow.fromWebContents(event.sender);
      let result;
      try {
        result = await dialog.showOpenDialog(win ?? undefined, {
          title: appI18n.t('main.dialog.chooseWorkspace.title'),
          buttonLabel: appI18n.t('main.dialog.chooseWorkspace.button'),
          properties: ['openDirectory', 'createDirectory'],
        });
      } catch (err) {
        return { ok: false, reason: 'dialog-failed', detail: err.message };
      }
      if (!result || result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
        return { ok: false, reason: 'canceled' };
      }
      const gate = workspacePlanDenial(result.filePaths[0]);
      if (gate) return planReject(gate);
      const res = workspaceOnboarding.commitWorkspaceRoot(result.filePaths[0], { forbiddenPrefix });
      logLine(`workspace:provision pick → ${res.ok ? res.root : `FAIL ${res.reason}`}`);
      if (res.ok) rememberWorkspaceRoot(res.root);
      return res;
    }

    return { ok: false, reason: 'bad-mode' };
  });

  ipcMain.handle('workspace:switch', async (event, req) => {
    const mode = req && typeof req === 'object' ? req.mode : null;
    if (mode === 'pick') {
      const win = BrowserWindow.fromWebContents(event.sender);
      let result;
      try {
        result = await dialog.showOpenDialog(win ?? undefined, {
          title: appI18n.t('main.dialog.switchWorkspace.title'),
          buttonLabel: appI18n.t('main.dialog.chooseWorkspace.button'),
          properties: ['openDirectory', 'createDirectory'],
        });
      } catch (err) {
        return { ok: false, reason: 'dialog-failed', detail: err.message };
      }
      if (!result || result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
        return { ok: false, reason: 'canceled' };
      }
      return switchWorkspaceRoot(result.filePaths[0]);
    }
    if (mode === 'current') {
      return switchWorkspaceRoot(null, { useCurrentSettings: true });
    }
    return { ok: false, reason: 'bad-mode' };
  });
}

module.exports = { registerWorkspaceIpc };
