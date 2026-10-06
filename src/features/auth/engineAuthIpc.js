'use strict';

/**
 * Engine Auth IPC Handlers (Faz 3.5 — Sıra 7)
 * Channels:
 *   - engineAuth:status
 *   - engineAuth:login
 *   - engineAuth:submitCode
 *   - engineAuth:cancel
 *   - engineAuth:setApiKey
 *   - engineAuth:clearApiKey
 *   - engineAuth:logout
 */
function registerEngineAuthIpc({
  ipcMain,
  shell,
  engineAuth,
  engineProfiles,
  authEngineIds = () => [],
  activeProfileOf = () => null,
  authDeps = () => ({}),
  pushAuthEvent = () => {},
  pushProfilesEvent = () => {},
  stampProfileIdentity = () => false,
  profilesHome = () => '',
  getActiveLogin = () => null,
  setActiveLogin = () => {},
  logLine = () => {},
}) {
  ipcMain.handle('engineAuth:status', async () => {
    try {
      const engines = await Promise.all(
        authEngineIds().map((id) => engineAuth.readStatus(id, authDeps(id, activeProfileOf(id)))),
      );
      return { engines };
    } catch (err) {
      logLine(`engineAuth:status failed: ${engineAuth.maskSecrets(String(err && err.message))}`);
      return { engines: authEngineIds().map((id) => ({ engine: id, installed: false, loggedIn: false, error: 'probe-failed' })) };
    }
  });

  ipcMain.handle('engineAuth:login', async (event, req) => {
    const engine = req && typeof req.engine === 'string' ? req.engine : '';
    if (!authEngineIds().includes(engine)) {
      pushAuthEvent({ engine, state: 'error', error: 'unsupported-engine' });
      return { ok: false, error: 'unsupported-engine' };
    }
    const currentLogin = getActiveLogin();
    if (currentLogin) {
      try {
        currentLogin.cancel();
      } catch {
        /* yok say */
      }
      setActiveLogin(null);
    }
    const profileId = engineProfiles.isProfileId(req && req.profileId) ? req.profileId : activeProfileOf(engine);
    try {
      const session = engineAuth.startLogin(engine, {
        ...authDeps(engine, profileId),
        onUpdate: (snap) => {
          pushAuthEvent(snap);
          if (snap.state === 'awaiting-browser' && snap.url && /^https?:\/\//.test(snap.url)) {
            shell.openExternal(snap.url).catch(() => {
              /* açılmazsa UI'daki "Bağlantıyı aç" düğmesi kalır */
            });
          }
          if (snap.state === 'done' || snap.state === 'error' || snap.state === 'cancelled') {
            setActiveLogin(null);
          }
          if (snap.state === 'done') stampProfileIdentity(engine, profileId, snap.status, 'login');
          if (snap.state === 'done' || snap.state === 'logged-out') pushProfilesEvent();
        },
      });
      setActiveLogin(session);
      return { ok: true, session: session.snapshot(), profileId };
    } catch (err) {
      const reason = engineAuth.maskSecrets(String((err && err.message) || err));
      logLine(`engineAuth:login failed: ${reason}`);
      pushAuthEvent({ engine, state: 'error', error: reason });
      return { ok: false, error: 'başlatılamadı' };
    }
  });

  ipcMain.handle('engineAuth:submitCode', (event, req) => {
    const currentLogin = getActiveLogin();
    if (!currentLogin) return { ok: false, error: 'aktif giriş yok' };
    return currentLogin.submitCode(req && req.code);
  });

  ipcMain.handle('engineAuth:cancel', () => {
    const currentLogin = getActiveLogin();
    if (!currentLogin) return { ok: true };
    const r = currentLogin.cancel();
    setActiveLogin(null);
    return r;
  });

  ipcMain.handle('engineAuth:setApiKey', async (event, req) => {
    const engine = req && typeof req.engine === 'string' ? req.engine : '';
    if (!authEngineIds().includes(engine)) return { ok: false, error: 'unsupported-engine', status: null };
    const profileId = engineProfiles.isProfileId(req && req.profileId) ? req.profileId : activeProfileOf(engine);
    try {
      const r = await engineAuth.setApiKey(engine, req && req.key, authDeps(engine, profileId));
      pushAuthEvent({ engine, state: r.ok ? 'done' : 'error', status: r.status, error: r.ok ? null : r.error });
      pushProfilesEvent();
      return { ok: r.ok, error: r.error || null, engineMessage: r.engineMessage || null, status: r.status };
    } catch (err) {
      logLine(`engineAuth:setApiKey failed: ${engineAuth.maskSecrets(String(err && err.message))}`);
      return { ok: false, error: 'anahtar kaydedilemedi', status: null };
    }
  });

  ipcMain.handle('engineAuth:clearApiKey', async (event, req) => {
    const engine = req && typeof req.engine === 'string' ? req.engine : '';
    if (!authEngineIds().includes(engine)) return { ok: false, error: 'unsupported-engine', status: null };
    const profileId = engineProfiles.isProfileId(req && req.profileId) ? req.profileId : activeProfileOf(engine);
    try {
      const r = await engineAuth.clearApiKey(engine, authDeps(engine, profileId));
      pushAuthEvent({ engine, state: 'logged-out', status: r.status });
      pushProfilesEvent();
      return r;
    } catch (err) {
      logLine(`engineAuth:clearApiKey failed: ${engineAuth.maskSecrets(String(err && err.message))}`);
      return { ok: false, error: 'anahtar silinemedi', status: null };
    }
  });

  ipcMain.handle('engineAuth:logout', async (event, req) => {
    const engine = req && typeof req.engine === 'string' ? req.engine : '';
    if (!authEngineIds().includes(engine)) return { ok: false, error: 'unsupported-engine' };
    const profileId = engineProfiles.isProfileId(req && req.profileId) ? req.profileId : activeProfileOf(engine);
    try {
      const r = await engineAuth.logout(engine, authDeps(engine, profileId));
      if (r.ok) {
        try {
          engineProfiles.clearProfileIdentity(profilesHome(), engine, profileId);
        } catch {
          /* defter best-effort */
        }
      }
      pushAuthEvent({ engine, state: r.ok ? 'logged-out' : 'error', status: r.status });
      pushProfilesEvent();
      return r;
    } catch (err) {
      logLine(`engineAuth:logout failed: ${engineAuth.maskSecrets(String(err && err.message))}`);
      return { ok: false, error: 'çıkış yapılamadı', status: null };
    }
  });
}

module.exports = { registerEngineAuthIpc };
