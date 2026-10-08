'use strict';

const fs = require('node:fs');
const { app: defaultApp, shell: defaultShell } = require('electron');

/**
 * App Info, Relaunch, Doctor, Changelog & Spike IPC Handlers (Faz 3.5 — Sıra 11)
 * Channels:
 *   - app:info
 *   - app:rebuildRelaunch
 *   - demo:siteUrl
 *   - doctor:run
 *   - doctor:openHookSettings
 *   - app:relaunch
 *   - changelog:get
 *   - changelog:checkNow
 *   - changelog:openUrl
 *   - spike:rendered (on)
 *   - spike:done (on)
 */
function registerAppIpc({
  ipcMain,
  app = defaultApp,
  shell = defaultShell,
  mode = '',
  instancePaths,
  shellCommit = '',
  getResetBootNotice = () => null,
  rebuildAndRelaunch = () => {},
  demoSitePath,
  runDoctorNow = async () => ({}),
  firstRunDoctor,
  hookScanHome = () => '',
  getAgentWorkspaceRoot = () => null,
  logLine = () => {},
  relaunchApp = () => {},
  changelogStateForRenderer = () => ({}),
  runChangelogCheck = () => {},
  getChangelogState = () => ({ items: [] }),
  getLogPath = () => '',
  noteQuit = () => {},
}) {
  ipcMain.handle('app:info', () => ({
    mode,
    packaged: app.isPackaged,
    rebuildSupported: !app.isPackaged,
    authEnabled: /^(1|true|on|yes)$/i.test(String(process.env.CREWPANE_AUTH || '')),
    version: app.getVersion(),
    instance: instancePaths ? instancePaths.instanceId() : null,
    commit: shellCommit,
    resetBoot: typeof getResetBootNotice === 'function' ? getResetBootNotice() : getResetBootNotice,
  }));

  ipcMain.handle('app:rebuildRelaunch', (event) => rebuildAndRelaunch(event));

  ipcMain.handle('demo:siteUrl', (_event, payload) => {
    const lang = payload && payload.lang === 'en' ? 'en' : 'tr';
    const url = demoSitePath ? demoSitePath.demoSiteUrl({ lang }) : null;
    return url ? { ok: true, url } : { ok: false };
  });

  ipcMain.handle('doctor:run', async () => {
    try {
      return await runDoctorNow();
    } catch (err) {
      logLine(`doctor:run error: ${err && err.message}`);
      return { generatedAt: Date.now(), overall: 'warn', checks: [], error: 'run_failed' };
    }
  });

  ipcMain.handle('doctor:openHookSettings', async (_event, requested) => {
    const target = typeof requested === 'string' ? requested.trim() : '';
    if (!target) return { ok: false, reason: 'bad-request' };
    const agentWorkspaceRoot = typeof getAgentWorkspaceRoot === 'function' ? getAgentWorkspaceRoot() : getAgentWorkspaceRoot;
    const allowed = firstRunDoctor.hookSettingsFiles({
      userHome: hookScanHome(),
      workspaceRoot: agentWorkspaceRoot,
    });
    if (!allowed.some((f) => f.path === target)) {
      logLine('doctor:openHookSettings reddedildi (liste dışı yol)');
      return { ok: false, reason: 'not-allowed' };
    }
    try {
      if (!fs.existsSync(target)) return { ok: false, reason: 'missing' };
      const err = await shell.openPath(target);
      if (err) {
        shell.showItemInFolder(target);
        return { ok: true, via: 'folder' };
      }
      return { ok: true, via: 'editor' };
    } catch (e) {
      logLine(`doctor:openHookSettings hata: ${e.message}`);
      return { ok: false, reason: 'open-failed' };
    }
  });

  ipcMain.handle('app:relaunch', () => {
    if (process.env.CREWPANE_E2E_BLOCK_RELAUNCH === '1') {
      logLine('relaunch: suppressed (e2e seam)');
      return { ok: true, suppressed: true };
    }
    logLine('relaunch: requested (settings restart-apply)');
    setTimeout(() => relaunchApp('settings-restart'), 400);
    return { ok: true };
  });

  ipcMain.handle('changelog:get', () => changelogStateForRenderer());

  ipcMain.handle('changelog:checkNow', () => runChangelogCheck('manual'));

  ipcMain.handle('changelog:openUrl', (_event, url) => {
    const target = typeof url === 'string' ? url.trim() : '';
    const changelogState = getChangelogState();
    if (!target || !changelogState.items || !changelogState.items.some((e) => e.url === target)) {
      return { ok: false, reason: 'unknown-url' };
    }
    shell.openExternal(target);
    logLine(`changelog: link açıldı → ${target}`);
    return { ok: true, url: target };
  });

  ipcMain.on('spike:rendered', (_event, chunk) => {
    const logPath = typeof getLogPath === 'function' ? getLogPath() : getLogPath;
    try {
      if (logPath) fs.appendFileSync(logPath, '[rendered] ' + JSON.stringify(chunk) + '\n');
    } catch {
      /* best-effort */
    }
  });

  ipcMain.on('spike:done', (_event, summary) => {
    logLine('autotest summary: ' + JSON.stringify(summary));
    setTimeout(() => {
      noteQuit('watchdog', 'autotest-done');
      app.quit();
    }, 200);
  });
}

module.exports = { registerAppIpc };
