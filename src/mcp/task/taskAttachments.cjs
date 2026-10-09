// CrewPane — Task Board Attachment Intake & Storage (Phase 4.14)
'use strict';

const bridgeClient = require('../crewpane-delegate-mcp.cjs');

const {
  resolveSupabase,
  boardUnavailableMessage,
  restRequest,
  authHeaders,
  pgError,
} = require('./backendClient.cjs');

const {
  selfAgentId,
  toolError,
  toolOk,
} = require('./taskHelpers.cjs');

/** Tek çağrıda iliştirilebilecek görsel sayısı (köprüdeki tavanla aynı). */
const ATTACH_MAX = 8;

// BOARD-IMG-7 — `attachments` parametresinin TEK tanımı
const ATTACHMENTS_SCHEMA = Object.freeze({
  type: 'array',
  description:
    'Bu göreve iliştirilecek görseller (kanıt ekran görüntüsü / referans). Her öğe BU MAKİNEDE '
    + 'var olan bir dosya YOLUDUR — baytlar ek deposuna kopyalanır, kart board ızgarasında '
    + 'kapakla görünür. cover:true olan (yoksa ilk öğe) kart kapağı olur. '
    + 'GİZLİLİK: müşteri adı / telefon / sipariş no içeren bir görseli iliştirmeden ÖNCE '
    + 'o bölgeyi bulanıklaştır — ekran görüntüsü metinden daha çok sızdırır ve grep\'lenemez.',
  items: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Mutlak dosya yolu (ör. /Users/.../screen.png). png, jpeg, webp veya gif olmalı; en çok 25 MB.',
      },
      title: { type: 'string', description: 'Görsel başlığı / kısa açıklama (isteğe bağlı; ızgarada ve modalda görünür).' },
      kind: {
        type: 'string',
        description: 'Türü: screenshot | diagram | evidence | mockup | reference (varsayılan: screenshot).',
      },
      cover: {
        type: 'boolean',
        description: 'Bu görsel kart kapağı olsun mu? (verilmezse ve kart henüz kapaksızsa ilk ek otomatik kapak olur).',
      },
    },
    required: ['path'],
  },
});

/** Çağıranın verdiği ek listesini normalize et (şekil nöbeti; MIME kararı main'de). */
function normalizeAttachments(raw) {
  if (!Array.isArray(raw)) return { ok: false, error: '`attachments` bir dizi olmalı.' };
  const list = [];
  for (const it of raw) {
    const item = it && typeof it === 'object' ? it : {};
    const p = typeof item.path === 'string' ? item.path.trim() : '';
    if (!p) return { ok: false, error: 'her ek bir `path` (mutlak dosya yolu) ister.' };
    const out = { path: p };
    if (typeof item.title === 'string' && item.title.trim()) out.title = item.title.trim();
    if (typeof item.kind === 'string' && item.kind.trim()) out.kind = item.kind.trim();
    if (item.cover === true) out.cover = true;
    list.push(out);
  }
  if (!list.length) return { ok: false, error: '`attachments` boş.' };
  if (list.length > ATTACH_MAX) return { ok: false, error: `en fazla ${ATTACH_MAX} görsel iliştirilebilir.` };
  return { ok: true, list };
}

/**
 * Baytları köprüye (main) yolla → { accepted[], skipped[] }.
 */
async function ingestViaBridge(taskId, list, createdBy) {
  let candidates = [];
  try {
    candidates = bridgeClient.discoverBridgeCandidates();
  } catch (err) {
    return { ok: false, error: `köprü keşfi başarısız: ${err.message}` };
  }
  if (!candidates.length) {
    return { ok: false, error: 'CrewPane açık değil — görsel iliştirmek için uygulama çalışıyor olmalı (küçük-resim ve ek deposu orada üretilir).' };
  }
  let res;
  try {
    res = await bridgeClient.bridgeRequestFailover(candidates, 'POST', '/task-attachment', {
      taskId,
      attachments: list,
      ...(createdBy ? { createdBy } : {}),
    });
  } catch (err) {
    return { ok: false, error: `görsel iliştirilemedi (köprü): ${err.message}` };
  }
  const body = res && res.body;
  if (!body || body.ok !== true) {
    const why = (body && body.error) || `HTTP ${res && res.status}`;
    return { ok: false, error: `görsel iliştirilemedi: ${why}` };
  }
  return { ok: true, accepted: Array.isArray(body.accepted) ? body.accepted : [], skipped: Array.isArray(body.skipped) ? body.skipped : [] };
}

/** Kabul edilen ekleri `task_attachments`e yaz. */
async function insertAttachmentRows(supa, taskId, accepted) {
  const rows = accepted.map((a, i) => ({
    task_id: taskId,
    sha256: a.sha256,
    mime: a.mime,
    bytes: a.bytes,
    ...(Number.isFinite(a.width) ? { width: a.width } : {}),
    ...(Number.isFinite(a.height) ? { height: a.height } : {}),
    local_rel_path: a.localRelPath || null,
    origin_device: a.originDevice || null,
    thumb_data_url: a.thumbDataUrl || null,
    kind: a.kind || 'screenshot',
    source: 'agent',
    title: a.title || null,
    created_by: a.createdBy || selfAgentId(),
    sort_order: 100 + i,
  }));
  let res;
  try {
    res = await restRequest(supa, 'POST', '/rest/v1/task_attachments', rows, {
      prefer: 'return=representation',
      ...(await authHeaders(supa, 'POST')),
    });
  } catch (err) {
    return { ok: false, error: `Supabase'e ulaşılamadı: ${err.message}` };
  }
  if (res.status !== 201 && res.status !== 200) {
    return { ok: false, error: pgError(res, 'ek satırı yazılamadı') };
  }
  return { ok: true, rows: Array.isArray(res.body) ? res.body : [] };
}

/** Kapak seç — `set_task_cover()` RPC'si. */
async function setCover(supa, taskId, attachmentId) {
  try {
    const res = await restRequest(supa, 'POST', '/rest/v1/rpc/set_task_cover',
      { p_task_id: taskId, p_attachment_id: attachmentId },
      await authHeaders(supa, 'POST'));
    if (res.status >= 200 && res.status < 300) return { ok: true };
    return { ok: false, error: pgError(res, 'kapak ayarlanamadı') };
  } catch (err) {
    return { ok: false, error: `kapak ayarlanamadı: ${err.message}` };
  }
}

/** Ham `reason` kodunu ajanın anlayacağı cümleye çevir. */
function describeSkip(reason) {
  switch (reason) {
    case 'unsupported-type': return 'desteklenmeyen tür (yalnız png/jpeg/webp/gif — tür UZANTIDAN değil dosya içeriğinden okunur)';
    case 'not-found': return 'dosya bu makinede bulunamadı';
    case 'not-a-file': return 'bir dosya değil (dizin?)';
    case 'too-large': return 'çok büyük (tavan 25 MB)';
    case 'unreadable': return 'okunamadı (izin?)';
    case 'bad-task-id': return 'görev kimliği yol olarak kullanılamaz';
    case 'empty': return 'dosya boş';
    default: return reason || 'bilinmeyen sebep';
  }
}

/** Bu görevin zaten bir kapağı var mı? */
async function taskHasCover(supa, taskId) {
  try {
    const res = await restRequest(
      supa, 'GET',
      `/rest/v1/task_attachments?task_id=eq.${encodeURIComponent(taskId)}&cover=is.true&select=id&limit=1`,
      null, await authHeaders(supa, 'GET'),
    );
    return res.status === 200 && Array.isArray(res.body) && res.body.length > 0;
  } catch {
    return false;
  }
}

/**
 * Ortak iliştirme akışı — `create_task`/`update_task`/`attach_to_task` üçü de bunu çağırır.
 */
async function attachToTask(supa, taskId, rawAttachments, opts = {}) {
  const norm = normalizeAttachments(rawAttachments);
  if (!norm.ok) return { ok: false, error: norm.error };

  const ing = await ingestViaBridge(taskId, norm.list, opts.createdBy || selfAgentId());
  if (!ing.ok) return { ok: false, error: ing.error };

  const lines = [];
  let insertedIds = [];
  if (ing.accepted.length) {
    const ins = await insertAttachmentRows(supa, taskId, ing.accepted);
    if (!ins.ok) return { ok: false, error: ins.error };
    insertedIds = ins.rows.map((r) => r && r.id).filter(Boolean);
    const names = ing.accepted.map((a) => a.title || a.sha256.slice(0, 8)).join(', ');
    lines.push(`${ing.accepted.length} görsel ${taskId}'e iliştirildi (${names}). Kart board'da anında güncellendi.`);

    const coverIdx = ing.accepted.findIndex((a) => a.cover === true);
    const pickIdx = coverIdx >= 0 ? coverIdx : (await taskHasCover(supa, taskId) ? -1 : 0);
    if (pickIdx >= 0 && insertedIds[pickIdx]) {
      const cov = await setCover(supa, taskId, insertedIds[pickIdx]);
      if (cov.ok) lines.push(`Kapak: ${ing.accepted[pickIdx].title || ing.accepted[pickIdx].sha256.slice(0, 8)}`);
      else lines.push(`(kapak ayarlanamadı: ${cov.error})`);
    }
  }
  for (const s of ing.skipped) {
    lines.push(`Atlandı: ${s.path} — ${describeSkip(s.reason)}${s.detail ? ` (${s.detail})` : ''}`);
  }
  if (!ing.accepted.length) return { ok: false, error: lines.join('\n') || 'hiçbir görsel iliştirilemedi.' };
  return { ok: true, text: lines.join('\n'), count: ing.accepted.length };
}

/** `attach_to_task` — var olan bir karta görsel iliştir. */
async function runAttach(args) {
  const supa = resolveSupabase();
  if (!supa) return toolError(boardUnavailableMessage());

  const id = typeof args.id === 'string' ? args.id.trim() : '';
  if (!id) return toolError('id is required (the task to attach to).');

  if (!args.attachments && typeof args.set_cover === 'string' && args.set_cover.trim()) {
    const cov = await setCover(supa, id, args.set_cover.trim());
    return cov.ok ? toolOk(`Kapak güncellendi (${id}).`) : toolError(cov.error);
  }
  if (!args.attachments) return toolError('attachments[] is required (or set_cover to pick an existing one).');

  const r = await attachToTask(supa, id, args.attachments);
  if (!r.ok) return toolError(r.error);
  if (typeof args.set_cover === 'string' && args.set_cover.trim()) {
    const cov = await setCover(supa, id, args.set_cover.trim());
    if (!cov.ok) return toolOk(`${r.text}\n(kapak ayarlanamadı: ${cov.error})`);
  }
  return toolOk(r.text);
}

module.exports = {
  ATTACH_MAX,
  ATTACHMENTS_SCHEMA,
  normalizeAttachments,
  attachToTask,
  describeSkip,
  runAttach,
};
