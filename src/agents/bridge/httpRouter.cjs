'use strict';

const { validateDictationPayload } = require('../../voice/dictationDelivery.cjs');
const instancePaths = require('../../config/instancePaths.cjs');
const { MAX_BODY_BYTES, TELEMETRY_BUMP_KEYS } = require('./constants.cjs');
const { checkToken, authorizeDelegateCaller } = require('./securityToken.cjs');
const {
  validateDelegatePayload,
  validateReportPayload,
  validateSprintPayload,
  validateSprintStopPayload,
  validateRecyclePayload,
  validatePaneClosePayload,
  validateShotPayload,
  validateTaskAttachmentPayload,
  validateComposePayload,
} = require('./payloadValidators.cjs');
const { defaultResultsDir, writeReportFile } = require('./reportWriter.cjs');
const { enrichDelegationSnapshot } = require('./snapshotEnrich.cjs');
const { handleBrowserRoute } = require('./browserRoute.cjs');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, obj) {
  const json = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) });
  res.end(json);
}

function createBridgeRequestHandler(ctx) {
  const {
    token,
    log,
    callRenderer,
    authorizeScope,
    resolveDelegateAgent,
    resolveResultsDir,
    onRecyclePane,
    onListPanes,
    onClosePane,
    onFocusPane,
    onShotAgents,
    onShotSend,
    onTaskAttachment,
    onReportNotify,
    onAppDbToken,
    onRequireSeat,
    onPlanWave,
    onLeaderAck,
    onSupervisorStatus,
    onIntegrationsStatus,
    onTelemetryBump,
    onDictation,
    onTeamCompose,
  } = ctx;

  const browserCtx = {
    ...ctx,
    readBody,
    send,
  };

  return async function handleRequest(req, res) {
    try {
      // AUTH first — every route requires the bearer token.
      if (!checkToken(req.headers['authorization'] || req.headers['x-crewpane-token'], token)) {
        send(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      const claimedInstance = req.headers['x-crewpane-instance'];
      if (claimedInstance && String(claimedInstance) !== instancePaths.instanceId()) {
        send(res, 403, {
          ok: false,
          error: `cross-instance rejected: bridge=${instancePaths.instanceId()}, client=${String(claimedInstance)}`,
        });
        return;
      }
      const url = new URL(req.url, 'http://127.0.0.1');

      if (req.method === 'POST' && url.pathname === '/delegate') {
        const seatDenied = typeof onRequireSeat === 'function' ? onRequireSeat('bridge:/delegate') : null;
        if (seatDenied) {
          log(`delegate REDDEDİLDİ (lisans: ${seatDenied.reason})`);
          send(res, 402, {
            ok: false,
            reason: seatDenied.reason,
            error: seatDenied.message || 'CrewPane paketi gerekli.',
          });
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse((await readBody(req)) || '{}');
        } catch {
          send(res, 400, { ok: false, error: 'invalid JSON' });
          return;
        }
        const v = validateDelegatePayload(parsed);
        if (!v.ok) {
          send(res, 400, { ok: false, error: v.error });
          return;
        }
        const authz = authorizeDelegateCaller({
          headers: req.headers,
          leaderId: v.value.leaderId,
          resolveAgent: resolveDelegateAgent,
        });
        if (!authz.ok) {
          log(`delegate REDDEDİLDİ (yetki): ${authz.reason} [${authz.code}]`);
          send(res, 403, { ok: false, code: authz.code, error: authz.reason });
          return;
        }
        if (!authz.verified) {
          log(`delegate kimliği DOĞRULANAMADI (beyan yok): leader=${v.value.leaderId} — geçişe izin verildi`);
        }
        const scoped = await authorizeScope('delegate', v.value.leaderId, v.value.department);
        if (!scoped.ok) {
          log(`delegate REDDEDİLDİ (kapsam): leader=${v.value.leaderId} target=${v.value.department} code=${scoped.code}`);
          send(res, 403, { ok: false, code: scoped.code, error: scoped.reason });
          return;
        }
        try {
          const result = await callRenderer('delegation:start', v.value);
          if (!result.ok && result.queued) {
            const msg = result.error || 'hedef ajan meşgul — iş kuyruğa alındı';
            log(`delegate → queued (${msg})`);
            send(res, 202, { ok: true, queued: true, message: msg, error: msg });
            return;
          }
          if (!result.ok) {
            send(res, 502, { ok: false, error: result.error || 'delegation failed' });
            return;
          }
          log(`delegate → delegationId=${result.delegationId} dept=${v.value.department} leader=${v.value.leaderId}`);
          const body = { ok: true, delegationId: result.delegationId };
          if (typeof result.roleGapHint === 'string' && result.roleGapHint.trim()) {
            body.roleGapHint = result.roleGapHint.trim();
            log(`delegate → rol boşluğu ipucu eklendi (dept=${v.value.department})`);
          }
          send(res, 200, body);
        } catch (err) {
          send(res, 504, { ok: false, error: String(err.message || err) });
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/report') {
        let parsed;
        try {
          parsed = JSON.parse((await readBody(req)) || '{}');
        } catch {
          send(res, 400, { ok: false, error: 'invalid JSON' });
          return;
        }
        const v = validateReportPayload(parsed);
        if (!v.ok) {
          send(res, 400, { ok: false, error: v.error });
          return;
        }
        const dir = typeof resolveResultsDir === 'function' ? resolveResultsDir() : defaultResultsDir();
        const result = writeReportFile(v.value, dir);
        if (!result.ok) {
          send(res, 500, { ok: false, error: result.error || 'report write failed' });
          return;
        }
        log(
          `report ${result.skipped ? 'kept (exists)' : 'written'} → ${result.filename} ` +
            `task=${v.value.taskId} agent=${v.value.agentName || v.value.role || '?'}`,
        );
        if (typeof onReportNotify === 'function' && !result.skipped) {
          try {
            onReportNotify({
              kind: (v.value.status || '').toLowerCase() === 'fail' ? 'fail' : 'done',
              task: v.value.taskId,
              detail: result.filename,
            });
          } catch { /* best-effort */ }
        }
        send(res, 200, { ok: true, filename: result.filename, skipped: result.skipped === true });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/pane/recycle') {
        if (typeof onRecyclePane !== 'function') {
          send(res, 501, { ok: false, error: 'pane recycle not available' });
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse((await readBody(req)) || '{}');
        } catch {
          send(res, 400, { ok: false, error: 'invalid JSON' });
          return;
        }
        const v = validateRecyclePayload(parsed);
        if (!v.ok) {
          send(res, 400, { ok: false, error: v.error });
          return;
        }
        let recycled;
        try {
          recycled = (await onRecyclePane(v.value.agentId, v.value.mode)) || 0;
        } catch (err) {
          send(res, 500, { ok: false, error: String((err && err.message) || err) });
          return;
        }
        log(`pane recycle → agent=${v.value.agentId} mode=${v.value.mode} freed=${recycled}`);
        send(res, 200, { ok: true, recycled, mode: v.value.mode });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/panes') {
        if (typeof onListPanes !== 'function') {
          send(res, 501, { ok: false, error: 'pane control not available' });
          return;
        }
        const panes = (await onListPanes({
          leaderId: url.searchParams.get('leader') || '',
          department: url.searchParams.get('department') || '',
        })) || [];
        send(res, 200, { ok: true, panes });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/pane/close') {
        if (typeof onClosePane !== 'function') {
          send(res, 501, { ok: false, error: 'pane control not available' });
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse((await readBody(req)) || '{}');
        } catch {
          send(res, 400, { ok: false, error: 'invalid JSON' });
          return;
        }
        const v = validatePaneClosePayload(parsed);
        if (!v.ok) {
          send(res, 400, { ok: false, error: v.error });
          return;
        }
        const closeAuthz = authorizeDelegateCaller({
          headers: req.headers,
          leaderId: v.value.leaderId,
          resolveAgent: resolveDelegateAgent,
        });
        if (!closeAuthz.ok) {
          log(`pane close REDDEDİLDİ (yetki): ${closeAuthz.reason} [${closeAuthz.code}]`);
          send(res, 403, { ok: false, code: closeAuthz.code, error: closeAuthz.reason });
          return;
        }
        if (!closeAuthz.verified) {
          log(`pane close kimliği DOĞRULANAMADI (beyan yok): leader=${v.value.leaderId || '-'}`);
        }
        let result;
        try {
          result = await onClosePane(v.value);
        } catch (err) {
          send(res, 500, { ok: false, error: String((err && err.message) || err) });
          return;
        }
        if (!result || result.ok !== true) {
          send(res, 400, { ok: false, error: (result && result.error) || 'close failed' });
          return;
        }
        log(
          `pane close → by=${v.value.leaderId || '-'} filter=${JSON.stringify(v.value.filter)} ` +
            `closed=${(result.closed || []).length} denied=${(result.denied || []).length}`,
        );
        send(res, 200, { ok: true, closed: result.closed || [], denied: result.denied || [] });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/pane/focus') {
        if (typeof onFocusPane !== 'function') {
          send(res, 501, { ok: false, error: 'pane control not available' });
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse((await readBody(req)) || '{}');
        } catch {
          send(res, 400, { ok: false, error: 'invalid JSON' });
          return;
        }
        const paneId = typeof parsed.paneId === 'string' ? parsed.paneId.trim() : '';
        if (!paneId) {
          send(res, 400, { ok: false, error: 'paneId is required' });
          return;
        }
        const result = await onFocusPane(paneId, {
          leaderId: typeof parsed.leaderId === 'string' ? parsed.leaderId.trim() : '',
          department: typeof parsed.department === 'string' ? parsed.department.trim() : '',
        });
        if (!result || result.ok !== true) {
          send(res, result && result.code === 'cross-team' ? 403 : 400, {
            ok: false,
            code: result && result.code,
            error: (result && result.error) || 'focus failed',
          });
          return;
        }
        send(res, 200, { ok: true, paneId });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/dictation') {
        if (typeof onDictation !== 'function') {
          send(res, 501, { ok: false, error: 'dictation delivery not available' });
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse((await readBody(req)) || '{}');
        } catch {
          send(res, 400, { ok: false, error: 'invalid JSON' });
          return;
        }
        const v = validateDictationPayload(parsed);
        if (!v.ok) {
          send(res, 400, { ok: false, error: v.error });
          return;
        }
        try {
          const result = await onDictation(v.text);
          if (!result || result.ok !== true) {
            send(res, result && result.code === 'no-focus' ? 409 : 502, {
              ok: false,
              code: (result && result.code) || undefined,
              error: (result && result.error) || 'dictation delivery failed',
            });
            return;
          }
          log(`dictation → ${result.surface} chars=${v.text.length} verified=${result.verified === true}`);
          send(res, 200, { ok: true, surface: result.surface, verified: result.verified === true });
        } catch (err) {
          send(res, 502, { ok: false, error: String((err && err.message) || err) });
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/team/compose') {
        if (typeof onTeamCompose !== 'function') {
          send(res, 501, { ok: false, error: 'team compose not available' });
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse((await readBody(req)) || '{}');
        } catch {
          send(res, 400, { ok: false, error: 'invalid JSON' });
          return;
        }
        const v = validateComposePayload(parsed);
        if (!v.ok) {
          send(res, 400, { ok: false, error: v.error });
          return;
        }
        const scoped = await authorizeScope('manage', v.value.leaderId, v.value.department);
        if (!scoped.ok) {
          log(`team compose REDDEDİLDİ (kapsam): leader=${v.value.leaderId} target=${v.value.department} code=${scoped.code}`);
          send(res, 403, { ok: false, code: scoped.code, error: scoped.reason });
          return;
        }
        let out;
        try {
          out = await onTeamCompose(v.value, { callRenderer });
        } catch (err) {
          send(res, 500, { ok: false, error: String((err && err.message) || err) });
          return;
        }
        const status = out && Number.isFinite(out.status) ? out.status : 500;
        const body = (out && out.body) || { ok: false, error: 'team compose failed' };
        log(`team compose ${v.value.action} → ${status} leader=${v.value.leaderId} dept=${v.value.department}`);
        send(res, status, body);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/sprint') {
        let parsed;
        try {
          parsed = JSON.parse((await readBody(req)) || '{}');
        } catch {
          send(res, 400, { ok: false, error: 'invalid JSON' });
          return;
        }
        const v = validateSprintPayload(parsed);
        if (!v.ok) {
          send(res, 400, { ok: false, error: v.error });
          return;
        }
        const sprintScoped = await authorizeScope('delegate', v.value.leaderId, v.value.department);
        if (!sprintScoped.ok) {
          log(`sprint REDDEDİLDİ (kapsam): leader=${v.value.leaderId} target=${v.value.department} code=${sprintScoped.code}`);
          send(res, 403, { ok: false, code: sprintScoped.code, error: sprintScoped.reason });
          return;
        }
        if (typeof onPlanWave === 'function') {
          try {
            const capped = onPlanWave(v.value.maxConcurrent);
            if (Number.isInteger(capped) && capped > 0 && capped !== v.value.maxConcurrent) {
              log(`sprint dalgası plan tavanına kısıtlandı: ${v.value.maxConcurrent ?? '(varsayılan)'} → ${capped}`);
              v.value.maxConcurrent = capped;
            }
          } catch (err) {
            log(`sprint dalga tavanı hesaplanamadı (${err.message}) — istenen değerle devam`);
          }
        }
        try {
          const result = await callRenderer('sprint:start', v.value);
          if (!result.ok) {
            send(res, 502, { ok: false, error: result.error || 'sprint start failed' });
            return;
          }
          log(`sprint → sprintId=${result.sprintId} dept=${v.value.department} tasks=${v.value.tasks.length}`);
          send(res, 200, { ok: true, sprintId: result.sprintId });
        } catch (err) {
          send(res, 504, { ok: false, error: String(err.message || err) });
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/sprint/stop') {
        let parsed;
        try {
          parsed = JSON.parse((await readBody(req)) || '{}');
        } catch {
          send(res, 400, { ok: false, error: 'invalid JSON' });
          return;
        }
        const v = validateSprintStopPayload(parsed);
        if (!v.ok) {
          send(res, 400, { ok: false, error: v.error });
          return;
        }
        const stopScoped = await authorizeScope('delegate', v.value.leaderId, v.value.department);
        if (!stopScoped.ok) {
          log(`sprint stop REDDEDİLDİ (kapsam): leader=${v.value.leaderId} target=${v.value.department} code=${stopScoped.code}`);
          send(res, 403, { ok: false, code: stopScoped.code, error: stopScoped.reason });
          return;
        }
        try {
          const result = await callRenderer('sprint:stop', v.value);
          if (!result.ok) {
            send(res, 502, { ok: false, error: result.error || 'sprint stop failed' });
            return;
          }
          log(`sprint DURDURULDU → ${result.sprintId} (canlı=${result.wasLive === true})`);
          send(res, 200, { ok: true, sprintId: result.sprintId, summary: result.summary, wasLive: result.wasLive === true });
        } catch (err) {
          send(res, 504, { ok: false, error: String(err.message || err) });
        }
        return;
      }

      if (req.method === 'GET' && url.pathname === '/sprint/status') {
        const id = url.searchParams.get('id') || undefined;
        try {
          const result = await callRenderer('sprint:status', { id });
          send(res, 200, { ok: true, status: result.status ?? null });
        } catch (err) {
          send(res, 504, { ok: false, error: String(err.message || err) });
        }
        return;
      }

      if (req.method === 'GET' && url.pathname === '/delegation/status') {
        const id = url.searchParams.get('id') || undefined;
        const leader = url.searchParams.get('leader');
        if (leader && typeof onLeaderAck === 'function') {
          try { onLeaderAck(leader); } catch { /* ack best-effort */ }
        }
        let supervisor = null;
        if (typeof onSupervisorStatus === 'function') {
          try { supervisor = onSupervisorStatus(leader || ''); } catch { supervisor = null; }
        }
        try {
          const result = await callRenderer('delegation:status', { id });
          send(res, 200, { ok: true, snapshot: enrichDelegationSnapshot(result.snapshot ?? null), supervisor });
        } catch (err) {
          if (supervisor) send(res, 200, { ok: true, snapshot: null, supervisor, rendererError: String(err.message || err) });
          else send(res, 504, { ok: false, error: String(err.message || err) });
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/browser') {
        await handleBrowserRoute(req, res, browserCtx);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/shot/agents') {
        if (typeof onShotAgents !== 'function') {
          send(res, 501, { ok: false, error: 'shot bridge not available' });
          return;
        }
        try {
          send(res, 200, { ok: true, multiShot: true, agents: (await onShotAgents()) || [] });
        } catch (err) {
          send(res, 502, { ok: false, error: String(err.message || err) });
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/shot') {
        if (typeof onShotSend !== 'function') {
          send(res, 501, { ok: false, error: 'shot bridge not available' });
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse((await readBody(req)) || '{}');
        } catch {
          send(res, 400, { ok: false, error: 'invalid JSON' });
          return;
        }
        const v = validateShotPayload(parsed);
        if (!v.ok) {
          send(res, 400, { ok: false, error: v.error });
          return;
        }
        try {
          const result = await onShotSend(v.value);
          if (!result || !result.ok) {
            const error = (result && result.error) || 'shot delivery failed';
            send(res, result && result.reason === 'not-found' ? 404 : 502, { ok: false, error });
            return;
          }
          log(`shot → agent=${v.value.agentId} pane=${result.paneId || '?'} (${v.value.paths.join(', ')})`);
          send(res, 200, { ok: true, paneId: result.paneId || null, state: result.state || null });
        } catch (err) {
          send(res, 504, { ok: false, error: String(err.message || err) });
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/task-attachment') {
        if (typeof onTaskAttachment !== 'function') {
          send(res, 501, { ok: false, error: 'attachment ingest not available' });
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse((await readBody(req)) || '{}');
        } catch {
          send(res, 400, { ok: false, error: 'invalid JSON' });
          return;
        }
        const v = validateTaskAttachmentPayload(parsed);
        if (!v.ok) {
          send(res, 400, { ok: false, error: v.error });
          return;
        }
        const accepted = [];
        const skipped = [];
        for (const item of v.value.attachments) {
          let r;
          try {
            r = await onTaskAttachment({
              path: item.path,
              taskId: v.value.taskId,
              title: item.title,
              kind: item.kind,
              source: 'agent',
              createdBy: v.value.createdBy,
            });
          } catch (err) {
            r = { ok: false, reason: 'ingest-threw', detail: String((err && err.message) || err) };
          }
          if (r && r.ok) accepted.push({ ...r, cover: item.cover === true });
          else skipped.push({ path: item.path, reason: (r && r.reason) || 'unknown', detail: r && r.detail });
        }
        log(`task-attachment → task=${v.value.taskId} kabul=${accepted.length} atlanan=${skipped.length}`);
        send(res, 200, { ok: true, accepted, skipped });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/integrations/status') {
        if (typeof onIntegrationsStatus !== 'function') {
          send(res, 501, { ok: false, error: 'integration discovery not available' });
          return;
        }
        let out;
        try {
          out = await onIntegrationsStatus({ agentId: url.searchParams.get('agent') || '' });
        } catch (err) {
          send(res, 500, { ok: false, error: String((err && err.message) || err) });
          return;
        }
        if (!out || out.ok !== true) {
          send(res, 502, { ok: false, error: (out && out.error) || 'integration status failed' });
          return;
        }
        const n = Array.isArray(out.services) ? out.services.filter((s) => s.state === 'connected').length : 0;
        log(`integrations status → agent=${url.searchParams.get('agent') || '-'} connected=${n}`);
        send(res, 200, out);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/app-db/token') {
        if (typeof onAppDbToken !== 'function') {
          send(res, 501, { ok: false, reason: 'app_db_token_unavailable' });
          return;
        }
        let out;
        try {
          out = await onAppDbToken();
        } catch (err) {
          send(res, 500, { ok: false, reason: 'error', error: String(err.message || err) });
          return;
        }
        if (!out || !out.ok || typeof out.token !== 'string' || !out.token) {
          send(res, 200, { ok: false, reason: (out && out.reason) || 'no_session' });
          return;
        }
        send(res, 200, {
          ok: true, token: out.token,
          expiresAt: Number.isFinite(out.expiresAt) ? out.expiresAt : null,
          userId: out.userId || null,
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/telemetry/bump') {
        let bumpBody;
        try { bumpBody = JSON.parse((await readBody(req)) || '{}'); } catch { bumpBody = null; }
        const key = bumpBody && typeof bumpBody.key === 'string' ? bumpBody.key : '';
        if (!TELEMETRY_BUMP_KEYS.has(key)) {
          send(res, 400, { ok: false, error: 'unknown key' });
          return;
        }
        try { if (typeof onTelemetryBump === 'function') onTelemetryBump(key); } catch { /* yut */ }
        send(res, 200, { ok: true });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/health') {
        send(res, 200, { ok: true, service: 'crewpane-delegation-bridge' });
        return;
      }

      send(res, 404, { ok: false, error: 'not found' });
    } catch (err) {
      send(res, 500, { ok: false, error: String(err.message || err) });
    }
  };
}

module.exports = {
  createBridgeRequestHandler,
};
