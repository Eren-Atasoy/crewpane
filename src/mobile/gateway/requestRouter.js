// CrewPane — Mobile Gateway HTTP Request Router & Dispatcher (Phase 4.12)
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const auth = require('../mobileAuth.cjs');

const {
  MAX_UPLOAD_BODY_BYTES,
  MAX_ATTACHMENTS,
  TAIL_DEFAULT,
  TAIL_MAX,
  QUERY_TIMEOUT_MS,
  COMMAND_TIMEOUT_MS,
  ROUTE_SCOPES,
  COMMAND_KINDS,
  QUERY_KINDS,
  trimmed,
  queryParamsFor,
  reportListParams,
  reportDetailParams,
  routeKeyFor,
} = require('./constants.js');

const {
  send,
  readRaw,
  readBody,
  parseMultipart,
  readCommandPayload,
  withTimeout,
} = require('./payloadParser.js');

const { serveWeb } = require('./staticWeb.js');
const { runStt } = require('./sttHelper.js');

async function handleGatewayRequest(req, res, ctx) {
  const {
    bind,
    instance,
    appVersion,
    appCommit,
    webRoot,
    spriteDir,
    pending,
    allow,
    getState,
    reloadState,
    persist,
    audit,
    openStream,
    opts,
    log,
  } = ctx;

  const ip = req.socket.remoteAddress || null;
  let url;
  try {
    url = new URL(req.url, `http://${bind.host}`);
  } catch {
    send(res, 400, { ok: false, reason: 'error', error: 'bad url' });
    return;
  }
  const { key, paneId, approvalId, spriteKey, taskId, reportId } = routeKeyFor(req.method, url.pathname);
  const scope = ROUTE_SCOPES[key];

  if (!scope) {
    if (webRoot && req.method === 'GET' && !url.pathname.startsWith('/m/')) {
      const state = reloadState();
      const v = auth.authorize({ state, token: null, requiredScope: 'public' });
      if (!v.ok) {
        audit({ ip, method: req.method, path: url.pathname, status: v.status, reason: v.reason });
        send(res, v.status, { ok: false, reason: v.reason, error: v.error });
        return;
      }
      if (!allow(`anon:${ip}`)) {
        audit({ ip, method: req.method, path: url.pathname, status: 429, reason: 'rate-limited' });
        send(res, 429, { ok: false, reason: 'rate-limited', error: 'çok fazla istek' });
        return;
      }
      try {
        const served = serveWeb(url.pathname, res, webRoot);
        if (served === null) {
          audit({ ip, method: 'GET', path: url.pathname, status: 404, reason: 'not-found', note: 'web:asset' });
          send(res, 404, { ok: false, reason: 'not-found', error: 'dosya yok' });
          return;
        }
        audit({ ip, method: 'GET', path: url.pathname, status: 200, note: `web:${served}` });
      } catch (err) {
        audit({ ip, method: 'GET', path: url.pathname, status: 500, reason: 'error', note: String(err.message || err) });
        send(res, 500, { ok: false, reason: 'error', error: 'web arayüzü okunamadı' });
      }
      return;
    }
    audit({ ip, method: req.method, path: url.pathname, status: 404, reason: 'not-found' });
    send(res, 404, { ok: false, reason: 'not-found', error: 'rota yok' });
    return;
  }

  const state = reloadState();
  const token = auth.bearerFrom(req.headers['authorization']);
  const verdict = auth.authorize({ state, token, requiredScope: scope });
  if (!verdict.ok) {
    audit({ ip, method: req.method, path: url.pathname, status: verdict.status, reason: verdict.reason });
    send(res, verdict.status, { ok: false, reason: verdict.reason, error: verdict.error });
    return;
  }
  const device = verdict.device;
  const rlKey = device ? device.id : `anon:${ip}`;
  if (key !== 'GET /m/stream' && !allow(rlKey)) {
    audit({ ip, deviceId: device?.id, deviceName: device?.name, method: req.method, path: url.pathname, status: 429, reason: 'rate-limited' });
    send(res, 429, { ok: false, reason: 'rate-limited', error: 'çok fazla istek' });
    return;
  }
  if (device) {
    device.lastSeenAt = Date.now();
    try {
      persist();
    } catch {
      /* son-görülme yazımı best-effort */
    }
  }
  const ok = (status, body, note) => {
    audit({ ip, deviceId: device?.id, deviceName: device?.name, method: req.method, path: url.pathname, status, note });
    send(res, status, body);
  };

  try {
    // ── public ──────────────────────────────────────────────────────────
    if (key === 'GET /m/health') {
      ok(200, { ok: true, service: 'crewpane-mobile-gateway', instance, apiVersion: 1, version: appVersion, commit: appCommit });
      return;
    }
    if (key === 'GET /m/sprite/:key') {
      const file = spriteDir ? path.join(spriteDir, spriteKey, '48x48.png') : null;
      if (!file || !fs.existsSync(file)) {
        send(res, 404, { ok: false, reason: 'not-found', error: 'sprite yok' });
        return;
      }
      const png = fs.readFileSync(file);
      res.writeHead(200, {
        'content-type': 'image/png',
        'content-length': png.length,
        'cache-control': 'public, max-age=86400',
        'access-control-allow-origin': '*',
      });
      res.end(png);
      return;
    }
    if (key === 'POST /m/pair') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const r = auth.consumePairing({ pending, code: body.code, deviceName: body.deviceName });
      if (!r.ok) {
        audit({ ip, method: req.method, path: url.pathname, status: r.status, reason: r.reason, note: 'pairing reddedildi' });
        send(res, r.status, { ok: false, reason: r.reason, error: r.error });
        return;
      }
      const curState = getState();
      curState.devices.push(r.device);
      persist();
      audit({ ip, deviceId: r.device.id, deviceName: r.device.name, method: req.method, path: url.pathname, status: 200, note: `eşleşti (scope=${r.device.scope})` });
      log(`mobile gateway: cihaz eşleşti ${r.device.name} (${r.device.id}, scope=${r.device.scope})`);
      send(res, 200, { ok: true, deviceId: r.device.id, token: r.token, scope: r.device.scope, instance });
      return;
    }

    // ── READ ────────────────────────────────────────────────────────────
    if (key === 'GET /m/panes') {
      if (String(process.env.CREWPANE_FAULT_INJECT || '').split(',').includes('gateway')) {
        throw new TypeError('sentetik gateway handler hatası (fault-inject)');
      }
      const panes = (opts.listPanes ? opts.listPanes() : []) || [];
      ok(200, { ok: true, panes });
      return;
    }
    if (key === 'GET /m/panes/:paneId/tail') {
      const n = Math.min(TAIL_MAX, Math.max(1, Number(url.searchParams.get('lines') || TAIL_DEFAULT)));
      const num = (k) => {
        const v = Number(url.searchParams.get(k));
        return url.searchParams.has(k) && Number.isFinite(v) ? v : null;
      };
      const t = opts.paneTail ? opts.paneTail(paneId, { lines: n, before: num('before'), since: num('since') }) : null;
      if (!t) {
        ok(404, { ok: false, reason: 'not-found', error: 'pane yok' });
        return;
      }
      ok(200, {
        ok: true,
        paneId,
        lines: t.entries || [],
        live: t.live || [],
        firstSeq: t.firstSeq || 0,
        lastSeq: t.lastSeq || 0,
        hasMore: !!t.hasMore,
        gapped: !!t.gapped,
        bytesCapped: !!t.bytesCapped,
        truncated: !!t.truncated,
      });
      return;
    }
    if (key === 'GET /m/panes/:paneId/transcript') {
      if (!opts.paneTranscript) {
        ok(503, { ok: false, reason: 'error', error: 'okuma modu kaynağı bağlı değil' }, 'transcript unavailable');
        return;
      }
      const num = (k) => {
        const v = Number(url.searchParams.get(k));
        return url.searchParams.has(k) && Number.isFinite(v) ? v : null;
      };
      const rawLimit = num('limit');
      const t = opts.paneTranscript(paneId, {
        limit: rawLimit == null ? undefined : rawLimit,
        before: num('before') ?? undefined,
      });
      if (!t) {
        ok(404, { ok: false, reason: 'not-found', error: 'pane yok' });
        return;
      }
      ok(200, {
        ok: true,
        paneId,
        supported: t.supported === true,
        items: t.items || [],
        firstOff: t.firstOff || 0,
        hasMore: !!t.hasMore,
      });
      return;
    }
    if (key === 'GET /m/office') {
      if (!opts.officeSnapshot) {
        ok(503, { ok: false, reason: 'error', error: 'ofis kaynağı bağlı değil' }, 'office unavailable');
        return;
      }
      let office = null;
      try {
        office = await withTimeout(Promise.resolve(opts.officeSnapshot()), QUERY_TIMEOUT_MS);
      } catch (err) {
        ok(502, { ok: false, reason: 'error', error: `ofis okunamadı: ${err.message}` }, 'office error');
        return;
      }
      ok(200, { ok: true, instance, scope: device.scope, serverTime: Date.now(), ...office });
      return;
    }
    if (key === 'GET /m/reports') {
      if (!opts.reportsList) {
        ok(503, { ok: false, reason: 'error', error: 'rapor kaynağı bağlı değil' }, 'reports unavailable');
        return;
      }
      let data = null;
      try {
        data = await withTimeout(Promise.resolve(opts.reportsList(reportListParams(url))), QUERY_TIMEOUT_MS);
      } catch (err) {
        ok(502, { ok: false, reason: 'error', error: `raporlar okunamadı: ${err.message}` }, 'reports error');
        return;
      }
      ok(200, { ok: true, ...data });
      return;
    }
    if (key === 'GET /m/reports/:reportId') {
      if (!opts.reportRead) {
        ok(503, { ok: false, reason: 'error', error: 'rapor kaynağı bağlı değil' }, 'reports unavailable');
        return;
      }
      let report = null;
      try {
        report = await withTimeout(Promise.resolve(opts.reportRead(reportId, reportDetailParams(url))), QUERY_TIMEOUT_MS);
      } catch (err) {
        ok(502, { ok: false, reason: 'error', error: `rapor okunamadı: ${err.message}` }, 'report error');
        return;
      }
      if (!report) {
        ok(404, { ok: false, reason: 'not-found', error: `rapor yok: ${reportId}` });
        return;
      }
      ok(200, { ok: true, report });
      return;
    }
    const queryKind = QUERY_KINDS[key];
    if (queryKind) {
      let data = null;
      try {
        data = await withTimeout(opts.queryRenderer(queryKind, queryParamsFor(queryKind, url, taskId)), QUERY_TIMEOUT_MS);
      } catch (err) {
        ok(503, { ok: false, reason: 'error', error: `uygulama penceresi cevap vermedi: ${err.message}` }, 'renderer timeout');
        return;
      }
      if (data && data.error) {
        const notFound = data.reason === 'not-found';
        ok(notFound ? 404 : 502, { ok: false, reason: notFound ? 'not-found' : 'error', error: String(data.error) });
        return;
      }
      ok(200, { ok: true, ...data });
      return;
    }
    if (key === 'GET /m/jarvis/history') {
      const rawLimit = Number(trimmed(url.searchParams.get('limit'), 10) ?? NaN);
      const q = {
        limit: Number.isFinite(rawLimit) ? rawLimit : undefined,
        before: trimmed(url.searchParams.get('before'), 64),
      };
      const snap = opts.jarvisHistory ? opts.jarvisHistory(q) : { turns: [], approvals: [] };
      ok(200, {
        ok: true,
        turns: snap.turns || [],
        approvals: (snap.approvals || []).filter((a) => a.status === 'open'),
        hasMore: snap.hasMore === true,
        firstId: snap.firstId ?? null,
      });
      return;
    }
    if (key === 'GET /m/stream') {
      openStream(req, res, device);
      return;
    }

    // ── YAZMA — ADP-296 (canlı) ─────────────────────────────────────────
    if (key === 'POST /m/killswitch') {
      ok(200, { ok: true, stopped: true }, 'kill-switch (mobil)');
      log('mobile gateway: KILL-SWITCH — telefondan kapatıldı');
      setTimeout(() => {
        try {
          if (opts.killSwitch) opts.killSwitch();
        } catch (err) {
          log(`mobile gateway: kill-switch hatası: ${err.message}`);
        }
      }, 50);
      return;
    }
    if (key === 'POST /m/uploads') {
      if (!opts.saveUpload) {
        ok(503, { ok: false, reason: 'error', error: 'yükleme kaynağı bağlı değil' }, 'uploads unavailable');
        return;
      }
      let raw;
      try {
        raw = await readRaw(req, MAX_UPLOAD_BODY_BYTES);
      } catch (err) {
        ok(400, { ok: false, reason: 'error', error: err.message === 'payload too large' ? 'görsel çok büyük (tavan 10MB)' : String(err.message || err) });
        return;
      }
      let buffer = null;
      if (/multipart\/form-data/i.test(String(req.headers['content-type'] || ''))) {
        const parts = parseMultipart(raw, req.headers['content-type']);
        const img = parts && parts.image;
        if (!img || !img.audioBase64) {
          ok(400, { ok: false, reason: 'error', error: 'görsel (image) alanı gerekli (multipart/form-data)' });
          return;
        }
        buffer = Buffer.from(img.audioBase64, 'base64');
      } else {
        try {
          const parsed = JSON.parse(raw.toString('utf8') || '{}');
          if (parsed && typeof parsed.imageBase64 === 'string') buffer = Buffer.from(parsed.imageBase64, 'base64');
        } catch {
          /* aşağıda 400 */
        }
        if (!buffer) {
          ok(400, { ok: false, reason: 'error', error: 'görsel gerekli: multipart `image` alanı ya da JSON `imageBase64`' });
          return;
        }
      }
      const r = opts.saveUpload({ buffer });
      if (!r || !r.ok) {
        ok(400, { ok: false, reason: 'error', error: (r && r.error) || 'görsel kaydedilemedi' }, 'upload reddedildi');
        return;
      }
      ok(200, { ok: true, uploadId: r.uploadId, bytes: r.bytes, kind: r.kind }, `görsel yüklendi (${r.bytes}B ${r.kind})`);
      return;
    }
    if (key === 'POST /m/transcribe') {
      const payload = await readCommandPayload(req, 'transcribe');
      if (!payload.ok) {
        ok(400, { ok: false, reason: 'error', error: payload.error });
        return;
      }
      const value = payload.value;
      if (!value.audioBase64) {
        ok(400, { ok: false, reason: 'error', error: 'ses (audio) alanı gerekli' });
        return;
      }
      const t = await runStt(value, opts, log);
      if (!t.ok) {
        ok(400, { ok: false, reason: 'stt-failed', error: t.error }, `stt fail (${t.reason})`);
        return;
      }
      ok(200, { ok: true, text: t.text }, 'transkript (teslim YOK)');
      return;
    }

    const kind = COMMAND_KINDS[key];
    if (kind) {
      if (!opts.command) {
        ok(503, { ok: false, reason: 'error', error: 'komut yüzeyi bağlı değil (uygulama penceresi yok)' });
        return;
      }
      const payload = await readCommandPayload(req, kind);
      if (!payload.ok) {
        ok(400, { ok: false, reason: 'error', error: payload.error });
        return;
      }
      const value = payload.value;
      if (paneId) value.paneId = paneId;
      if (approvalId) value.approvalId = approvalId;
      if (taskId) value.taskId = taskId;

      if (kind === 'prompt' && value.attachments != null) {
        const list = Array.isArray(value.attachments) ? value.attachments : null;
        if (!list || list.length > MAX_ATTACHMENTS) {
          ok(400, { ok: false, reason: 'error', error: `attachments en çok ${MAX_ATTACHMENTS} uploadId listesi olmalı` });
          return;
        }
        const paths = [];
        for (const id of list) {
          const file = opts.resolveUpload ? opts.resolveUpload(id) : null;
          if (!file) {
            ok(400, { ok: false, reason: 'error', error: `görsel bulunamadı: ${trimmed(id, 80) || '(boş)'}` }, 'attachment reddedildi');
            return;
          }
          paths.push(file);
        }
        delete value.attachments;
        if (paths.length) value.attachmentPaths = paths;
      }

      let transcript = null;
      if (kind === 'jarvis' && value.audioBase64) {
        const t = await runStt(value, opts, log);
        if (!t.ok) {
          const status = t.reason === 'no-transcriber' ? 503 : 400;
          ok(status, { ok: false, reason: status === 503 ? 'error' : 'stt-failed', error: t.error }, `stt fail (${t.reason})`);
          return;
        }
        transcript = t.text;
        value.text = transcript;
        delete value.audioBase64;
      }

      let result;
      try {
        result = await withTimeout(opts.command(kind, value), COMMAND_TIMEOUT_MS);
      } catch (err) {
        ok(504, { ok: false, reason: 'error', error: `komut tamamlanmadı: ${err.message}` }, 'command timeout');
        return;
      }
      if (!result || !result.ok) {
        const error = (result && result.error) || 'komut başarısız';
        ok(result && result.reason === 'not-found' ? 404 : 400, {
          ok: false,
          reason: (result && result.reason) || 'error',
          error,
        });
        return;
      }
      ok(200, { ...result, ...(transcript ? { transcript } : {}) }, `komut: ${kind}`);
      return;
    }

    send(res, 404, { ok: false, reason: 'not-found', error: 'rota yok' });
  } catch (err) {
    audit({ ip, deviceId: device?.id, method: req.method, path: url.pathname, status: 500, reason: 'error', note: String(err.message || err) });
    send(res, 500, { ok: false, reason: 'error', error: String(err.message || err) });
  }
}

module.exports = {
  handleGatewayRequest,
};
