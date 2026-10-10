'use strict';

/**
 * src/agents/jev/decide.cjs
 *
 * Jev v2 — Saf Karar Çekirdeği (Pure Decision Engine)
 *
 * Yalnızca kurulu ve giriş yapılmış motorlar arasından, görevin zorluğuna,
 * risk sinyallerine, model yetenek matrisine ve kullanıcı maliyet politikasına
 * göre deterministik motor + model + efor seçimi yapar.
 *
 * Kural 0: Saf yaprak modül (fs/electron yok, IO/now enjekte edilir, kodda model adı yok).
 */

const DEFAULT_CAPABILITIES = require('./capabilities.json');
const DEFAULT_PRICING = require('../modelPricing.json');

const EXPERT_KEYWORDS = Object.freeze([
  'mimari', 'architecture', 'refactor', 'yeniden yapılandır',
  'güvenlik', 'security', 'vulnerability', 'açık', 'exploit',
  'smart contract', 'sözleşme', 'concurrency', 'race condition',
  'deadlock', 'migration', 'migrasyon', 'algoritma', 'algorithm',
  'optimizasyon', 'optimize', 'tdd', 'test-driven',
  'kritik', 'ağır', 'complex', 'karmaşık', 'critical', 'p0', 'urgent',
  'auth', 'authentication', 'crypto', 'database', 'schema', 'breaking',
]);

const ROUTINE_KEYWORDS = Object.freeze([
  'css', 'stil', 'style', 'renk', 'color', 'buton', 'button',
  'padding', 'margin', 'font', 'typo', 'yazım', 'düzelt', 'çevir',
  'translate', 'readme', 'doküman', 'doc', 'yorum', 'comment', 'log',
  'küçük', 'ufak', 'basit', 'kolay', 'hızlı', 'minor', 'simple',
  'quick', 'easy',
]);

function computeTaskHash(task) {
  if (!task) return '';
  const title = String(task.title || '').trim();
  const desc = String(task.description || '').trim();
  const files = Array.isArray(task.filesTouched) ? task.filesTouched.join(',') : '';
  return `${title}::${desc}::${files}`;
}

function checkZeroModelSkips(params) {
  if (params.queueEmpty === true) {
    return { skip: { code: 'empty-queue' } };
  }
  const task = params.task;
  if (!task || (!task.title && !task.description)) {
    return { skip: { code: 'empty-task' } };
  }
  const currentHash = computeTaskHash(task);
  if (params.lastTaskHash && params.lastTaskHash === currentHash) {
    return { skip: { code: 'duplicate-task' } };
  }
  if (Array.isArray(params.activeTasks) && params.activeTasks.length > 0) {
    const isRunning = params.activeTasks.some((t) => computeTaskHash(t) === currentHash);
    if (isRunning) return { skip: { code: 'already-running' } };
  }
  return null;
}

function scanKeywords(text, keywords) {
  const matched = [];
  for (const kw of keywords) {
    const regex = new RegExp(`\\b${kw}\\b`, 'i');
    if (regex.test(text)) matched.push(kw);
  }
  return matched;
}

function checkStructuralRisk(task, signals) {
  let isRisky = false;
  if (Array.isArray(task.filesTouched) && task.filesTouched.length > 5) {
    isRisky = true;
    signals.push('structural:many-files');
  }
  if (typeof task.promptChars === 'number' && task.promptChars > 4000) {
    signals.push('structural:large-prompt');
  }
  if (task.kind && ['architecture', 'security', 'migration'].includes(task.kind)) {
    isRisky = true;
    signals.push(`kind:${task.kind}`);
  }
  return isRisky;
}

function resolveKatmanATier(isRisky, routineMatches, task, signals) {
  if (isRisky) {
    if (routineMatches.length > 0) signals.push('signal:risk-overrides-routine');
    return { tier: 'expert', confidence: 0.95, signals, isRisky: true };
  }
  if (routineMatches.length > 0 && (!task.filesTouched || task.filesTouched.length <= 2)) {
    return { tier: 'routine', confidence: 0.85, signals, isRisky: false };
  }
  return { tier: 'standard', confidence: 0.80, signals, isRisky: false };
}

function classifyKatmanA(task) {
  const text = `${String(task.title || '')} ${String(task.description || '')}`.toLowerCase();
  const signals = [];
  const expertMatches = scanKeywords(text, EXPERT_KEYWORDS);
  const routineMatches = scanKeywords(text, ROUTINE_KEYWORDS);
  for (const m of expertMatches) signals.push(`keyword:${m}`);
  for (const m of routineMatches) signals.push(`keyword:${m}`);
  const isRisky = expertMatches.length > 0 || checkStructuralRisk(task, signals);
  return resolveKatmanATier(isRisky, routineMatches, task, signals);
}

function evaluateClassifier(classifier, katmanA, task) {
  if (!classifier) return katmanA;
  let res = null;
  try {
    res = typeof classifier === 'function' ? classifier(task) : classifier;
  } catch (_e) {
    return katmanA;
  }
  if (!res || typeof res !== 'object' || typeof res.confidence !== 'number') {
    return katmanA;
  }

  const signals = [...katmanA.signals];
  if (res.confidence < 0.7) {
    signals.push('classifier:low-confidence-fallback');
    return { ...katmanA, signals };
  }

  if (katmanA.isRisky && res.tier !== 'expert') {
    signals.push('classifier:downgrade-blocked-by-risk');
    return { tier: 'expert', confidence: katmanA.confidence, signals, isRisky: true };
  }

  signals.push('classifier:adopted');
  return {
    tier: res.tier || katmanA.tier,
    confidence: res.confidence,
    signals,
    isRisky: katmanA.isRisky,
  };
}

function filterCandidateEngines(engines) {
  if (!Array.isArray(engines)) return [];
  return engines.filter((e) => e && e.installed === true && e.loggedIn === true);
}

function resolveModelPrice(pricing, modelId) {
  const models = (pricing && pricing.models) || (DEFAULT_PRICING && DEFAULT_PRICING.models) || {};
  const item = models[modelId];
  if (!item) return { inputUsd1M: null, outputUsd1M: null, blendedCost: Infinity };
  const inputUsd1M = typeof item.inputPerMillion === 'number' ? item.inputPerMillion : 1;
  const outputUsd1M = typeof item.outputPerMillion === 'number' ? item.outputPerMillion : 5;
  const blendedCost = (inputUsd1M * 3 + outputUsd1M) / 4;
  return { inputUsd1M, outputUsd1M, blendedCost };
}

function buildModelCandidates(availableEngines, capabilities, pricing) {
  const modelDefs = capabilities.models || {};
  const candidates = [];

  for (const eng of availableEngines) {
    const engId = eng.id;
    for (const [modelId, meta] of Object.entries(modelDefs)) {
      if (meta.engine !== engId) continue;
      const price = resolveModelPrice(pricing, modelId);
      candidates.push({
        modelId,
        engine: engId,
        alias: meta.alias || modelId,
        tier: meta.tier || 'standard',
        effort: meta.effort || 'medium',
        qualityScore: meta.qualityScore || 0.8,
        contextWindow: meta.contextWindow || 128000,
        authKind: eng.authKind || null,
        ...price,
      });
    }
  }
  return candidates;
}

function sortFrugal(a, b) {
  const aSub = a.authKind === 'subscription' ? 1 : 0;
  const bSub = b.authKind === 'subscription' ? 1 : 0;
  if (aSub !== bSub) return bSub - aSub;
  return a.blendedCost - b.blendedCost;
}

function sortQuality(a, b) {
  if (b.qualityScore !== a.qualityScore) {
    return b.qualityScore - a.qualityScore;
  }
  return b.contextWindow - a.contextWindow;
}

function findHistoricalQualified(tierCandidates, history) {
  if (!history || !history.models) return null;
  const qualified = [];
  for (const c of tierCandidates) {
    const stats = history.models[c.modelId] || history.models[c.alias];
    if (stats && stats.totalRuns >= 3) {
      const passRate = stats.passedRuns / stats.totalRuns;
      if (passRate >= 0.8) {
        qualified.push({ ...c, passRate });
      }
    }
  }
  if (!qualified.length) return null;
  qualified.sort(sortFrugal);
  return qualified[0];
}

function selectModelByPolicy(params) {
  const { policy, candidates, tier, history, signals } = params;
  const tierCandidates = candidates.filter((c) => c.tier === tier);
  const pool = tierCandidates.length ? tierCandidates : candidates;
  if (!pool.length) return null;

  if (policy === 'frugal') {
    pool.sort(sortFrugal);
    signals.push('policy:frugal');
    return { selected: pool[0], reasonCode: 'jev.reason.frugal_cheapest' };
  }

  if (policy === 'quality') {
    pool.sort(sortQuality);
    signals.push('policy:quality');
    return { selected: pool[0], reasonCode: 'jev.reason.quality_best' };
  }

  // 'balanced' politika
  signals.push('policy:balanced');
  const historical = findHistoricalQualified(pool, history);
  if (historical) {
    signals.push(`history:pass-rate-${Math.round(historical.passRate * 100)}%`);
    return { selected: historical, reasonCode: 'jev.reason.balanced_historical' };
  }

  // Varsayılan dengeli seçim: kalite ve maliyet dengesi
  pool.sort((a, b) => (b.qualityScore / Math.max(a.blendedCost, 0.1)) - (a.qualityScore / Math.max(b.blendedCost, 0.1)));
  const defaultReasonCode =
    tier === 'routine'
      ? 'jev.reason.routine_lightweight'
      : tier === 'expert'
        ? 'jev.reason.expert_deep_reasoning'
        : 'jev.reason.standard_balanced';
  return { selected: pool[0], reasonCode: defaultReasonCode };
}

function buildAlternatives(candidates, selectedModelId) {
  const alts = [];
  for (const c of candidates) {
    if (c.modelId === selectedModelId) continue;
    let estCostUsd = null;
    if (Number.isFinite(c.blendedCost)) {
      estCostUsd = ((c.inputUsd1M * 2000) + (c.outputUsd1M * 500)) / 1000000;
      estCostUsd = Math.round(estCostUsd * 10000) / 10000;
    }
    alts.push({
      engine: c.engine,
      model: c.modelId,
      alias: c.alias,
      effort: c.effort,
      tier: c.tier,
      estCostUsd,
    });
  }
  return alts.slice(0, 3);
}

function buildNoEngineResult(targetTier, signals) {
  return {
    tier: targetTier,
    confidence: 0,
    engine: null,
    model: null,
    effort: 'medium',
    reason: {
      code: 'no-engine',
      signals: [...signals, 'no-installed-logged-in-engine'],
    },
    alternatives: [],
  };
}

function buildDecisionOutput(ctx) {
  const { targetTier, classification, selected, decision, defaultEffort, signals, candidates, availableEngines } = ctx;
  return {
    tier: targetTier,
    confidence: classification.confidence,
    engine: selected ? selected.engine : availableEngines[0].id,
    model: selected ? selected.modelId : null,
    effort: selected ? selected.effort : defaultEffort,
    reason: {
      code: decision ? decision.reasonCode : 'jev.reason.standard_balanced',
      signals,
    },
    alternatives: selected ? buildAlternatives(candidates, selected.modelId) : [],
  };
}

function resolveDecisionContext(params) {
  return {
    task: params.task,
    engines: Array.isArray(params.engines) ? params.engines : [],
    catalog: params.catalog,
    policy: params.policy || 'balanced',
    history: params.history || null,
    classifier: params.classifier || null,
    capabilities: params.capabilities || DEFAULT_CAPABILITIES,
  };
}

/**
 * Saf Jev Karar Fonksiyonu (Pure Decision Module)
 */
function decide(params = {}) {
  const skipResult = checkZeroModelSkips(params);
  if (skipResult) return skipResult;

  const ctx = resolveDecisionContext(params);
  const katmanA = classifyKatmanA(ctx.task);
  const classification = evaluateClassifier(ctx.classifier, katmanA, ctx.task);
  const targetTier = classification.tier;

  const availableEngines = filterCandidateEngines(ctx.engines);
  if (!availableEngines.length) {
    return buildNoEngineResult(targetTier, classification.signals);
  }

  const pricing = (ctx.catalog && ctx.catalog.pricing) || DEFAULT_PRICING;
  const candidates = buildModelCandidates(availableEngines, ctx.capabilities, pricing);

  const signals = [...classification.signals];
  const decision = selectModelByPolicy({
    policy: ctx.policy,
    candidates,
    tier: targetTier,
    history: ctx.history,
    signals,
  });

  const selected = decision ? decision.selected : null;
  const effortDefaults = ctx.capabilities.tierDefaults || {};
  const defaultEffort = (effortDefaults[targetTier] && effortDefaults[targetTier].effort) || 'medium';

  return buildDecisionOutput({
    targetTier,
    classification,
    selected,
    decision,
    defaultEffort,
    signals,
    candidates,
    availableEngines,
  });
}

module.exports = {
  decide,
  classifyKatmanA,
  computeTaskHash,
  EXPERT_KEYWORDS,
  ROUTINE_KEYWORDS,
};
