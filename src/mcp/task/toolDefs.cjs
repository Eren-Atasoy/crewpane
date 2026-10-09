// CrewPane — Task Board MCP Tool Schema Definitions (Phase 4.14)
'use strict';

const mergePolicy = require('../../services/mergePolicy.cjs');

const { TASK_STATUSES } = require('./taskHelpers.cjs');
const { ATTACHMENTS_SCHEMA, runAttach } = require('./taskAttachments.cjs');
const {
  runList,
  runCreate,
  runUpdate,
  runCreateProject,
  runDeleteProject,
  runCreateSprint,
} = require('./taskRunners.cjs');

const TOOLS = [
  {
    name: 'list_tasks',
    description:
      'List tasks from the office Task Board (most-recently-updated first). Optional filters: status, ' +
      'sprint, project, assignee (agent id), limit (default 20, max 100).',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: TASK_STATUSES, description: 'Filter by status.' },
        sprint: { type: 'string', description: 'Filter by sprint slug.' },
        project: { type: 'string', description: 'Filter by project slug.' },
        assignee: { type: 'string', description: 'Filter by assigned agent id.' },
        limit: { type: 'number', description: 'Max rows (default 20, max 100).' },
      },
    },
    run: runList,
  },
  {
    name: 'create_task',
    description:
      'Open a NEW task on the board. It appears on the office Task Board instantly (realtime). ' +
      'Required: title. Optional: description, assignee (an existing agent id), project (slug; defaults to your ' +
      "department), sprint (slug), status (one of backlog/todo/in_progress/review/done; default backlog), priority.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short task title.' },
        description: { type: 'string', description: 'Longer description / spec.' },
        assignee: {
          type: 'string',
          description:
            'Agent id to assign — must be an existing agent ON YOUR TEAM. Cross-team assignment needs '
            + 'an owner grant (same rule and same refusal as delegation).',
        },
        project: {
          type: 'string',
          description:
            'Project slug — USUALLY OMIT IT (defaults to your team/department). An unknown slug is '
            + 'REJECTED; it never silently creates a new board group. Register a truly new project '
            + 'with create_project first.',
        },
        sprint: { type: 'string', description: 'Sprint slug (e.g. SPRINT-AD-23; normalized to UPPERCASE).' },
        status: { type: 'string', enum: TASK_STATUSES, description: 'Initial status (default backlog).' },
        priority: { type: 'number', description: 'Priority (lower = higher; default 5).' },
        attachments: ATTACHMENTS_SCHEMA,
      },
      required: ['title'],
    },
    run: runCreate,
  },
  {
    name: 'update_task',
    description:
      'Update an EXISTING task by id — typically its status (backlog→todo→in_progress→review→done) or assignee. ' +
      'Change reflects on the board instantly. Pass `id` plus any of: status, assignee, title, description, sprint, project, priority.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The task id to update.' },
        status: { type: 'string', enum: TASK_STATUSES, description: 'New status.' },
        assignee: { type: 'string', description: 'New assignee agent id (empty string to unassign).' },
        title: { type: 'string', description: 'New title.' },
        description: { type: 'string', description: 'New description.' },
        sprint: { type: 'string', description: 'New sprint slug (empty string to clear; normalized to UPPERCASE).' },
        project: { type: 'string', description: 'New project slug.' },
        priority: { type: 'number', description: 'New priority.' },
        merge_state: {
          type: 'string',
          enum: [...mergePolicy.STATES],
          description:
            'B-01 git backbone: merge state. Only VALID transitions are accepted (e.g. none→merged is rejected); '
            + 'isolated→review is how an agent signals "my work is done, please review".',
        },
        branch: { type: 'string', description: 'B-01: the task branch (task/<code>, lowercase).' },
        attachments: ATTACHMENTS_SCHEMA,
      },
      required: ['id'],
    },
    run: runUpdate,
  },
  {
    name: 'attach_to_task',
    description:
      'Attach IMAGES to an EXISTING task (evidence screenshot / reference). Paths must exist ON THIS '
      + 'MACHINE — the bytes are copied into the attachment store and the card updates instantly '
      + '(realtime). Use this instead of update_task when you only want to add evidence: no other '
      + 'field can be overwritten by accident. Requires the CrewPane app to be running (the '
      + 'thumbnail and the store live there). PRIVACY: blur customer names/phone numbers BEFORE attaching.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The task id to attach to.' },
        attachments: ATTACHMENTS_SCHEMA,
        set_cover: { type: 'string', description: 'An EXISTING attachment id to make the card cover (no upload).' },
      },
      required: ['id'],
    },
    run: runAttach,
  },
  {
    name: 'create_project',
    description:
      'Register a new PROJECT (a tasks.project value). Required: name. Optional: slug (defaults to a normalized name), ' +
      'description, isolation (worktree|off — NEW projects default to worktree), default_branch (dev), ' +
      'merge_approval (boss|leader|auto). New tasks reference it by slug.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Project name.' },
        slug: { type: 'string', description: 'Project slug (optional; defaults to a normalized name).' },
        description: { type: 'string', description: 'Optional description.' },
        isolation: {
          type: 'string',
          enum: ['worktree', 'off'],
          description: 'Task isolation (B-01). worktree = every task runs in its own git worktree on task/<code>. Default: worktree.',
        },
        default_branch: {
          type: 'string',
          description: 'Merge target for finished tasks (default: dev). "main" is never chosen automatically.',
        },
        merge_approval: {
          type: 'string',
          enum: ['boss', 'leader', 'auto'],
          description: 'Who approves a merge (default: boss). leader/auto only apply while autopilot runs.',
        },
      },
      required: ['name'],
    },
    run: runCreateProject,
  },
  {
    name: 'delete_project',
    description:
      'Delete an EMPTY project from the registry (a tasks.project value with no tasks attached). ' +
      'A project that still has tasks is NOT deleted — the reply says how many tasks block it. ' +
      'The reply echoes the deleted row, so the action is reversible via create_project.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Project slug to delete (must have 0 tasks).' },
      },
      required: ['slug'],
    },
    run: runDeleteProject,
  },
  {
    name: 'create_sprint',
    description:
      'Register a new SPRINT (a tasks.sprint value). Required: name. Optional: slug (defaults to a normalized name), ' +
      'description, status (default active). The board groups tasks by sprint.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Sprint name (e.g. SPRINT-AD-24).' },
        slug: { type: 'string', description: 'Sprint slug (optional; defaults to the name, normalized to UPPERCASE).' },
        description: { type: 'string', description: 'Optional description.' },
        status: { type: 'string', description: 'Sprint status (default active).' },
      },
      required: ['name'],
    },
    run: runCreateSprint,
  },
];

module.exports = {
  TOOLS,
};
