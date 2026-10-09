'use strict';

const path = require('node:path');
const { reportFileName } = require('../agentRunner.js');
const {
  MAX_REPORT_SUMMARY_LEN,
  SHOT_PROMPT_MAX_CHARS,
  SHOT_MAX_PATHS,
  ATTACH_MAX_PATHS,
} = require('./constants.cjs');

/** Validate + normalize a /delegate body → { ok, value | error }. */
function validateDelegatePayload(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be a JSON object' };
  const objective = typeof body.objective === 'string' ? body.objective.trim() : '';
  const leaderId = typeof body.leaderId === 'string' ? body.leaderId.trim() : '';
  const department = typeof body.department === 'string' ? body.department.trim() : '';
  if (!objective) return { ok: false, error: 'objective is required' };
  if (!leaderId) return { ok: false, error: 'leaderId is required' };
  if (!department) return { ok: false, error: 'department is required' };
  let workers;
  if (Array.isArray(body.workers)) {
    workers = body.workers.filter((w) => w && typeof w === 'object' && typeof w.agentId === 'string');
  }
  const value = { objective, leaderId, department };
  if (workers) value.workers = workers;
  if (body.bossId && typeof body.bossId === 'string') value.bossId = body.bossId;
  if (body.model && typeof body.model === 'string') value.model = body.model;
  if (body.provider && typeof body.provider === 'string') value.provider = body.provider;
  return { ok: true, value };
}

/**
 * TASK-MQTIYIIZE5VR7 (st2) — validate + normalize a /report body.
 */
function validateReportPayload(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be a JSON object' };
  const taskId = typeof body.taskId === 'string' ? body.taskId.trim() : '';
  if (!taskId) return { ok: false, error: 'taskId is required' };
  if (!reportFileName(taskId, 'report')) return { ok: false, error: 'taskId has no usable characters' };
  const value = { taskId };
  if (typeof body.role === 'string' && body.role.trim()) value.role = body.role.trim();
  if (typeof body.agentName === 'string' && body.agentName.trim()) value.agentName = body.agentName.trim();
  if (typeof body.status === 'string' && body.status.trim()) value.status = body.status.trim();
  if (typeof body.summary === 'string' && body.summary.trim()) {
    value.summary = body.summary.trim().slice(0, MAX_REPORT_SUMMARY_LEN);
  }
  if (body.force === true) value.force = true;
  return { ok: true, value };
}

/**
 * ADP-242 — validate + normalize a /sprint body (uzun-sprint planı).
 */
function validateSprintPayload(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be a JSON object' };
  const objective = typeof body.objective === 'string' ? body.objective.trim() : '';
  const leaderId = typeof body.leaderId === 'string' ? body.leaderId.trim() : '';
  const department = typeof body.department === 'string' ? body.department.trim() : '';
  if (!objective) return { ok: false, error: 'objective is required' };
  if (!leaderId) return { ok: false, error: 'leaderId is required' };
  if (!department) return { ok: false, error: 'department is required' };
  if (!Array.isArray(body.tasks) || body.tasks.length === 0) {
    return { ok: false, error: 'tasks is required (array of {id,title,prompt,...})' };
  }
  const tasks = [];
  for (const t of body.tasks) {
    if (!t || typeof t !== 'object') return { ok: false, error: 'every task must be an object' };
    const id = typeof t.id === 'string' ? t.id.trim() : '';
    const prompt = typeof t.prompt === 'string' ? t.prompt.trim() : '';
    if (!id) return { ok: false, error: 'every task needs an id' };
    if (!prompt) return { ok: false, error: `task ${id}: prompt is required` };
    const shaped = { id, title: typeof t.title === 'string' && t.title.trim() ? t.title.trim() : id, prompt };
    if (Array.isArray(t.dependsOn)) shaped.dependsOn = t.dependsOn.filter((d) => typeof d === 'string');
    if (typeof t.workerAgentId === 'string' && t.workerAgentId.trim()) shaped.workerAgentId = t.workerAgentId.trim();
    if (typeof t.expectedOutput === 'string' && t.expectedOutput.trim()) shaped.expectedOutput = t.expectedOutput.trim();
    if (Number.isInteger(t.maxAttempts) && t.maxAttempts > 0) shaped.maxAttempts = t.maxAttempts;
    tasks.push(shaped);
  }
  const value = { objective, leaderId, department, tasks };
  if (Number.isInteger(body.maxConcurrent) && body.maxConcurrent > 0) value.maxConcurrent = body.maxConcurrent;
  if (typeof body.bossId === 'string' && body.bossId.trim()) value.bossId = body.bossId.trim();
  return { ok: true, value };
}

/**
 * DF-03 — validate + normalize a `/sprint/stop` body.
 */
function validateSprintStopPayload(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be a JSON object' };
  const leaderId = typeof body.leaderId === 'string' ? body.leaderId.trim() : '';
  const department = typeof body.department === 'string' ? body.department.trim() : '';
  if (!leaderId) return { ok: false, error: 'leaderId is required' };
  if (!department) return { ok: false, error: 'department is required' };
  const value = { leaderId, department };
  if (typeof body.id === 'string' && body.id.trim()) value.id = body.id.trim();
  if (typeof body.reason === 'string' && body.reason.trim()) value.reason = body.reason.trim().slice(0, 300);
  return { ok: true, value };
}

/**
 * TASK-MQSBV4EFQ8D6B — validate a /pane/recycle body.
 */
function validateRecyclePayload(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be a JSON object' };
  const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : '';
  if (!agentId) return { ok: false, error: 'agentId is required' };
  const raw = typeof body.mode === 'string' ? body.mode.trim() : '';
  if (raw && raw !== 'reset' && raw !== 'kill') return { ok: false, error: "mode must be 'reset' or 'kill'" };
  return { ok: true, value: { agentId, mode: raw || 'reset' } };
}

/**
 * ADP-303 — validate a /pane/close body.
 */
function validatePaneClosePayload(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be a JSON object' };
  const filter = {};
  if (typeof body.paneId === 'string' && body.paneId.trim()) filter.paneId = body.paneId.trim();
  if (typeof body.agentId === 'string' && body.agentId.trim()) filter.agentId = body.agentId.trim();
  if (body.exitedOnly === true) filter.exitedOnly = true;
  if (body.all === true) filter.all = true;
  if (!filter.paneId && !filter.agentId && !filter.exitedOnly && !filter.all) {
    return { ok: false, error: 'a target is required: paneId, agentId, exitedOnly, or all' };
  }
  return {
    ok: true,
    value: {
      filter,
      leaderId: typeof body.leaderId === 'string' ? body.leaderId.trim() : '',
      department: typeof body.department === 'string' ? body.department.trim() : '',
      force: body.force === true,
    },
  };
}

/**
 * ADP-352 — bağımsız AgentShot'tan gelen "çekimi ajana gönder" gövdesi.
 */
function validateShotPayload(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be a JSON object' };
  const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : '';
  const raw = Array.isArray(body.paths)
    ? body.paths
    : (typeof body.path === 'string' ? [body.path] : []);
  const list = raw.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim());
  if (!list.length) return { ok: false, error: 'path is required' };
  if (list.length > SHOT_MAX_PATHS) return { ok: false, error: `at most ${SHOT_MAX_PATHS} paths` };
  for (const p of list) {
    if (!path.isAbsolute(p)) return { ok: false, error: 'path must be absolute' };
    if (!p.toLowerCase().endsWith('.png')) return { ok: false, error: 'path must be a .png screenshot' };
  }
  if (!agentId) return { ok: false, error: 'agentId is required' };
  const paths = list.map((p) => path.normalize(p));
  const value = { path: paths[0], paths, agentId };
  if (typeof body.text === 'string' && body.text.trim()) {
    value.text = body.text.trim().slice(0, SHOT_PROMPT_MAX_CHARS);
  }
  return { ok: true, value };
}

/**
 * BOARD-IMG-7 — `POST /task-attachment` gövdesi.
 */
function validateTaskAttachmentPayload(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be a JSON object' };
  const taskId = typeof body.taskId === 'string' ? body.taskId.trim() : '';
  if (!taskId) return { ok: false, error: 'taskId is required' };
  const raw = Array.isArray(body.attachments) ? body.attachments : [];
  if (!raw.length) return { ok: false, error: 'attachments[] is required' };
  if (raw.length > ATTACH_MAX_PATHS) return { ok: false, error: `at most ${ATTACH_MAX_PATHS} attachments` };
  const items = [];
  for (const it of raw) {
    const item = it && typeof it === 'object' ? it : {};
    const p = typeof item.path === 'string' ? item.path.trim() : '';
    if (!p) return { ok: false, error: 'each attachment needs a `path`' };
    if (!path.isAbsolute(p)) return { ok: false, error: `path must be absolute: ${p}` };
    const out = { path: path.normalize(p) };
    if (typeof item.title === 'string' && item.title.trim()) out.title = item.title.trim().slice(0, 200);
    if (typeof item.kind === 'string' && item.kind.trim()) out.kind = item.kind.trim();
    if (item.cover === true) out.cover = true;
    items.push(out);
  }
  const value = { taskId, attachments: items };
  if (typeof body.createdBy === 'string' && body.createdBy.trim()) value.createdBy = body.createdBy.trim().slice(0, 80);
  return { ok: true, value };
}

/**
 * TC-01 — `/team/compose` gövde doğrulaması. SAF.
 */
function validateComposePayload(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'body must be an object' };
  const action = typeof raw.action === 'string' ? raw.action.trim().toLowerCase() : '';
  if (!['propose', 'apply', 'undo'].includes(action)) {
    return { ok: false, error: "action must be 'propose', 'apply' or 'undo'" };
  }
  const leaderId = typeof raw.leaderId === 'string' ? raw.leaderId.trim() : '';
  if (!leaderId) return { ok: false, error: 'leaderId is required' };
  const department = typeof raw.department === 'string' ? raw.department.trim() : '';
  if (!department) return { ok: false, error: 'department is required' };
  const value = {
    action,
    leaderId,
    department,
    source: raw.source === 'agentx' ? 'agentx' : 'leader',
  };
  if (action === 'propose') {
    const objective = typeof raw.objective === 'string' ? raw.objective.trim() : '';
    if (!objective) return { ok: false, error: 'objective is required for propose' };
    value.objective = objective;
    value.roles = Array.isArray(raw.roles) ? raw.roles.filter((r) => typeof r === 'string') : [];
    if (typeof raw.mode === 'string' && raw.mode.trim()) value.mode = raw.mode.trim();
    if (typeof raw.teamName === 'string' && raw.teamName.trim()) value.teamName = raw.teamName.trim();
    if (typeof raw.engine === 'string' && raw.engine.trim()) value.engine = raw.engine.trim().toLowerCase();
    if (Array.isArray(raw.agents)) {
      value.agents = raw.agents.filter((a) => typeof a === 'string' && a.trim()).map((a) => a.trim());
    }
  } else {
    const proposalId = typeof raw.proposalId === 'string' ? raw.proposalId.trim() : '';
    if (!proposalId) return { ok: false, error: `proposalId is required for ${action}` };
    value.proposalId = proposalId;
    if (action === 'apply' && typeof raw.approvalToken === 'string' && raw.approvalToken.trim()) {
      value.approvalToken = raw.approvalToken.trim();
    }
  }
  return { ok: true, value };
}

module.exports = {
  validateDelegatePayload,
  validateReportPayload,
  validateSprintPayload,
  validateSprintStopPayload,
  validateRecyclePayload,
  validatePaneClosePayload,
  validateShotPayload,
  validateTaskAttachmentPayload,
  validateComposePayload,
};
