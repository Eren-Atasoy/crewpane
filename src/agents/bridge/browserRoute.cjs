'use strict';

const { validateBrowserPayload } = require('../../services/browserCdp.js');
const { getBrowserGate } = require('../../security/browserGate.cjs');
const { BROWSER_APPROVAL_TIMEOUT_MS } = require('./constants.cjs');

/**
 * ADP-095 & ADP-341 — headed browser automation (CDP) handler with risk gating.
 */
async function handleBrowserRoute(req, res, ctx) {
  const { onBrowserAction, onBrowserProbe, browserGate, callRenderer, log, readBody, send } = ctx;

  if (typeof onBrowserAction !== 'function') {
    send(res, 501, { ok: false, error: 'browser control not available' });
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse((await readBody(req)) || '{}');
  } catch {
    send(res, 400, { ok: false, error: 'invalid JSON' });
    return;
  }
  const v = validateBrowserPayload(parsed);
  if (!v.ok) {
    send(res, 400, { ok: false, error: v.error });
    return;
  }
  const value = v.value;
  const source = parsed && parsed.source === 'mobile' ? 'mobile' : 'agent';
  const gate = browserGate || getBrowserGate();
  const mutating = value.action === 'click' || value.action === 'type';

  // 1) Bağlam ölçümü (main) — okuma eylemlerinde gereksiz: okuma sayfayı değiştirmez.
  let probe = { url: null, elementInfo: null };
  if (mutating && typeof onBrowserProbe === 'function') {
    try {
      probe = (await onBrowserProbe(value)) || {};
    } catch (err) {
      probe = { url: null, elementInfo: null, probeError: String(err.message || err) };
      log(`browser prob hatası (${value.action}): ${probe.probeError}`);
    }
    if (probe.found === false) {
      gate.audit({
        agentId: value.agentId,
        delegationId: value.delegationId,
        origin: probe.url,
        action: value.action,
        selector: value.selector,
        text: value.text,
        decision: 'error',
        reason: 'hedef eleman sayfada yok',
        source,
        ok: false,
      });
      send(res, 200, { ok: false, error: `selector not found: ${value.selector}` });
      return;
    }
  }

  // 2) Karar — deterministik, main'de. Sayfanın metni güveni YÜKSELTEMEZ.
  const d = gate.decide(value, probe, source);
  const auditBase = {
    agentId: value.agentId,
    delegationId: value.delegationId,
    origin: d.origin,
    action: value.action,
    selector: value.selector,
    text: value.text,
    sensitive: d.sensitive,
    level: d.level,
    mode: d.mode,
    source,
  };

  if (d.decision === 'deny') {
    gate.audit({ ...auditBase, decision: 'deny', reason: d.reason, ok: false });
    log(`browser ${value.action} YASAK (agent=${value.agentId || '?'} — ${d.reason})`);
    send(res, 200, { ok: false, denied: true, error: `yasak: ${d.reason}` });
    return;
  }

  if (d.decision === 'ask' || d.decision === 'ask-session') {
    const epoch = gate.epoch();
    let appr;
    try {
      appr = await callRenderer(
        'browser:approval',
        {
          action: value.action,
          selector: value.selector,
          text: gate.preview(value.text, d.sensitive),
          agentId: value.agentId,
          origin: d.origin,
          risk: { level: d.level, reason: d.reason, sensitive: d.sensitive },
          scope: d.scope || 'once',
        },
        BROWSER_APPROVAL_TIMEOUT_MS,
      );
    } catch (err) {
      gate.audit({ ...auditBase, decision: 'ask-timeout', reason: String(err.message || err), ok: false });
      send(res, 504, { ok: false, error: 'approval round-trip failed: ' + String(err.message || err) });
      return;
    }
    if (gate.epoch() !== epoch) {
      gate.audit({ ...auditBase, decision: 'deny-stopped', reason: 'DURDUR ile kesildi', ok: false });
      send(res, 200, { ok: false, denied: true, error: 'otomasyon DURDUR ile kesildi' });
      return;
    }
    if (!appr || !appr.approved) {
      if (d.decision === 'ask-session' && d.origin) gate.denySession(d.key, d.origin);
      gate.audit({ ...auditBase, decision: 'deny-user', reason: 'kullanıcı reddetti', ok: false });
      log(`browser ${value.action} REDDEDİLDİ (agent=${value.agentId || '?'} selector=${value.selector || ''})`);
      send(res, 200, { ok: false, denied: true, error: 'user denied the action' });
      return;
    }
    if (appr.scope === 'session' && d.decision === 'ask-session' && d.origin) {
      gate.grantSession(d.key, d.origin);
    }
    log(`browser ${value.action} ONAYLANDI (agent=${value.agentId || '?'} ${d.origin || ''} — ${d.reason})`);
  }

  if (mutating) gate.consume(d.key, d.origin);

  try {
    const result = await onBrowserAction(value);
    if (!result || !result.ok) {
      gate.audit({ ...auditBase, decision: d.decision, reason: d.reason, ok: false });
      send(res, 502, { ok: false, error: (result && result.error) || 'browser action failed' });
      return;
    }
    gate.audit({ ...auditBase, decision: d.decision, reason: d.reason, ok: true });
    log(`browser ${value.action} OK (agent=${value.agentId || '?'} ${d.decision})`);
    send(res, 200, { ok: true, result: result.result ?? null });
  } catch (err) {
    gate.audit({ ...auditBase, decision: d.decision, reason: String(err.message || err), ok: false });
    send(res, 502, { ok: false, error: String(err.message || err) });
  }
}

module.exports = {
  handleBrowserRoute,
};
