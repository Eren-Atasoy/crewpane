'use strict';

/**
 * src/agents/jevRouter.cjs
 *
 * Jev AI — Akıllı Model Yönlendirici (Smart Model & Engine Router)
 *
 * Görevlerin zorluk derecesini ve gereksinimlerini analiz ederek, bağlı olan AI motorları
 * (Claude, Codex, Gemini vb.) arasından fiyat-performans ve hızı maksimize eden
 * en uygun modeli dinamik olarak seçer.
 *
 * Faz 2: saf `jev/decide.cjs` modülünün ince sarmalayıcısıdır.
 */

const DEFAULT_PRICING = require('./modelPricing.json');
const { decide, classifyKatmanA, EXPERT_KEYWORDS, ROUTINE_KEYWORDS } = require('./jev/decide.cjs');
const { generateWeeklyReport } = require('./jev/report.cjs');

const ENGINE_TIER_FALLBACKS = Object.freeze({
  codex: { routine: 'gpt-5.6-luna', standard: 'gpt-5.6-terra', expert: 'gpt-5.6-sol' },
  gemini: { routine: 'gemini-3.8-flash', standard: 'gemini-3.7-flash', expert: 'gemini-3.1-pro' },
  antigravity: { routine: 'gemini-3.8-flash', standard: 'gemini-3.7-flash', expert: 'gemini-3.1-pro' },
});

const ROUTINE_PATTERNS = Object.freeze(
  ROUTINE_KEYWORDS.map((k) => new RegExp(`\\b${k}\\b`, 'i'))
);

const EXPERT_PATTERNS = Object.freeze(
  EXPERT_KEYWORDS.map((k) => new RegExp(`\\b${k}\\b`, 'i'))
);

/**
 * Görevin karmaşıklık sınıfını tespit eder: 'routine' | 'standard' | 'expert'
 */
function classifyTask(taskText) {
  if (!taskText || typeof taskText !== 'string') return 'standard';
  const result = classifyKatmanA({ title: taskText });
  return result.tier;
}

function resolveCodexModel(tier, pricing) {
  const openaiAliases =
    (pricing && pricing.engineTables && pricing.engineTables.openai && pricing.engineTables.openai.aliases) ||
    {};
  const key = tier === 'routine' ? 'luna' : tier === 'expert' ? 'sol' : 'terra';
  return openaiAliases[key] || ENGINE_TIER_FALLBACKS.codex[tier];
}

/**
 * Motor ve tier'e göre dinamik model kimliğini katalogdan / tablodan çözümler.
 * Koda gömülü model adı tutulmaz (modelPricing.json ve modelCatalog tek kaynaktır).
 */
function resolveTierModel(engine, tier, pricing = DEFAULT_PRICING) {
  const normEngine = (engine || 'claude').toLowerCase();
  const safeTier = tier === 'routine' || tier === 'expert' ? tier : 'standard';

  if (normEngine === 'codex') return resolveCodexModel(safeTier, pricing);
  if (ENGINE_TIER_FALLBACKS[normEngine]) return ENGINE_TIER_FALLBACKS[normEngine][safeTier];

  const claudeAliases = (pricing && pricing.aliases) || {};
  const aliasKey = safeTier === 'routine' ? 'haiku' : safeTier === 'expert' ? 'opus' : 'sonnet';
  return claudeAliases[aliasKey] || aliasKey;
}

function pickFallbackEngine(availableEngines, currentEngine) {
  if (Array.isArray(availableEngines) && availableEngines.includes('gemini')) return 'gemini';
  if (Array.isArray(availableEngines) && availableEngines.includes('claude')) return 'claude';
  return currentEngine;
}

function resolveEffort(taskClass, effort) {
  if (effort) return effort;
  if (taskClass === 'routine') return 'low';
  if (taskClass === 'expert') return 'high';
  return 'medium';
}

function buildEngineList(availableEngines) {
  return (availableEngines || []).map((id) => ({
    id,
    installed: true,
    loggedIn: true,
    authKind: id === 'gemini' ? 'subscription' : 'api-key',
  }));
}

function buildRouterOutput(decision, selectedEngine, pricing) {
  const taskClass = decision.tier || 'standard';
  const model = decision.model || resolveTierModel(selectedEngine, taskClass, pricing);
  const effort = resolveEffort(taskClass, decision.effort);
  const reasonCode = (decision.reason && decision.reason.code) || 'jev.reason.standard_balanced';

  return {
    taskClass,
    engine: selectedEngine,
    model,
    effort,
    reason: decision.reason || { code: reasonCode, tier: taskClass, signals: [] },
    reasonCode,
    alternatives: decision.alternatives || [],
    skip: decision.skip,
  };
}

/**
 * Bağlı AI motorları ve görev gereksinimine göre en uygun modeli seçer.
 */
function routeTaskWithJev(params = {}) {
  const {
    title = '',
    description = '',
    currentEngine = 'claude',
    availableEngines = ['claude'],
    pricing = DEFAULT_PRICING,
    policy = 'balanced',
    history = null,
    classifier = null,
  } = params;

  const engines = buildEngineList(availableEngines);
  const decision = decide({
    task: { title, description },
    engines,
    catalog: { pricing },
    policy,
    history,
    classifier,
  });

  const selectedEngine = decision.engine || pickFallbackEngine(availableEngines, currentEngine);
  return buildRouterOutput(decision, selectedEngine, pricing);
}

module.exports = {
  classifyTask,
  resolveTierModel,
  routeTaskWithJev,
  decide,
  generateWeeklyReport,
  ROUTINE_PATTERNS,
  EXPERT_PATTERNS,
};
