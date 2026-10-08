'use strict';

const { app: defaultApp, shell: defaultShell } = require('electron');

/**
 * Account, Session & Protocol Scheme IPC Handlers (Faz 3.5 — Sıra 11)
 * Channels:
 *   - crewpane:get
 *   - crewpane:signIn
 *   - crewpane:signOut
 *   - crewpane:schemeHealth
 *   - crewpane:secretBackend
 *   - crewpane:pasteCallback
 *   - crewpane:refresh
 *   - crewpane:openBilling
 *   - crewpane:devices
 *   - crewpane:deviceRevoke
 *   - crewpane:deviceReleaseOthers
 *   - account:get
 *   - account:setCompany
 */
function registerAccountIpc({
  ipcMain,
  app = defaultApp,
  shell = defaultShell,
  getSeatGate,
  getAccountState,
  getAppUrlScheme,
  getAppUrlPrefix,
  gateOverrides,
  logLine = () => {},
  runningPaneSummary = () => [],
  signOutConfirmCopy = () => ({}),
  closePanesForSignOut = () => [],
  accountScope,
  getBoundAccount,
  relaunchForAccountChange = () => {},
  instancePaths,
  schemeOwnership,
  getSchemeVerdict = () => null,
  setSchemeVerdict = () => {},
  isAutomatedSession = false,
  automatedSessionReason = '',
  secretBackendState,
  handleAuthUrl,
  crewpaneIdConfig,
}) {
  ipcMain.handle('crewpane:get', () => {
    const scheme = typeof getAppUrlScheme === 'function' ? getAppUrlScheme() : getAppUrlScheme;
    const accountState = typeof getAccountState === 'function' ? getAccountState() : {};
    const bootSplash = gateOverrides ? gateOverrides(process.env).bootSplash : undefined;
    return {
      ok: true,
      scheme,
      bootSplash,
      ...accountState,
    };
  });

  ipcMain.handle('crewpane:signIn', async () => {
    const seatGate = getSeatGate();
    if (!seatGate) return { ok: false, reason: 'not_ready' };
    try {
      const res = await seatGate.signIn();
      return { ok: true, url: res.url };
    } catch (e) {
      logLine(`crewpane:signIn error: ${e.message}`);
      return { ok: false, reason: 'sign_in_failed', detail: e.message };
    }
  });

  ipcMain.handle('crewpane:signOut', async (_e, opts) => {
    const seatGate = getSeatGate();
    if (!seatGate) return { ok: false, reason: 'not_ready' };
    const force = !!(opts && opts.force);
    const probe = !!(opts && opts.probe);
    const panes = runningPaneSummary();
    const accountState = typeof getAccountState === 'function' ? getAccountState() : {};
    if (probe) {
      return { ok: false, reason: 'probe', panes, ...signOutConfirmCopy(panes), ...accountState };
    }
    if (panes.length && !force) {
      return {
        ok: false,
        reason: 'panes_running',
        panes,
        ...signOutConfirmCopy(panes),
        ...accountState,
      };
    }
    const closedPanes = closePanesForSignOut();
    await seatGate.signOut();
    const nextKey = accountScope.ANON_ACCOUNT_KEY;
    const boundAccount = getBoundAccount();
    if (boundAccount && boundAccount.key !== nextKey) {
      relaunchForAccountChange(nextKey, 'signOut');
      return { ok: true, restarting: true, closedPanes, ...accountState };
    }
    return { ok: true, closedPanes, ...accountState };
  });

  ipcMain.handle('account:get', () => {
    const boundAccount = getBoundAccount();
    return {
      ok: true,
      accountKey: boundAccount ? boundAccount.key : null,
      userId: boundAccount ? boundAccount.userId : null,
      email: boundAccount ? boundAccount.email : null,
      root: boundAccount ? boundAccount.root : null,
      deviceId: boundAccount ? boundAccount.deviceId : null,
      instanceRoot: instancePaths ? instancePaths.instanceHome() : null,
      runningPanes: runningPaneSummary().length,
    };
  });

  ipcMain.handle('account:setCompany', (_e, companyId) => {
    const boundAccount = getBoundAccount();
    if (!boundAccount) return { ok: false, reason: 'not_bound' };
    const id = typeof companyId === 'string' && companyId.trim() ? companyId.trim() : null;
    try {
      accountScope.upsertAccountMeta(boundAccount.root, { companyId: id });
      return { ok: true, companyId: id };
    } catch (e) {
      logLine(`[account] companyId yazılamadı: ${e.message}`);
      return { ok: false, reason: 'write_failed' };
    }
  });

  ipcMain.handle('crewpane:schemeHealth', async (_e, opts) => {
    try {
      const scheme = typeof getAppUrlScheme === 'function' ? getAppUrlScheme() : getAppUrlScheme;
      let verdict = getSchemeVerdict();
      if (opts && opts.repair && schemeOwnership) {
        verdict = await schemeOwnership.claimAndVerify({
          app,
          scheme,
          log: logLine,
          allowDevClaimEnv: 'CREWPANE_ALLOW_DEV_PROTOCOL_CLAIM',
          automated: isAutomatedSession,
          automatedReason: automatedSessionReason,
          platform: process.platform,
        });
        setSchemeVerdict(verdict);
      }
      return { ok: true, ...(verdict || { severity: null, conflicts: [] }) };
    } catch (e) {
      logLine(`crewpane:schemeHealth error: ${e.message}`);
      return { ok: false, reason: 'check_failed', severity: null, conflicts: [] };
    }
  });

  ipcMain.handle('crewpane:secretBackend', async () => {
    try {
      const s = secretBackendState.secretBackendState();
      return {
        ok: true,
        measured: s.measured,
        available: s.available,
        backend: s.backend,
        plaintext: s.plaintext,
        canStore: s.canStore,
        reasonKey: s.reasonKey,
      };
    } catch (e) {
      logLine(`crewpane:secretBackend error: ${e.message}`);
      return { ok: false, measured: false, canStore: null, reasonKey: null };
    }
  });

  ipcMain.handle('crewpane:pasteCallback', async (_e, url) => {
    const text = typeof url === 'string' ? url.trim().replace(/^["']|["']$/g, '') : '';
    const prefix = typeof getAppUrlPrefix === 'function' ? getAppUrlPrefix() : getAppUrlPrefix;
    if (!text.toLowerCase().startsWith(prefix.toLowerCase()) || !text.includes('code=')) {
      return { ok: false, reason: 'invalid_url', expectedPrefix: prefix };
    }
    logLine('crewpane:pasteCallback — elle yapıştırılan dönüş bağlantısı işleniyor');
    handleAuthUrl(text);
    return { ok: true };
  });

  ipcMain.handle('crewpane:refresh', async () => {
    const seatGate = getSeatGate();
    if (!seatGate) return { ok: false, reason: 'not_ready' };
    const res = await seatGate.refreshLicense();
    const accountState = typeof getAccountState === 'function' ? getAccountState() : {};
    return { ok: !!res.ok, reason: res.reason, ...accountState };
  });

  ipcMain.handle('crewpane:openBilling', async () => {
    const url = crewpaneIdConfig(process.env).billingUrl;
    try {
      await shell.openExternal(url);
      logLine(`crewpane:openBilling → ${url}`);
      return { ok: true, url };
    } catch (e) {
      logLine(`crewpane:openBilling error: ${e.message}`);
      return { ok: false, reason: 'open_failed', url };
    }
  });

  ipcMain.handle('crewpane:devices', async () => {
    const seatGate = getSeatGate();
    if (!seatGate) return { ok: false, reason: 'not_ready' };
    const res = await seatGate.listDevices().catch((e) => ({ ok: false, reason: 'error', detail: e.message }));
    if (!res.ok) logLine(`crewpane:devices başarısız (${res.reason})`);
    return res;
  });

  ipcMain.handle('crewpane:deviceRevoke', async (_e, deviceId) => {
    const seatGate = getSeatGate();
    if (!seatGate) return { ok: false, reason: 'not_ready' };
    const id = String(deviceId || '');
    if (!id) return { ok: false, reason: 'missing_device_id' };
    const res = await seatGate.revokeDevice(id)
      .catch((e) => ({ ok: false, reason: 'error', detail: e.message }));
    logLine(`crewpane:deviceRevoke ${id} → ${res.ok ? 'çıkarıldı' : res.reason}`);
    return res;
  });

  ipcMain.handle('crewpane:deviceReleaseOthers', async () => {
    const seatGate = getSeatGate();
    if (!seatGate) return { ok: false, reason: 'not_ready' };
    const res = await seatGate.releaseOtherDevices()
      .catch((e) => ({ ok: false, reason: 'error', detail: e.message }));
    const after = (() => { try { return seatGate.state(); } catch { return null; } })();
    const denied = !!(after && after.device && after.device.denied);
    logLine(`crewpane:deviceReleaseOthers → ${res.ok ? `${res.released} cihaz bırakıldı` : res.reason}`
      + ` (ret devam=${denied})`);
    return { ...res, denied };
  });
}

module.exports = { registerAccountIpc };
