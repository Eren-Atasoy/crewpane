'use strict';

/**
 * Engine Profiles & Multi-Account IPC Handlers (Faz 3.5 — Sıra 7)
 * Channels:
 *   - engineProfiles:list
 *   - engineProfiles:add
 *   - engineProfiles:switch
 *   - engineProfiles:respawnPanes
 *   - engineProfiles:setLabel
 *   - engineProfiles:remove
 *   - agentEngines:sync
 *   - engineProfiles:setAutoSwitch
 */
function registerEngineProfilesIpc({
  ipcMain,
  engineProfiles,
  engineAuth,
  engineSwitch,
  limitDetect,
  resumePtyDaemon,
  livePaneRegistry,
  crewpaneHome = () => '',
  profilesHome = () => '',
  authEngineIds = () => [],
  readProfileStatus = async () => null,
  stampProfileIdentity = () => false,
  pushProfilesEvent = () => {},
  ptys,
  getAppWindow = () => null,
  spawnPty = () => null,
  killPane = () => {},
  respawnOptsFromEntry = (e) => e,
  agentEngineMirror,
  logLine = () => {},
}) {
  const engineAccountsSnapshot = async () => {
    const home = profilesHome();
    const engines = await Promise.all(
      authEngineIds().map(async (engine) => {
        const meta = engineAuth.authDescriptor(engine, { env: process.env }) || {};
        const list = engineProfiles.listProfiles(home, engine);
        const active = engineProfiles.activeProfileId(home, engine);
        const statuses = await Promise.all(list.map((p) => readProfileStatus(engine, p.id)));
        const bf = engineProfiles.backfillIndex(list, statuses);
        if (bf >= 0 && stampProfileIdentity(engine, list[bf].id, statuses[bf], 'backfill')) {
          list[bf] = { ...list[bf], identity: engineProfiles.identityFromStatus(statuses[bf], { source: 'backfill' }) };
        }
        const profiles = list.map((p, i) => engineProfiles.profileRow(p, statuses[i], active));
        const first = statuses[0];
        const markedProfiles = engineProfiles.markDuplicateAccounts(profiles);
        return {
          engine,
          label: meta.label || engine,
          needsCode: meta.needsCode === true,
          signupUrl: meta.signupUrl || null,
          installed: first ? first.installed : null,
          installCommand: (first && first.installCommand) || null,
          installUrl: (first && first.installUrl) || null,
          flow: meta.flow || null,
          supportsSubscription: !!(first ? first.supportsSubscription : meta.loginArgv),
          supportsApiKey: !!(first ? first.supportsApiKey : meta.apiKey),
          multiAccount: !!meta.identityEnv && engineProfiles.isEngine(engine),
          active,
          profiles: markedProfiles,
        };
      }),
    );
    return { ok: true, autoSwitchOnLimit: engineProfiles.autoSwitchOnLimit(home), engines };
  };

  // ACCT-FIX-01 — AÇILIŞTA BİR KEZ GERİYE DOLDURMA, yalnız ÇOK-HESAPLI kurulumda.
  try {
    const multi = engineProfiles.ENGINES.some((eng) => engineProfiles.listProfiles(profilesHome(), eng).length > 1);
    if (multi && process.env.CREWPANE_E2E !== '1') {
      const t = setTimeout(() => {
        engineAccountsSnapshot().catch(() => {
          /* prob hatası açılışı ilgilendirmez */
        });
      }, 15_000);
      if (t && typeof t.unref === 'function') t.unref();
    }
  } catch {
    /* defter okunamadı → doldurma yok */
  }

  const stalePanesFor = (engine, targetProfileId) => {
    const now = Date.now();
    let limits = {};
    try {
      limits = engineSwitch.readLedger(profilesHome(), now).engines[engine] || {};
    } catch {
      limits = {};
    }
    return engineSwitch.stalePanesFor(ptys, {
      engine,
      targetProfileId,
      limits,
      now,
      screenLimited: (e) => !!limitDetect.detectLimitState(resumePtyDaemon.ptyTail(e.buffer)),
    });
  };

  ipcMain.handle('engineProfiles:list', async () => {
    try {
      return await engineAccountsSnapshot();
    } catch (err) {
      logLine(`engineProfiles:list failed: ${engineAuth.maskSecrets(String(err && err.message))}`);
      return { ok: false, autoSwitchOnLimit: false, engines: [] };
    }
  });

  ipcMain.handle('engineProfiles:add', async (event, req) => {
    const engine = req && typeof req.engine === 'string' ? req.engine : '';
    if (!authEngineIds().includes(engine)) return { ok: false, error: 'unsupported-engine' };
    try {
      const existing = engineProfiles.listProfiles(profilesHome(), engine);
      if (existing.length > 1) {
        const statuses = await Promise.all(existing.map((p) => readProfileStatus(engine, p.id)));
        const reuse = engineProfiles.firstEmptyProfileId(
          existing.map((p, i) => ({ id: p.id, loggedIn: statuses[i] ? statuses[i].loggedIn : null })),
        );
        if (reuse) {
          logLine(`engine account reused empty box engine=${engine} profile=${reuse}`);
          pushProfilesEvent();
          return { ok: true, profileId: reuse, reused: true };
        }
      }
    } catch {
      /* ölçemedik → yeni kutu aç */
    }
    const r = engineProfiles.addProfile(profilesHome(), engine, { label: req && req.label });
    if (r.ok) {
      logLine(`engine account added engine=${engine} profile=${r.profileId}`);
      pushProfilesEvent();
      return { ok: true, profileId: r.profileId };
    }
    return { ok: false, error: r.error };
  });

  ipcMain.handle('engineProfiles:switch', (event, req) => {
    const engine = req && typeof req.engine === 'string' ? req.engine : '';
    if (!authEngineIds().includes(engine)) return { ok: false, error: 'unsupported-engine' };
    const r = engineProfiles.setActiveProfile(profilesHome(), engine, req && req.profileId);
    if (r.ok) {
      logLine(`engine account switched engine=${engine} profile=${r.active}`);
      pushProfilesEvent();
      let stalePanes = [];
      try {
        stalePanes = stalePanesFor(engine, r.active);
      } catch {
        stalePanes = [];
      }
      if (stalePanes.length) {
        logLine(
          `engine account switch: ${stalePanes.length} pane still on another profile engine=${engine} target=${r.active} panes=${stalePanes.map((p) => `${p.paneId}:${p.profileId || 'default'}${p.limited ? '!' : ''}`).join(',')}`,
        );
      }
      return { ...r, stalePanes };
    }
    return r;
  });

  ipcMain.handle('engineProfiles:respawnPanes', (event, req) => {
    const engine = req && typeof req.engine === 'string' ? req.engine : '';
    if (!authEngineIds().includes(engine)) return { ok: false, error: 'unsupported-engine', results: [] };
    const profileId = req && req.profileId;
    const known = engineProfiles.listProfiles(profilesHome(), engine).some((p) => p.id === profileId);
    if (!known) return { ok: false, error: 'unknown-profile', results: [] };
    const paneIds = Array.isArray(req && req.paneIds) ? req.paneIds.filter((x) => typeof x === 'string' && x) : [];
    if (!paneIds.length) return { ok: true, results: [] };
    const results = [];
    const appWin = getAppWindow();
    for (const paneId of paneIds) {
      const entry = ptys.get(paneId);
      if (!entry || entry.command !== engine || !entry.agentId) {
        results.push({ paneId, ok: false, error: 'pane-gone' });
        continue;
      }
      let row = null;
      try {
        row = livePaneRegistry.loadRegistry(crewpaneHome()).panes[paneId] || null;
      } catch {
        row = null;
      }
      const shape = row || {
        engine: entry.command,
        cwd: entry.cwd || null,
        agentId: entry.agentId,
        department: entry.department || null,
        label: entry.label || null,
        role: entry.role || null,
        disallowSubagent: entry.disallowSubagent === true,
        sessionId: entry.sessionId || null,
        model: entry.launchModel || null,
        provider: entry.launchProvider || null,
      };
      const win = entry.win && !entry.win.isDestroyed() ? entry.win : appWin;
      try {
        const base = respawnOptsFromEntry(shape, { where: 'hesap-geçişi' });
        base.engineProfileId = profileId;
        base.spawnIntent = 'replace';
        killPane(paneId, entry, entry.agentId, 'engine account switch (ACCT-FIX-01 manual)');
        const res = spawnPty(win, base);
        const ok = !!(res && res.paneId);
        results.push({
          paneId,
          ok,
          newPaneId: ok ? res.paneId : null,
          resumed: ok && !!base.sessionId && base.resume === true,
          error: ok ? null : 'spawn-failed',
        });
        logLine(
          `engine account respawn: pane=${paneId} → ${ok ? res.paneId : 'FAILED'} engine=${engine} profile=${profileId} agent=${entry.agentId} resume=${base.sessionId ? 'yes' : 'no'}`,
        );
      } catch (e) {
        results.push({ paneId, ok: false, error: engineAuth.maskSecrets(String((e && e.message) || e)) });
        logLine(`engine account respawn failed pane=${paneId}: ${engineAuth.maskSecrets(String((e && e.message) || e))}`);
      }
    }
    return { ok: results.every((x) => x.ok), results };
  });

  ipcMain.handle('engineProfiles:setLabel', (event, req) => {
    const engine = req && typeof req.engine === 'string' ? req.engine : '';
    if (!authEngineIds().includes(engine)) return { ok: false, error: 'unsupported-engine' };
    const r = engineProfiles.setProfileLabel(profilesHome(), engine, req && req.profileId, req && req.label);
    if (r.ok) pushProfilesEvent();
    return r;
  });

  ipcMain.handle('engineProfiles:remove', async (event, req) => {
    const engine = req && typeof req.engine === 'string' ? req.engine : '';
    if (!authEngineIds().includes(engine)) return { ok: false, error: 'unsupported-engine' };
    const profileId = req && req.profileId;
    if (profileId === engineProfiles.DEFAULT_PROFILE_ID) return { ok: false, error: 'default-immutable' };
    try {
      await engineAuth.logout(engine, { env: engineProfiles.applyProfileEnv(process.env, profilesHome(), engine, profileId) });
    } catch {
      /* çıkış yapılamasa da kaydı düşürüyoruz */
    }
    const r = engineProfiles.removeProfile(profilesHome(), engine, profileId);
    if (r.ok) {
      logLine(`engine account removed engine=${engine} profile=${profileId}`);
      pushProfilesEvent();
    }
    return r;
  });

  ipcMain.handle('agentEngines:sync', (_event, map) => {
    const res = agentEngineMirror.writeMirror(crewpaneHome(), map);
    if (!res.ok) logLine(`agentEngines:sync yazılamadı: ${res.error}`);
    return res;
  });

  ipcMain.handle('engineProfiles:setAutoSwitch', (event, req) => {
    const r = engineProfiles.setAutoSwitchOnLimit(profilesHome(), req && req.enabled === true);
    if (r.ok) pushProfilesEvent();
    return r;
  });
}

module.exports = { registerEngineProfilesIpc };
