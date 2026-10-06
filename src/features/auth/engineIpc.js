'use strict';

/**
 * AI Engine Capability, Offering, and Leadership IPC Handlers (Faz 3.5 — Sıra 7)
 * Channels:
 *   - engine:check
 *   - engine:capabilityMatrix
 *   - engine:availability
 *   - engine:leadership
 */
function registerEngineIpc({
  ipcMain,
  engineCheck,
  capabilityRegistry = () => ({}),
  paneCapabilityMatrix,
  engineOffering,
  engineDelegation,
  engineLeadership,
  enginePlanned,
  authEngineIds = () => [],
  readProfileStatus = async () => null,
  activeProfileOf = () => null,
  authDeps = () => ({}),
  engineAuth,
  logLine = () => {},
}) {
  ipcMain.handle('engine:check', async () => {
    try {
      return await engineCheck.checkEngines();
    } catch {
      return {
        engines: engineCheck.DEFAULT_ENGINES.map((id) => ({
          id,
          name: id,
          found: false,
          path: null,
          installUrl: engineCheck.INSTALL_HINTS[id] || null,
        })),
        anyFound: false,
      };
    }
  });

  ipcMain.handle('engine:capabilityMatrix', () => {
    try {
      const reg = capabilityRegistry();
      const engines = {};
      for (const id of reg.engineIds()) {
        engines[id] = {
          engine: id,
          label: (reg.getEngine(id) || {}).label || id,
          matrix: paneCapabilityMatrix.buildMatrix(id, { registry: reg }),
        };
      }
      return { ok: true, engines };
    } catch (err) {
      logLine(`engine:capabilityMatrix error: ${err && err.message}`);
      return { ok: false, engines: {} };
    }
  });

  ipcMain.handle('engine:availability', () => {
    try {
      const reg = capabilityRegistry();
      const offered = engineOffering.seedEnabledMap();
      const engines = {};
      for (const id of reg.engineIds()) {
        const verdict = engineDelegation.delegationVerdict(id);
        engines[id] = {
          engine: id,
          label: (reg.getEngine(id) || {}).label || id,
          offered: offered[id] === true,
          delegation: {
            class: verdict.class,
            capable: verdict.capable,
            badge: verdict.badge,
            blockers: verdict.blockers.map((b) => ({ id: b.id, why: b.why })),
            warnings: verdict.warnings.map((w) => ({ id: w.id, why: w.why })),
          },
        };
      }
      const closed = Object.keys(engines).filter((id) => !engines[id].offered);
      const noWork = Object.keys(engines).filter((id) => !engines[id].delegation.capable);
      const lever = engineOffering.offeringOffSet(process.env);
      logLine(
        `engine:availability → kapalı=${closed.join(',') || '-'} iş-verilemez=${noWork.join(',') || '-'}` +
          (lever ? ` (kontrol kolu AÇIK: CREWPANE_ENGINE_OFFERING_OFF=${[...lever].join(',')})` : ''),
      );
      return { ok: true, engines, source: 'catalog' };
    } catch (err) {
      logLine(`engine:availability error: ${err && err.message}`);
      return { ok: false, engines: {}, source: 'error' };
    }
  });

  ipcMain.handle('engine:leadership', async () => {
    try {
      const reg = capabilityRegistry();
      const ids = reg.engineIds();
      const authIds = new Set(authEngineIds());
      const statuses = await Promise.all(
        ids.map((id) =>
          authIds.has(id)
            ? engineAuth.readStatus(id, authDeps(id, activeProfileOf(id))).catch(() => null)
            : Promise.resolve(null),
        ),
      );
      const candidates = ids.map((engine, i) => ({ engine, status: statuses[i] }));
      const seam = { registry: reg };
      const recommendation = engineLeadership.recommendLeaderEngine(candidates, seam);
      const engines = {};
      for (const entry of recommendation.ranked) {
        engines[entry.engine] = {
          engine: entry.engine,
          label: (reg.getEngine(entry.engine) || {}).label || entry.engine,
          class: entry.class,
          auth: entry.auth,
          eligible: entry.eligible,
          blockers: [...entry.blockers],
          gaps: [...entry.gaps],
          planned: enginePlanned.plannedCardFor(entry.engine, 'leader'),
          requirements: entry.requirements.map((r) => ({
            id: r.id,
            capability: r.capability,
            severity: r.severity,
            state: r.state,
            reason: r.reason,
          })),
        };
      }
      const order = recommendation.ranked.map((e) => e.engine);
      logLine(
        `engine:leadership → öneri=${recommendation.engine || 'YOK'} sınıf=${recommendation.class || '-'} ` +
          `sıra=${order.join('>')}${recommendation.warning ? ` uyarı=${recommendation.warning.kind}` : ''}`,
      );
      return {
        ok: true,
        engines,
        order,
        recommended: recommendation.engine,
        recommendedClass: recommendation.class,
        warning: recommendation.warning,
      };
    } catch (err) {
      logLine(`engine:leadership error: ${err && err.message}`);
      return { ok: false, engines: {}, order: [], recommended: null, recommendedClass: null, warning: null };
    }
  });
}

module.exports = { registerEngineIpc };
