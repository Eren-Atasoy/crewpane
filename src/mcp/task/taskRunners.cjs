// CrewPane — Task Board MCP Handlers (Phase 4.14)
'use strict';

const crewpaneEnv = require('../../config/crewpaneEnv.cjs');
const { wingToProject } = require('../../agents/wingProject.cjs');
const mergePolicy = require('../../services/mergePolicy.cjs');
const branchName = require('../../config/branchName.cjs');

const {
  resolveSupabase,
  boardUnavailableMessage,
  activeCompanyId,
  restRequest,
  authHeaders,
  pgError,
  bumpTasksCreated,
} = require('./backendClient.cjs');

const {
  TASK_STATUSES,
  slugify,
  normalizeSprintSlug,
  genTaskId,
  validateExplicitProject,
  assigneeTeamGate,
  toolError,
  toolOk,
} = require('./taskHelpers.cjs');

const {
  attachToTask,
} = require('./taskAttachments.cjs');

const PROJECT_ISOLATIONS = ['worktree', 'off'];
const PROJECT_MERGE_APPROVALS = ['boss', 'leader', 'auto'];

async function runList(args) {
  const supa = resolveSupabase();
  if (!supa) return toolError(boardUnavailableMessage());

  const BASE_SELECT = 'id,title,status,project,sprint,assigned_agent_id,priority';
  const GIT_SELECT = `${BASE_SELECT},branch,merge_state`;
  const qp = [`select=${GIT_SELECT}`, 'order=updated_at.desc'];
  if (typeof args.status === 'string' && args.status.trim()) qp.push(`status=eq.${encodeURIComponent(args.status.trim())}`);
  if (typeof args.sprint === 'string' && args.sprint.trim())
    qp.push(`sprint=eq.${encodeURIComponent(normalizeSprintSlug(args.sprint))}`);
  if (typeof args.project === 'string' && args.project.trim()) qp.push(`project=eq.${encodeURIComponent(args.project.trim())}`);
  if (typeof args.assignee === 'string' && args.assignee.trim())
    qp.push(`assigned_agent_id=eq.${encodeURIComponent(args.assignee.trim())}`);
  let limit = Number(args.limit);
  if (!Number.isFinite(limit) || limit <= 0) limit = 20;
  limit = Math.min(Math.max(1, Math.floor(limit)), 100);
  qp.push(`limit=${limit}`);

  let res;
  let gitColumns = true;
  try {
    res = await restRequest(supa, 'GET', `/rest/v1/tasks?${qp.join('&')}`, null, await authHeaders(supa, 'GET'));
    if (res.status === 400 && /branch|merge_state/.test(pgError(res, ''))) {
      gitColumns = false;
      qp[0] = `select=${BASE_SELECT}`;
      res = await restRequest(supa, 'GET', `/rest/v1/tasks?${qp.join('&')}`, null, await authHeaders(supa, 'GET'));
    }
  } catch (err) {
    return toolError(`could not reach Supabase: ${err.message}`);
  }
  if (res.status !== 200 || !Array.isArray(res.body)) return toolError(pgError(res, 'list_tasks failed'));
  const note = gitColumns ? '' : '\n(not: bu board git-omurgası kolonlarını taşımıyor — B-01 migration\'ı bu hedefe uygulanmamış)';
  if (res.body.length === 0) return toolOk(`No tasks match the filter.${note}`);
  const lines = res.body.map((t) => {
    const who = t.assigned_agent_id ? ` @${t.assigned_agent_id}` : '';
    const sp = t.sprint ? ` {${t.sprint}}` : '';
    const br = t.branch ? ` ⎇${t.branch}` : '';
    const ms = t.merge_state && t.merge_state !== 'none' ? ` «${t.merge_state}»` : '';
    return `• ${t.id} [${t.status}]${who}${sp} (${t.project})${br}${ms} — ${t.title}`;
  });
  return toolOk(`${res.body.length} task(s):\n${lines.join('\n')}${note}`);
}

async function runCreate(args) {
  const supa = resolveSupabase();
  if (!supa) return toolError(boardUnavailableMessage());

  const title = typeof args.title === 'string' ? args.title.trim() : '';
  if (!title) return toolError('title is required.');

  const status = typeof args.status === 'string' && args.status.trim() ? args.status.trim() : 'backlog';
  if (!TASK_STATUSES.includes(status)) {
    return toolError(`invalid status "${status}" — use one of: ${TASK_STATUSES.join(', ')}.`);
  }

  const explicitProject = typeof args.project === 'string' && args.project.trim() ? args.project.trim() : '';
  if (explicitProject) {
    const v = await validateExplicitProject(supa, explicitProject);
    if (!v.ok) return toolError(`create_task failed: ${v.error}`);
  }

  const project =
    explicitProject ||
    wingToProject((crewpaneEnv.readEnv('DEPARTMENT') || '').trim()) ||
    'crewpane';

  if (typeof args.assignee === 'string' && args.assignee.trim()) {
    const gate = await assigneeTeamGate(supa, args.assignee.trim());
    if (!gate.ok) return toolError(`create_task failed: ${gate.error}`);
  }

  const row = { id: genTaskId(), title, project, status };
  if (typeof args.description === 'string' && args.description.trim()) row.description = args.description.trim();
  if (typeof args.sprint === 'string' && args.sprint.trim()) row.sprint = normalizeSprintSlug(args.sprint);
  if (typeof args.assignee === 'string' && args.assignee.trim()) row.assigned_agent_id = args.assignee.trim();
  if (Number.isFinite(Number(args.priority))) row.priority = Math.floor(Number(args.priority));

  const companyId = await activeCompanyId(supa);
  if (companyId) row.company_id = companyId;

  let res;
  try {
    res = await restRequest(supa, 'POST', '/rest/v1/tasks', row, {
      prefer: 'return=representation',
      ...(await authHeaders(supa, 'POST')),
    });
  } catch (err) {
    return toolError(`could not reach Supabase: ${err.message}`);
  }
  if (res.status !== 201 && res.status !== 200) {
    const msg = pgError(res, 'create_task failed');
    if (row.assigned_agent_id && /foreign key|violates/i.test(msg)) {
      return toolError(`create_task failed: assignee "${row.assigned_agent_id}" is not a known agent. ${msg}`);
    }
    return toolError(`create_task failed: ${msg}`);
  }
  const created = Array.isArray(res.body) ? res.body[0] : res.body;
  const id = (created && created.id) || row.id;
  bumpTasksCreated();
  const sp = row.sprint ? ` in sprint ${row.sprint}` : '';
  const who = row.assigned_agent_id ? `, assigned to ${row.assigned_agent_id}` : '';
  let base = `Created task ${id} [${status}]${sp}${who} on project "${project}". It appears on the board instantly.`;

  if (args.attachments) {
    const att = await attachToTask(supa, id, args.attachments);
    base += `\n${att.ok ? att.text : `Görsel iliştirilemedi: ${att.error}`}`;
  }
  return toolOk(base);
}

async function runUpdate(args) {
  const supa = resolveSupabase();
  if (!supa) return toolError(boardUnavailableMessage());

  const id = typeof args.id === 'string' ? args.id.trim() : '';
  if (!id) return toolError('id is required (the task to update).');

  const patch = {};
  if (typeof args.status === 'string' && args.status.trim()) {
    const status = args.status.trim();
    if (!TASK_STATUSES.includes(status)) return toolError(`invalid status "${status}" — use one of: ${TASK_STATUSES.join(', ')}.`);
    patch.status = status;
  }
  if (typeof args.assignee === 'string') {
    const a = args.assignee.trim();
    if (a) {
      const gate = await assigneeTeamGate(supa, a);
      if (!gate.ok) return toolError(`update_task failed: ${gate.error}`);
    }
    patch.assigned_agent_id = a || null;
  }
  if (typeof args.title === 'string' && args.title.trim()) patch.title = args.title.trim();
  if (typeof args.description === 'string') patch.description = args.description;
  if (typeof args.sprint === 'string') patch.sprint = normalizeSprintSlug(args.sprint) || null;
  if (typeof args.project === 'string' && args.project.trim()) {
    const v = await validateExplicitProject(supa, args.project.trim());
    if (!v.ok) return toolError(`update_task failed: ${v.error}`);
    patch.project = args.project.trim();
  }
  if (Number.isFinite(Number(args.priority))) patch.priority = Math.floor(Number(args.priority));

  if (typeof args.merge_state === 'string' && args.merge_state.trim()) {
    const to = args.merge_state.trim();
    if (!mergePolicy.STATES.includes(to)) {
      return toolError(`invalid merge_state "${to}" — use one of: ${mergePolicy.STATES.join(', ')}.`);
    }
    let cur = 'none';
    try {
      const c = await restRequest(
        supa, 'GET', `/rest/v1/tasks?id=eq.${encodeURIComponent(id)}&select=merge_state`,
        null, await authHeaders(supa, 'GET'),
      );
      if (c.status === 400) {
        return toolError('this board has no git-backbone columns yet (B-01 migration not applied here) — merge_state cannot be set.');
      }
      const row = Array.isArray(c.body) ? c.body[0] : null;
      if (!row) return toolError(`no task with id "${id}" (nothing updated).`);
      cur = typeof row.merge_state === 'string' ? row.merge_state : 'none';
    } catch (err) {
      return toolError(`could not reach Supabase: ${err.message}`);
    }
    if (cur !== to) {
      const tr = mergePolicy.transition(cur, to);
      if (!tr.ok) return toolError(`merge_state: ${tr.why}. İzinli hedefler: ${(mergePolicy.TRANSITIONS[cur] || []).join(', ') || '(yok)'}.`);
    }
    patch.merge_state = to;
  }
  if (typeof args.branch === 'string' && args.branch.trim()) {
    const b = args.branch.trim();
    if (!/^task\/[a-z0-9][a-z0-9._-]{0,60}$/.test(b)) {
      return toolError(`invalid branch "${b}" — expected task/<code> (lowercase).`);
    }
    patch.branch = b;
  }

  if (Object.keys(patch).length === 0 && args.attachments) {
    const att = await attachToTask(supa, id, args.attachments);
    return att.ok ? toolOk(att.text) : toolError(att.error);
  }
  if (Object.keys(patch).length === 0) {
    return toolError('nothing to update — pass at least one of: status, assignee, title, description, sprint, project, priority, merge_state, branch, attachments.');
  }
  patch.updated_at = new Date().toISOString();

  let res;
  try {
    res = await restRequest(supa, 'PATCH', `/rest/v1/tasks?id=eq.${encodeURIComponent(id)}`, patch, {
      prefer: 'return=representation',
      ...(await authHeaders(supa, 'PATCH')),
    });
  } catch (err) {
    return toolError(`could not reach Supabase: ${err.message}`);
  }
  if (res.status !== 200) return toolError(`update_task failed: ${pgError(res, 'update_task failed')}`);
  const rows = Array.isArray(res.body) ? res.body : [];
  if (rows.length === 0) return toolError(`no task with id "${id}" (nothing updated).`);
  const changed = Object.keys(patch).filter((k) => k !== 'updated_at').join(', ');
  let out = `Updated task ${id} (${changed}). The board reflects it instantly.`;
  if (args.attachments) {
    const att = await attachToTask(supa, id, args.attachments);
    out += `\n${att.ok ? att.text : `Görsel iliştirilemedi: ${att.error}`}`;
  }
  return toolOk(out);
}

async function upsertRegistry(table, args, extraCols, makeSlug, optionalCols) {
  const supa = resolveSupabase();
  if (!supa) return toolError(boardUnavailableMessage());

  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (!name) return toolError('name is required.');
  const toSlug = makeSlug || slugify;
  const slug = (typeof args.slug === 'string' && args.slug.trim() && toSlug(args.slug)) || toSlug(name);
  if (!slug) return toolError('could not derive a slug from the name — pass an explicit `slug`.');

  const opt = optionalCols && typeof optionalCols === 'object' ? optionalCols : null;
  const row = { slug, name, ...extraCols, ...(opt || {}) };
  if (typeof args.description === 'string' && args.description.trim()) row.description = args.description.trim();
  const companyId = await activeCompanyId(supa);
  if (companyId) row.company_id = companyId;

  const post = async (body) =>
    restRequest(supa, 'POST', `/rest/v1/${table}?on_conflict=slug`, body, {
      prefer: 'resolution=merge-duplicates,return=representation',
      ...(await authHeaders(supa, 'POST')),
    });

  let res;
  let degraded = false;
  try {
    res = await post(row);
    if (res.status === 400 && opt && Object.keys(opt).some((c) => pgError(res, '').includes(c))) {
      degraded = true;
      const bare = { ...row };
      for (const c of Object.keys(opt)) delete bare[c];
      res = await post(bare);
    }
  } catch (err) {
    return toolError(`could not reach Supabase: ${err.message}`);
  }
  if (res.status !== 201 && res.status !== 200) return toolError(`create failed: ${pgError(res, 'create failed')}`);
  return { ok: true, slug, name, degraded };
}

async function runCreateProject(args) {
  const iso = typeof args.isolation === 'string' && args.isolation.trim() ? args.isolation.trim() : 'worktree';
  if (!PROJECT_ISOLATIONS.includes(iso)) {
    return toolError(`invalid isolation "${iso}" — use one of: ${PROJECT_ISOLATIONS.join(', ')}.`);
  }
  const approval =
    typeof args.merge_approval === 'string' && args.merge_approval.trim() ? args.merge_approval.trim() : 'boss';
  if (!PROJECT_MERGE_APPROVALS.includes(approval)) {
    return toolError(`invalid merge_approval "${approval}" — use one of: ${PROJECT_MERGE_APPROVALS.join(', ')}.`);
  }
  const branch = typeof args.default_branch === 'string' && args.default_branch.trim() ? args.default_branch.trim() : 'dev';
  const refErr = branchName.refFormatError(branch);
  if (refErr) return toolError(`invalid default_branch ${JSON.stringify(branch)}: ${refErr}`);

  const r = await upsertRegistry('projects', args, {}, undefined, {
    isolation: iso,
    default_branch: branch,
    merge_approval: approval,
  });
  if (r.isError) return r;
  const note = r.degraded
    ? '\n(not: bu board git-omurgası kolonlarını taşımıyor — B-01 migration\'ı bu hedefe uygulanmamış; ' +
      'izolasyon/dal/onay AYARLARI YAZILAMADI)'
    : `\nGit omurgası: izolasyon=${iso} · varsayılan dal=${branch} · merge onayı=${approval}.`;
  return toolOk(
    `Project "${r.name}" is registered (slug: ${r.slug}). Use this slug as the \`project\` of new tasks.${note}`,
  );
}

async function runCreateSprint(args) {
  const status = typeof args.status === 'string' && args.status.trim() ? args.status.trim() : 'active';
  const r = await upsertRegistry('sprints', args, { status }, normalizeSprintSlug);
  if (r.isError) return r;
  return toolOk(
    `Sprint "${r.name}" is registered (slug: ${r.slug}). Set tasks' \`sprint\` to this slug; the board groups by sprint.`,
  );
}

async function runDeleteProject(args) {
  const supa = resolveSupabase();
  if (!supa) return toolError(boardUnavailableMessage());
  const s = typeof args.slug === 'string' ? args.slug.trim() : '';
  if (!s) return toolError('slug is required (the project to delete).');

  let reg;
  try {
    reg = await restRequest(
      supa,
      'GET',
      `/rest/v1/projects?slug=eq.${encodeURIComponent(s)}&select=slug,name,description,created_at&limit=1`,
      null,
      await authHeaders(supa, 'GET'),
    );
  } catch (err) {
    return toolError(`could not reach Supabase: ${err.message}`);
  }
  if (reg.status !== 200 || !Array.isArray(reg.body)) return toolError(pgError(reg, 'delete_project failed'));
  const row = reg.body[0] || null;

  let count = 0;
  try {
    const used = await restRequest(
      supa,
      'GET',
      `/rest/v1/tasks?project=eq.${encodeURIComponent(s)}&select=id&limit=1001`,
      null,
      await authHeaders(supa, 'GET'),
    );
    if (used.status !== 200 || !Array.isArray(used.body)) {
      return toolError(pgError(used, 'delete_project failed (task count)'));
    }
    count = used.body.length;
  } catch (err) {
    return toolError(`could not reach Supabase: ${err.message}`);
  }
  if (count > 0) {
    const n = count > 1000 ? '1000+' : String(count);
    return toolError(
      `delete_project rejected: project "${s}" has ${n} task(s) attached — deleting it would orphan them. ` +
      'Move those tasks to another project first (update_task project=...), then delete.',
    );
  }
  if (!row) {
    return toolError(
      `no project registered with slug "${s}" (and no tasks use it) — nothing to delete. ` +
      'The board dropdown derives from tasks; an empty label disappears by itself.',
    );
  }

  let del;
  try {
    del = await restRequest(supa, 'DELETE', `/rest/v1/projects?slug=eq.${encodeURIComponent(s)}`, null, {
      prefer: 'return=representation',
      ...(await authHeaders(supa, 'DELETE')),
    });
  } catch (err) {
    return toolError(`could not reach Supabase: ${err.message}`);
  }
  if (del.status !== 200 && del.status !== 204) {
    return toolError(`delete_project failed: ${pgError(del, 'delete_project failed')}`);
  }
  const deleted = Array.isArray(del.body) && del.body[0] ? del.body[0] : row;
  return toolOk(
    `Project "${s}" deleted (it had 0 tasks). It disappears from the registry instantly.\n` +
    `Undo: create_project name="${deleted.name || s}" slug="${s}"` +
    `${deleted.description ? ` description="${deleted.description}"` : ''}\n` +
    `Deleted row (for the record): ${JSON.stringify(deleted)}`,
  );
}

module.exports = {
  PROJECT_ISOLATIONS,
  PROJECT_MERGE_APPROVALS,
  runList,
  runCreate,
  runUpdate,
  upsertRegistry,
  runCreateProject,
  runCreateSprint,
  runDeleteProject,
};
