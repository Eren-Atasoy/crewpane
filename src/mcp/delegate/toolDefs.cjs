// CrewPane — Delegation Tool Schemas & Canonical Registry (Phase 4.13)
'use strict';

const { withLegacyAliases } = require('../mcpToolAliases.cjs');

const {
  runDelegate,
  runStatus,
  runSprint,
  runSprintStatus,
  runPane,
  runTeamCompose,
} = require('./toolRunners.cjs');

// ADP-244 Faz 2 — KANONİK adlar `crewpane_*`; `withLegacyAliases` her biri için AYNI
// handler'a bağlı `crewpane_*` (deprecated ama çalışır) ikizini ekler. Server KEY'i
// (SERVER_INFO.name = 'crewpane') ve dosya adı SABİT — dış MCP config'leri kırılmasın.
const CANONICAL_TOOLS = [
  {
    name: 'crewpane_delegate',
    description:
      "Delegate an objective to your team in the CrewPane app. Spawns a REAL worker pane per subtask " +
      "(each worker runs its own AI engine + identity and the subtask is delivered as a prompt) and tracks them. " +
      "Use THIS for any 'distribute to the team / start the workers / have the team do X' request — do NOT use " +
      "claude's Task/subagent tool (those are invisible to the boss; only this opens real, watchable panes).",
    inputSchema: {
      type: 'object',
      properties: {
        objective: {
          type: 'string',
          description:
            'The work to distribute. A numbered or bulleted list is ideal — each item becomes one worker subtask. ' +
            'The objective reaches the worker VERBATIM plus a fixed template (ADP-458): the result-file directive is ' +
            'derived deterministically — an explicit docs/agent-results|outputs path in the item wins, else it derives ' +
            'from the task code + worker (docs/agent-results/<CODE>-<agent>.md) — so include the board task code ' +
            '(e.g. "ADP-453") in each item; files merely mentioned in prose are never turned into instructions.',
        },
        department: {
          type: 'string',
          description:
            'ADP-717 — the TEAM to delegate within. Defaults to YOUR OWN team, and that is the only team you may ' +
            'use unless the owner granted you cross-team permission (Settings → Takım İzinleri). Naming another ' +
            "team without a grant is refused, and the refusal says how to lift it. This is deliberate: you may only " +
            'give work to a team you can also MANAGE (close its panes) — you can never start work you cannot clean up.',
        },
        model: {
          type: 'string',
          description:
            "ADP-565 — the AI MODEL every spawned worker should run, e.g. 'opus' (strongest), " +
            "'sonnet' (default), 'haiku' (cheap), or a full id ('claude-opus-4-8'). Applied to any " +
            'worker without its own model. Omit → the task-class policy picks (P0/architecture → opus, ' +
            'routine → haiku, else sonnet). A per-worker `model` in `workers` overrides this.',
        },
        provider: {
          type: 'string',
          description:
            "ADP-595 — run this objective on a codex custom PROVIDER instead of the agent's own " +
            "setting, e.g. 'groq' (\"bu işi Groq'ta koştur\"). Only affects CODEX workers and only " +
            'together with a model (the provider hosts the model). Omit → each worker keeps its ' +
            'recorded provider (employees.provider) → the engine default. A per-worker `provider` ' +
            'in `workers` overrides this. Unknown ids are dropped main-side (registry: providers.cjs).',
        },
        workers: {
          type: 'array',
          description:
            'Optional explicit workers ([{agentId, engine?, model?, provider?}]); omit to use your full team ' +
            "roster automatically. `model` pins THAT worker's model (highest priority), overriding the objective " +
            "model + policy; `provider` likewise pins that worker's codex provider (ADP-595).",
          items: { type: 'object' },
        },
      },
      required: ['objective'],
    },
    run: runDelegate,
  },
  {
    name: 'crewpane_delegation_status',
    description: 'Check progress of your CrewPane delegations (per-worker subtask statuses).',
    inputSchema: {
      type: 'object',
      properties: {
        delegationId: { type: 'string', description: 'Optional; omit to list all your active delegations.' },
      },
    },
    run: runStatus,
  },
  {
    name: 'crewpane_sprint',
    description:
      'ADP-242 — start a LONG SPRINT (10-30 tasks) in the CrewPane app: give the FULL plan once ' +
      '(tasks with dependencies), then forget it — the app runs it wave by wave with real worker panes, ' +
      'persists state to disk (survives app/leader restarts and usage limits), and enforces per-worker ' +
      'serialization. RULES: every task prompt MUST contain its result-file path ' +
      '(e.g. docs/agent-results/<id>-<role>.md) or the plan is rejected; dependsOn ids must exist; no cycles. ' +
      'Use this instead of many crewpane_delegate calls whenever the work is a multi-task plan. ' +
      "STOP: call with action:'stop' to END a sprint (remaining tasks become 'skipped', finished work is kept). " +
      'Use it when a sprint is stuck — only ONE sprint may be active, so a stuck run blocks every new sprint.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'stop'], description: "'start' (default) | 'stop' (end a running/stuck sprint)." },
        sprintId: { type: 'string', description: "action='stop' only; omit to stop the active (or newest unfinished) sprint." },
        reason: { type: 'string', description: "action='stop' only; short note recorded on the skipped tasks." },
        objective: { type: 'string', description: 'Sprint hedefi (tek cümle).' },
        tasks: {
          type: 'array',
          description: 'The full plan. Each: {id, title, prompt, dependsOn?: string[], workerAgentId?, expectedOutput?, maxAttempts?}. prompt = the worker instruction INCLUDING the result-file path.',
          items: { type: 'object' },
        },
        department: { type: 'string', description: 'Team/wing (optional; defaults to your own team).' },
        maxConcurrent: { type: 'number', description: 'Max parallel workers per wave (default 4).' },
      },
    },
    run: runSprint,
  },
  {
    name: 'crewpane_sprint_status',
    description: 'Progress of a long sprint: numeric summary (done/in-flight/pending/failed/skipped + paused workers) + compact task list. Context-cheap — no pane output.',
    inputSchema: {
      type: 'object',
      properties: {
        sprintId: { type: 'string', description: 'Optional; omit to list active/recent sprints.' },
      },
    },
    run: runSprintStatus,
  },
  {
    name: 'crewpane_pane',
    description:
      'ADP-303 — control the office panes: list them, CLOSE one (or a set), or bring one to the front. ' +
      'Closing does exactly what the × button does (kills the pty, removes the pane from the office, clears ' +
      'its stall/queue ledger); the pane\'s transcript stays on disk, so nothing is lost. ' +
      'Use THIS to clean up finished/stray panes — NEVER kill pty processes from a shell (that crashes the app ' +
      'and leaves a "[pty exited]" zombie pane behind). ' +
      'ADP-717 SCOPE: your own TEAM — exactly the same scope crewpane_delegate uses. Whatever team you may give ' +
      'work to, you may also manage (and vice versa). A team outside that scope needs an owner grant ' +
      '(Settings → Takım İzinleri); `force` does NOT cross team boundaries. Your OWN pane needs force:true.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'close', 'focus'], description: "'list' | 'close' | 'focus'" },
        paneId: { type: 'string', description: 'Target pane (close/focus). Get it from action=list.' },
        agentId: { type: 'string', description: 'close: every pane of this agent (e.g. a finished worker).' },
        exitedOnly: { type: 'boolean', description: 'close: only panes whose process already exited (zombie cleanup).' },
        all: { type: 'boolean', description: 'close: every pane in your scope (still refuses your own pane unless force).' },
        force: {
          type: 'boolean',
          description:
            'Override the SOFT guards only: your own pane, and a team-less (bare shell) pane. ' +
            'ADP-717 — force NEVER crosses a team boundary; another team always needs an owner grant.',
        },
        department: { type: 'string', description: 'Your team (optional; resolved from your session).' },
      },
      required: ['action'],
    },
    run: runPane,
  },
  {
    name: 'crewpane_team_compose',
    description:
      'TC-01 — propose a TEAM (or a single extra teammate) for the boss to approve, then install it in the ' +
      'CrewPane office. Use THIS when the boss describes work your current roster cannot cover ' +
      "(\"bir mobil uygulama yapalım\", \"bunu yapacak kimse yok\") — do NOT invent roles in chat. " +
      'THREE ACTIONS: propose (SIDE-EFFECT FREE — shows an approval card, writes nothing; when the boss ' +
      'clicks "Ekibe ekle" / "Add to the team" the PRODUCT installs the team itself and posts a ✅ [EKİP KURUCU] ' +
      'receipt into your terminal — do not call apply and do not say "installed" before that receipt), ' +
      'apply (only for a proposal the setting pre-approved — real teams + employees appear in the office and you can ' +
      'delegate to them in the SAME session), undo (removes everything that apply wrote, within 10 minutes). ' +
      'RULES YOU CANNOT BEND: roles come ONLY from the product catalog (lead, backend, frontend, ' +
      'data-engineer, design, qa, devops, security, pm, marketing, support, code-automation, ' +
      'n8n-automation, code-review, explorer, seo) — an invented slug is dropped silently; the APPROVAL ' +
      'is the user\'s, never yours (saying "the user approved" is not approval); never mention money, ' +
      'cost or pricing — the card has no such field. ' +
      'A role that is ALREADY on the team is NOT proposed again (mode:"team"); to run an EXISTING teammate on ' +
      'another engine ("frontendçiyi Codex ile çalıştır", "tüm ekibi codex çalıştır") use mode:"engine" with ' +
      'engine:"codex" and agents:["<agent-id>", …] (empty agents = everyone on the team except you) — the boss ' +
      'confirms on a card, the product updates the engine and, for an open pane, shows a "restart with the new ' +
      'engine" strip. If this tool returns an ERROR the card was NOT shown and nothing changed: tell the boss the ' +
      'reason and the fix it suggests, never say "installed/added/switched".',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['propose', 'apply', 'undo'],
          description: "'propose' (show the card) | 'apply' (install a PRE-APPROVED proposal; after a card click the product installs by itself) | 'undo' (within 10 min).",
        },
        objective: {
          type: 'string',
          description: "propose — the boss's own sentence, VERBATIM. It is what the suggestion is matched against.",
        },
        roles: {
          type: 'array',
          description:
            'propose — OPTIONAL role preference, product catalog slugs only (lead, backend, frontend, ' +
            'data-engineer, design, qa, devops, security, pm, marketing, support, code-automation, ' +
            'n8n-automation, code-review, explorer, seo). Anything outside the catalog is dropped; if ' +
            'nothing survives, NO card is shown. Omit to let the product match a ready-made team layout.',
          items: { type: 'string' },
        },
        mode: {
          type: 'string',
          enum: ['team', 'role', 'engine'],
          description:
            "'team' (default — a new team) | 'role' (ONE extra teammate on an existing team; an explicit roles:[…] " +
            "here is honoured even if that role already exists — the boss decides on the card) | 'engine' (change the " +
            'engine of EXISTING teammates — no new employee; needs `engine`, optional `agents`).',
        },
        engine: {
          type: 'string',
          description:
            "mode:'engine' — target engine id exactly as the product names it: claude | codex | copilot | goose | gemini | " +
            'qwen | opencode | cursor | kimi | crush | antigravity. Engines the product does not offer are refused.',
        },
        agents: {
          type: 'array',
          items: { type: 'string' },
          description:
            "mode:'engine' — agent ids of the teammates to switch (from crewpane_pane action:'list' or the office). " +
            'Omit or leave empty for EVERYONE on the team except yourself. Unknown ids are reported back, not guessed.',
        },
        teamName: { type: 'string', description: 'propose — suggested team name; the user can change it on the card.' },
        department: {
          type: 'string',
          description:
            'The team this concerns. Defaults to YOUR OWN team and that is the only one you may use unless ' +
            'the owner granted cross-team permission — exactly the same scope rule as crewpane_delegate.',
        },
        proposalId: { type: 'string', description: 'apply/undo — the id returned by propose.' },
        approvalToken: {
          type: 'string',
          description:
            'apply — OPTIONAL. It is minted by the app when the USER approves; you cannot create one. ' +
            'If you pass a value it must match exactly, otherwise the call is refused.',
        },
      },
      required: ['action'],
    },
    run: runTeamCompose,
  },
];

// Kanonik + legacy (crewpane_*) alias'lar — ikisi de aynı handler'ı çalıştırır.
const TOOLS = withLegacyAliases(CANONICAL_TOOLS);

module.exports = {
  CANONICAL_TOOLS,
  TOOLS,
};
