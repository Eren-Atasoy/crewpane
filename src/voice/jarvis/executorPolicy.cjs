'use strict';

const morph = require('../turkishMorph.cjs');
const fanoutPolicy = require('../../agents/fanoutPolicy.cjs');
const spawnSpec = require('../../agents/spawnSpec.cjs');
const promptRouter = require('../../agents/promptRouter.cjs');
const { parseIntent } = require('./intentParser.cjs');
const {
  hasV,
  negV,
  TERMINAL_RE,
  isStoppedScroll,
  EN_NEG_RE,
  SCROLL_SMALL_RE,
  SCROLL_BIG_RE,
  EN_SCROLL_SMALL_RE,
  EN_SCROLL_BIG_RE,
  detectDepartment,
} = require('./intentPatterns.cjs');

/** Ajan AÇAN (ya da bir ajanın pane'ini kullanan) eylemler — 'self' direktifi bunları YASAKLAR. */
const AGENT_OPENING_ACTIONS = ['delegate', 'spawn', 'tell', 'prompt'];

/**
 * ADP-854 §3 — KURAL YOLU ↔ LLM ÖNCELİĞİ (NET KURAL, tek yerde yazılı)
 */
function applyRulePriorityGates(decision, transcript, context) {
  const low = morph.trLower(transcript);
  const toks = morph.tokens(low);
  const mentionsTerminal = TERMINAL_RE.test(low);
  const opensAgent = AGENT_OPENING_ACTIONS.includes(decision.action);
  const opensShell = decision.action === 'terminal' && decision.op === 'new-shell';

  // §3 — KAPATMA, AÇMAYI EZER.
  if (mentionsTerminal && hasV(toks, 'close') && (opensAgent || opensShell)) {
    const local = parseIntent(transcript, context);
    if (local && local.action === 'terminal' && local.op === 'kill') {
      return { ...local, rulePriority: 'close-over-open' };
    }
  }

  // ── ADP-884/jazz §8 — OLUMSUZLANMIŞ KAYDIRMA BEYNİ DE BAĞLAR ──────────────
  if (decision.action === 'browser' && decision.op === 'scroll') {
    const negTr = negV(toks, 'scroll') || negV(toks, 'move') || negV(toks, 'goto') || isStoppedScroll(low, toks);
    if (negTr || EN_NEG_RE.test(String(transcript || ''))) {
      return {
        action: 'reply', department: null, objective: null, op: null, target: null,
        rulePriority: 'negated-scroll',
        speak: 'Kaydırmamamı istedin, o yüzden kaydırmadım.',
      };
    }
  }

  // ── ADP-884/jazz §10 — MİKTAR SÖZCÜĞÜ BEYNİ EZER ──────────────────────────
  if (decision.action === 'browser' && decision.op === 'scroll') {
    const lowEnRaw = String(transcript || '').toLowerCase();
    const hasAmountCue =
      SCROLL_SMALL_RE.test(low) || SCROLL_BIG_RE.test(low) ||
      EN_SCROLL_SMALL_RE.test(lowEnRaw) || EN_SCROLL_BIG_RE.test(lowEnRaw);
    if (hasAmountCue) {
      const local = parseIntent(transcript, context);
      if (local && local.action === 'browser' && local.op === 'scroll' && local.dy != null && local.dy !== decision.dy) {
        return { ...decision, dy: local.dy, scrollTo: null, rulePriority: 'scroll-amount' };
      }
    }
  }

  // §5 — HEDEF ÇÖZÜMLEME BEYİN YOLUNDA DA GEÇERLİ.
  if (['reply', 'delegate', 'tell'].includes(decision.action)) {
    const local = parseIntent(transcript, context);
    const same =
      decision.action === 'tell' &&
      morph.trLower(decision.target || '') === morph.trLower(local.target || '');
    if (local.action === 'tell' && local.target && !same) {
      return { ...local, rulePriority: 'entity-resolution', speak: decision.speak || local.speak };
    }
    if (local.action === 'reply' && (local.unresolvedTarget || local.unresolvedRole) && decision.action !== 'reply') {
      return { ...local, rulePriority: 'unresolved-target' };
    }
  }

  // ── ADP-883 §6 — YÜZEY AÇMA: OLUMSUZLAMA BEYNİ DE BAĞLAR ──────────────────
  const negatedSurfaceOpen = negV(toks, 'open') || negV(toks, 'show') || negV(toks, 'goto');
  if (
    decision.action === 'navigate' &&
    (decision.op === 'surface' || decision.op === 'tab') &&
    negatedSurfaceOpen
  ) {
    return {
      action: 'reply', department: null, objective: null, op: null, target: null,
      rulePriority: 'negated-surface-open',
      speak: 'Açmamamı istedin, o yüzden açmadım.',
    };
  }

  // ── ADP-883 §7 — BEYİN ANLAYAMADIYSA KAYIT ÇÖZER ─────────────────────────
  if (decision.action === 'reply' && !negatedSurfaceOpen) {
    const local = parseIntent(transcript, context);
    if (local && local.action === 'navigate' && local.op === 'surface' && local.target) {
      return { ...local, rulePriority: 'surface-registry' };
    }
    if (local && local.action === 'reply' && local.unknownSurface) {
      return { ...local, rulePriority: 'unknown-surface' };
    }
    if (local && local.action === 'browser' && local.op === 'scroll') {
      return { ...local, rulePriority: 'scroll-fallback' };
    }
  }

  // §4 — OLUMSUZLANMIŞ AÇMA fiili varken pane açılmaz.
  if ((decision.action === 'spawn' || opensShell) && negV(toks, 'open')) {
    return {
      action: 'reply',
      department: null,
      objective: null,
      op: null,
      target: null,
      rulePriority: 'negated-open',
      speak: 'Açmamamı istedin, o yüzden yeni bir terminal açmadım.',
    };
  }

  return decision;
}

function echoTarget(decision, context) {
  if (decision.action === 'tell' && decision.target) {
    const aliases = Array.isArray(context && context.aliases) ? context.aliases : [];
    const a = aliases.find((x) => x && x.id === decision.target);
    if (a) return { agentId: a.id, teamId: a.department || null };
  }
  return promptRouter.brainTarget(decision, context);
}

function routePromptClass(decision, transcript, context) {
  if (!decision || typeof decision !== 'object') return decision;
  if (decision.action === 'prompt' && decision.route) return decision;
  if (decision.action === 'reply' && /^negated-/.test(String(decision.rulePriority || ''))) {
    if (decision.route) return decision;
    return { ...decision, route: { cls: promptRouter.CLS.NONE, via: `gate:${decision.rulePriority}`, target: null, body: null } };
  }
  let catalog = null;
  let rule = null;
  try {
    catalog = parseIntent(transcript, context);
    rule = promptRouter.classify(transcript, context, { catalog });
  } catch {
    return decision;
  }
  const isRuleOwn =
    !!catalog &&
    decision.action === catalog.action &&
    (decision.objective ?? null) === (catalog.objective ?? null) &&
    (decision.target ?? null) === (catalog.target ?? null);
  const brainView = isRuleOwn ? (catalog.unclassified ? { action: 'reply', unclassified: true } : null) : decision;
  let route = promptRouter.mergeBrain(rule, brainView, transcript, context);
  const handoff = decision.action === 'tell' || decision.action === 'delegate';
  const echoed = handoff && promptRouter.isEchoObjective(decision.objective, transcript, context);
  if (!route && echoed) {
    route = { cls: promptRouter.CLS.PROMPT, via: 'echo-no-body', target: echoTarget(decision, context), body: null };
  }
  if (!route) return decision;
  if (echoed && route.cls === promptRouter.CLS.PROMPT && route.body && morph.trLower(route.body) === morph.trLower(String(decision.objective).trim())) {
    route = { ...route, body: null };
  }
  if (route.cls === promptRouter.CLS.PROMPT && !route.body && !isRuleOwn && decision.objective && !echoed) {
    const obj = String(decision.objective).trim();
    if (obj && morph.trLower(obj) !== morph.trLower(transcript)) route = { ...route, body: obj };
  }
  if (route.cls === promptRouter.CLS.ACTION) return { ...decision, route };
  if (route.cls === promptRouter.CLS.NONE) {
    return {
      action: 'reply', department: null, objective: null, op: null, target: null,
      route, rulePriority: 'prompt-router-none', speak: promptRouter.NONE_ACK,
    };
  }
  const target = route.target || null;
  const base = {
    action: 'prompt',
    department: (target && target.teamId) || decision.department || context.defaultDepartment || null,
    objective: route.body || (handoff && !echoed ? decision.objective : null) || null,
    op: null,
    target: (target && target.agentId) || null,
    route,
    speak: null,
  };
  if (route.cls === promptRouter.CLS.UNCLEAR) return { ...base, executor: null };
  const carried = {};
  if (decision.executor) carried.executor = decision.executor;
  if (decision.fanoutReason) carried.fanoutReason = decision.fanoutReason;
  if (decision.browserTask) carried.browserTask = decision.browserTask;
  if (decision.resolvedVia) carried.resolvedVia = decision.resolvedVia;
  if (!carried.executor) {
    carried.executor = target && target.agentId ? 'single' : fanoutPolicy.decideExecutor({ transcript, objective: base.objective || transcript }).executor;
  }
  return { ...base, ...carried };
}

function applyExecutorPolicyInner(decision, transcript, context = {}) {
  const gated = applyRulePriorityGates(decision, transcript, context);
  if (gated !== decision) return gated;

  if (decision.action === 'spawn') {
    const parsed = spawnSpec.parseSpawnBatches(transcript);
    const low = String(transcript || '').toLocaleLowerCase('tr');
    decision = {
      ...decision,
      department: detectDepartment(low, context) || decision.department || null,
      ...(parsed.batches.length > 0
        ? {
            batches: parsed.batches,
            count: parsed.total,
            engine: parsed.batches.length === 1 ? parsed.batches[0].engine : null,
            explicitCount: parsed.explicit,
          }
        : { explicitCount: false }),
    };
  }

  const { executor, reason } = fanoutPolicy.decideExecutor({
    transcript,
    objective: decision.objective || transcript,
  });

  if (executor === 'self') {
    if (decision.action === 'self') return { ...decision, executor: 'self', fanoutReason: reason };
    if (AGENT_OPENING_ACTIONS.includes(decision.action)) {
      const local = parseIntent(transcript, context);
      const usable =
        local &&
        !AGENT_OPENING_ACTIONS.includes(local.action) &&
        local.action !== 'reply' &&
        local.action !== 'self';
      if (usable) return { ...local, executor: 'self', fanoutReason: reason, speak: local.speak || decision.speak };
      return {
        action: 'reply',
        department: decision.department ?? null,
        objective: decision.objective ?? null,
        op: null,
        target: null,
        executor: 'self',
        fanoutReason: reason,
        speak: 'Bunu kendi araçlarımla yapamıyorum (kod/dosya yazımı gerekiyor). Tek ajana vereyim mi?',
      };
    }
    return { ...decision, executor: 'self', fanoutReason: reason };
  }

  if (decision.action === 'delegate') {
    return { ...decision, executor, fanoutReason: reason };
  }
  return decision;
}

function applyExecutorPolicy(decision, transcript, context = {}) {
  if (!decision || typeof decision !== 'object') return decision;
  const policed = applyExecutorPolicyInner(decision, transcript, context);
  return routePromptClass(policed, transcript, context);
}

module.exports = {
  AGENT_OPENING_ACTIONS,
  applyRulePriorityGates,
  applyExecutorPolicy,
  echoTarget,
  routePromptClass,
  applyExecutorPolicyInner,
};
