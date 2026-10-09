// CrewPane — Task Board Data & Scope Validation Helpers (Phase 4.14)
'use strict';

const crewpaneEnv = require('../../config/crewpaneEnv.cjs');
const teamScope = require('../../agents/teamScope.cjs');
const { restRequest, authHeaders } = require('./backendClient.cjs');

// tasks_status_check (migration 20260520010000) — keep in sync.
const TASK_STATUSES = Object.freeze(['backlog', 'todo', 'in_progress', 'review', 'done']);

function toolError(text) {
  return { content: [{ type: 'text', text }], isError: true };
}
function toolOk(text) {
  return { content: [{ type: 'text', text }] };
}

/** Normalize a free-text name into a safe slug, preserving case (SPRINT-AD-23). */
function slugify(name) {
  return String(name || '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .replace(/^-+|-+$/g, '');
}

// ADP-253 — sprint slug'ının KANONİK formu BÜYÜK harftir.
function normalizeSprintSlug(value) {
  return slugify(value).toUpperCase();
}

/** Generate a unique TEXT task id (tasks.id is a caller-supplied PK). */
function genTaskId() {
  const t = Date.now().toString(36);
  const r = Math.floor(Math.random() * 60466176).toString(36); // up to 6 base36 digits
  return `TASK-${t}${r}`.toUpperCase();
}

/** The agent's own id (for assignee default / attribution), best-effort. */
function selfAgentId() {
  return (crewpaneEnv.readEnv('LEADER_ID') || crewpaneEnv.readEnv('AGENT_ID') || '').trim() || null;
}

let _teamPolicyProvider = () => {
  return require('../../agents/agentSettings.cjs').readSettings().teamScope;
};

/** Test dikişi — birim testler gerçek settings.json'a dokunmaz. */
function _setTeamPolicyForTest(fn) {
  _teamPolicyProvider = typeof fn === 'function' ? fn : () => undefined;
}

function readTeamScopePolicy() {
  try {
    return teamScope.sanitizeTeamScope(_teamPolicyProvider());
  } catch {
    return teamScope.sanitizeTeamScope(undefined);
  }
}

/** Çağıranın kendi takımı (pane env'inden; ADP-244 dual-read). */
function callerScope() {
  return (crewpaneEnv.readEnv('DEPARTMENT') || '').trim();
}

/**
 * Assignee bu çağıranın iş verebileceği biri mi? — ADP-717 kapısının görev-ataması yüzü.
 */
async function assigneeTeamGate(supa, assigneeId) {
  const self = selfAgentId();
  if (self && assigneeId === self) return { ok: true };
  const mine = callerScope();
  if (!mine) return { ok: true };

  let row = null;
  try {
    const res = await restRequest(
      supa,
      'GET',
      `/rest/v1/agents?id=eq.${encodeURIComponent(assigneeId)}&select=id,department`,
      null,
      await authHeaders(supa, 'GET'),
    );
    if (res.status !== 200 || !Array.isArray(res.body)) return { ok: true };
    row = res.body[0] || null;
  } catch {
    return { ok: true };
  }
  if (!row) {
    return {
      ok: false,
      error: `assignee "${assigneeId}" is not a known agent — görev atanmadı. Ajanın gerçek id'sini kullan (görünen ad değil).`,
    };
  }
  const dept = typeof row.department === 'string' ? row.department.trim() : '';
  if (!dept) {
    return {
      ok: false,
      error: `assignee "${assigneeId}" hiçbir takımda görünmüyor (department boş) — görev atanmadı. Önce ajanı bir takıma bağla.`,
    };
  }
  const dec = teamScope.authorize({
    action: 'delegate',
    callerId: self || '',
    callerScope: mine,
    targetScope: dept,
    policy: readTeamScopePolicy(),
  });
  if (dec.ok) return { ok: true };
  return { ok: false, error: `assignee "${assigneeId}": ${dec.reason}` };
}

/**
 * Açıkça verilen `project` slug'ının nöbeti — bilinmeyen slug SESSİZCE yeni board
 * grubu doğurmaz.
 */
async function validateExplicitProject(supa, slug) {
  const s = String(slug || '').trim();
  if (!s) return { ok: true };
  const mine = callerScope();
  if (mine && s.toLowerCase() === mine.toLowerCase()) return { ok: true };
  try {
    const reg = await restRequest(
      supa,
      'GET',
      `/rest/v1/projects?slug=eq.${encodeURIComponent(s)}&select=slug&limit=1`,
      null,
      await authHeaders(supa, 'GET'),
    );
    if (reg.status === 200 && Array.isArray(reg.body) && reg.body.length) return { ok: true };
    const used = await restRequest(
      supa,
      'GET',
      `/rest/v1/tasks?project=eq.${encodeURIComponent(s)}&select=id&limit=1`,
      null,
      await authHeaders(supa, 'GET'),
    );
    if (used.status === 200 && Array.isArray(used.body) && used.body.length) return { ok: true };
    if (reg.status !== 200 || used.status !== 200) return { ok: true };
  } catch {
    return { ok: true };
  }
  return {
    ok: false,
    error:
      `unknown project "${s}" — board'da böyle bir proje yok ve bilinmeyen slug sessizce yeni grup AÇMAZ. ` +
      'Ya `project` alanını hiç verme (görev, takımının board projesine düşer — ' +
      'departman slug\'ın proje slug\'ından farklıysa eşleme otomatik uygulanır), ' +
      'ya da gerçekten yeni bir proje gerekiyorsa önce create_project ile AÇIKÇA kaydet.',
  };
}

module.exports = {
  TASK_STATUSES,
  toolError,
  toolOk,
  slugify,
  normalizeSprintSlug,
  genTaskId,
  selfAgentId,
  callerScope,
  _setTeamPolicyForTest,
  readTeamScopePolicy,
  assigneeTeamGate,
  validateExplicitProject,
};
