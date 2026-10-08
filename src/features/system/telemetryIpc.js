'use strict';

const PROVISION_SERVICES = new Set(['sentry', 'posthog']);

function provisionInput(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const service = typeof input.service === 'string' ? input.service.trim() : '';
  if (!PROVISION_SERVICES.has(service)) return null;
  const clean = (v) => (typeof v === 'string' ? v.trim().slice(0, 200).replace(/[^A-Za-z0-9._-]/g, '') : null);
  return { service, orgSlug: clean(input.orgSlug) || null, teamSlug: clean(input.teamSlug) || null };
}

/**
 * Telemetry Provisioning & Analytics IPC Handlers (Faz 3.5 — Sıra 11)
 * Channels:
 *   - analytics:track
 *   - telemetry:provision
 *   - telemetry:verify
 *   - telemetry:provisionStatus
 */
function registerTelemetryIpc({
  ipcMain,
  analyticsNow,
  analyticsSchema,
  analyticsFirstTime,
  supervisorFor,
  vendorOnlyGate,
  logLine = () => {},
  telemetryTokenFor,
  credentialGate,
  telemetryProvisioning,
  stampIntegrationVerified,
  vendorSurface,
  telemetryMod,
  provisionStoreMod,
  telemetryChannelMod,
}) {
  const VENDOR_ONLY = {
    ok: false,
    code: 'vendor-only',
    message: 'Bu kurulum akışı CrewPane’in kendi telemetrisi içindir ve bu yapıda kapalıdır.',
  };
  const checkVendorOnly = vendorOnlyGate || (() => (vendorSurface && vendorSurface.isCustomerSurface() ? VENDOR_ONLY : null));
  ipcMain.handle('analytics:track', (_event, payload) => {
    try {
      const p = payload && typeof payload === 'object' ? payload : {};
      const name = typeof p.event === 'string' ? p.event : '';

      if (name === 'canvas_recovery_step') {
        const res = analyticsNow().track('canvas_recovery_step', {
          stage: analyticsSchema.coerce(
            analyticsSchema.EVENTS.canvas_recovery_step.stage, String(p.stage || ''),
          ) || 'other',
          outcome: analyticsSchema.coerce(
            analyticsSchema.EVENTS.canvas_recovery_step.outcome, String(p.outcome || ''),
          ) || 'other',
        });
        return { ok: !!res.sent, reason: res.reason };
      }

      if (name === 'entitlement_write_blocked') {
        const surface = analyticsSchema.coerce(
          analyticsSchema.EVENTS.entitlement_write_blocked.surface, String(p.surface || ''),
        ) || 'other';
        const res = analyticsNow().track('entitlement_write_blocked', { surface });
        return { ok: !!res.sent, reason: res.reason };
      }

      if (name === 'onb.quest.done') {
        const quest = analyticsSchema.coerce(
          analyticsSchema.EVENTS['onb.quest.done'].quest, String(p.quest || ''),
        );
        if (!quest) return { ok: false, reason: 'bad-quest' };
        const res = analyticsNow().track('onb.quest.done', {
          quest,
          seconds: analyticsSchema.coerce(analyticsSchema.EVENTS['onb.quest.done'].seconds, p.seconds) ?? 0,
          required: p.required === true,
        });
        return { ok: !!res.sent, reason: res.reason };
      }

      if (name === 'onb.quest.panel') {
        const action = analyticsSchema.coerce(
          analyticsSchema.EVENTS['onb.quest.panel'].action, String(p.action || ''),
        );
        if (!action) return { ok: false, reason: 'bad-action' };
        const res = analyticsNow().track('onb.quest.panel', { action });
        return { ok: !!res.sent, reason: res.reason };
      }

      if (name === 'onb.quest.show') {
        const quest = analyticsSchema.coerce(
          analyticsSchema.EVENTS['onb.quest.show'].quest, String(p.quest || ''),
        );
        if (!quest) return { ok: false, reason: 'bad-quest' };
        const outcome = analyticsSchema.coerce(
          analyticsSchema.EVENTS['onb.quest.show'].outcome, String(p.outcome || ''),
        );
        if (!outcome) return { ok: false, reason: 'bad-outcome' };
        const res = analyticsNow().track('onb.quest.show', { quest, outcome });
        return { ok: !!res.sent, reason: res.reason };
      }

      if (name === 'onb.quest.backfill') {
        const spec = analyticsSchema.EVENTS['onb.quest.backfill'];
        const emitted = analyticsSchema.coerce(spec.emitted, p.emitted);
        if (emitted === null || emitted === undefined) return { ok: false, reason: 'bad-emitted' };
        const engine = analyticsSchema.coerce(spec.engine, String(p.engine || ''));
        const office = analyticsSchema.coerce(spec.office, String(p.office || ''));
        const board = analyticsSchema.coerce(spec.board, String(p.board || ''));
        if (!engine || !office || !board) return { ok: false, reason: 'bad-fact' };
        const res = analyticsNow().track('onb.quest.backfill', { emitted, engine, office, board });
        return { ok: !!res.sent, reason: res.reason };
      }

      if (name === 'onb.tour.hintAction') {
        const spec = analyticsSchema.EVENTS['onb.tour.hintAction'];
        const kind = analyticsSchema.coerce(spec.kind, String(p.kind || ''));
        if (!kind) return { ok: false, reason: 'bad-kind' };
        const outcome = analyticsSchema.coerce(spec.outcome, String(p.outcome || ''));
        if (!outcome) return { ok: false, reason: 'bad-outcome' };
        const res = analyticsNow().track('onb.tour.hintAction', { kind, outcome });
        return { ok: !!res.sent, reason: res.reason };
      }

      if (name === 'onb.guide.dismissed') {
        const step = analyticsSchema.coerce(
          analyticsSchema.EVENTS['onb.guide.dismissed'].step, String(p.step || ''),
        );
        if (!step) return { ok: false, reason: 'bad-step' };
        const via = analyticsSchema.coerce(
          analyticsSchema.EVENTS['onb.guide.dismissed'].via, String(p.via || ''),
        );
        if (!via) return { ok: false, reason: 'bad-via' };
        const res = analyticsNow().track('onb.guide.dismissed', {
          step,
          via,
          seconds: analyticsSchema.coerce(
            analyticsSchema.EVENTS['onb.guide.dismissed'].seconds, p.seconds,
          ) ?? 0,
        });
        return { ok: !!res.sent, reason: res.reason };
      }

      if (name === 'onb.tour.step') {
        const step = analyticsSchema.coerce(
          analyticsSchema.EVENTS['onb.tour.step'].step, String(p.step || ''),
        );
        if (!step) return { ok: false, reason: 'bad-step' };
        const phase = analyticsSchema.coerce(
          analyticsSchema.EVENTS['onb.tour.step'].phase, String(p.phase || ''),
        );
        if (!phase) return { ok: false, reason: 'bad-phase' };
        const mode = analyticsSchema.coerce(
          analyticsSchema.EVENTS['onb.tour.step'].mode, String(p.mode || ''),
        );
        if (!mode) return { ok: false, reason: 'bad-mode' };
        const res = analyticsNow().track('onb.tour.step', {
          step,
          phase,
          mode,
          seconds: analyticsSchema.coerce(
            analyticsSchema.EVENTS['onb.tour.step'].seconds, p.seconds,
          ) ?? 0,
        });
        return { ok: !!res.sent, reason: res.reason };
      }

      if (name === 'onb.tip.shown') {
        const tip = analyticsSchema.coerce(
          analyticsSchema.EVENTS['onb.tip.shown'].tip, String(p.tip || ''),
        );
        if (!tip) return { ok: false, reason: 'bad-tip' };
        const res = analyticsNow().track('onb.tip.shown', { tip });
        return { ok: !!res.sent, reason: res.reason };
      }

      if (name === 'onb.tip.dismissed') {
        const tip = analyticsSchema.coerce(
          analyticsSchema.EVENTS['onb.tip.dismissed'].tip, String(p.tip || ''),
        );
        if (!tip) return { ok: false, reason: 'bad-tip' };
        const action = analyticsSchema.coerce(
          analyticsSchema.EVENTS['onb.tip.dismissed'].action, String(p.action || ''),
        );
        if (!action) return { ok: false, reason: 'bad-action' };
        const res = analyticsNow().track('onb.tip.dismissed', { tip, action });
        return { ok: !!res.sent, reason: res.reason };
      }

      if (name === 'onb.topic.started') {
        const topic = analyticsSchema.coerce(
          analyticsSchema.EVENTS['onb.topic.started'].topic, String(p.topic || ''),
        );
        if (!topic) return { ok: false, reason: 'bad-topic' };
        const from = analyticsSchema.coerce(
          analyticsSchema.EVENTS['onb.topic.started'].from, String(p.from || ''),
        );
        if (!from) return { ok: false, reason: 'bad-from' };
        const res = analyticsNow().track('onb.topic.started', { topic, from });
        return { ok: !!res.sent, reason: res.reason };
      }

      if (name === 'onb.topic.done') {
        const topic = analyticsSchema.coerce(
          analyticsSchema.EVENTS['onb.topic.done'].topic, String(p.topic || ''),
        );
        if (!topic) return { ok: false, reason: 'bad-topic' };
        const reason = analyticsSchema.coerce(
          analyticsSchema.EVENTS['onb.topic.done'].reason, String(p.reason || ''),
        );
        if (!reason) return { ok: false, reason: 'bad-reason' };
        const res = analyticsNow().track('onb.topic.done', {
          topic,
          reason,
          steps: analyticsSchema.coerce(
            analyticsSchema.EVENTS['onb.topic.done'].steps, p.steps,
          ) ?? 0,
          clean: p.clean === true,
        });
        return { ok: !!res.sent, reason: res.reason };
      }

      if (name !== 'panel_view') return { ok: false, reason: 'not-allowed' };
      const panel = analyticsSchema.panelOf(p.panel);
      const res = analyticsNow().track('panel_view', {
        panel,
        first_time: analyticsFirstTime(`panel:${panel}`),
      });
      return { ok: !!res.sent, reason: res.reason };
    } catch {
      return { ok: false, reason: 'internal' };
    }
  });

  ipcMain.handle('telemetry:provision', (_event, raw) =>
    supervisorFor('telemetry-provision').runAsync(
      'provision',
      async () => {
        const denied = checkVendorOnly();
        if (denied) { logLine('telemetry-provision: müşteri build’inde REDDEDİLDİ (vendor-only)'); return denied; }
        const input = provisionInput(raw);
        if (!input) return { ok: false, code: 'unknown-service', message: 'Bilinmeyen servis.' };
        const token = telemetryTokenFor(input.service);
        if (!token) {
          return {
            ok: false,
            code: 'not-connected',
            message: credentialGate.missingMessageFor(input.service),
          };
        }
        const res = await telemetryProvisioning().provisioner.connect({ ...input, token });
        logLine(`telemetry-provision: ${input.service} sonuç=${res.ok ? 'OK' : res.code}`);
        return res;
      },
      { ok: false, code: 'error', message: 'Kurulum çalıştırılamadı.' },
    ));

  ipcMain.handle('telemetry:verify', (_event, raw) =>
    supervisorFor('telemetry-provision').runAsync(
      'verify',
      async () => {
        const denied = checkVendorOnly();
        if (denied) { logLine('telemetry-verify: müşteri build’inde REDDEDİLDİ (vendor-only)'); return denied; }
        const input = provisionInput(raw);
        if (!input) return { ok: false, code: 'unknown-service', message: 'Bilinmeyen servis.' };
        const token = telemetryTokenFor(input.service);
        if (!token) return { ok: false, code: 'not-connected', message: credentialGate.missingMessageFor(input.service) };
        const out = await telemetryProvisioning().provisioner.verify(input.service, token);
        if (out && out.ok) await stampIntegrationVerified(input.service);
        return out;
      },
      { ok: false, code: 'error', message: 'Doğrulama çalıştırılamadı.' },
    ));

  ipcMain.handle('telemetry:provisionStatus', () =>
    supervisorFor('telemetry-provision').runAsync(
      'status',
      async () => {
        if (vendorSurface && vendorSurface.isCustomerSurface()) return { ok: true, channel: null, services: [], vendorOnly: true };
        const services = await telemetryProvisioning().provisioner.status();
        const legacyEnv = telemetryMod.loadDsnEnvFromCrewPane({ env: { ...process.env } });
        const presence = provisionStoreMod.envPresence(legacyEnv);
        return {
          ok: true,
          channel: telemetryChannelMod.resolveChannel(),
          services: services.map((s) => ({ ...s, envKeys: presence[s.service] || null })),
        };
      },
      { ok: false, channel: null, services: [] },
    ));
}

module.exports = { registerTelemetryIpc };
