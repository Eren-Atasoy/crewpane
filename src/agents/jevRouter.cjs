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
 * Ayarlar üzerinden açılıp kapatılabilir (varsayılan: kullanıcının kontrolünde).
 */

const DEFAULT_PRICING = require('./modelPricing.json');

const ENGINE_TIER_FALLBACKS = Object.freeze({
  codex: { routine: 'gpt-5.6-luna', standard: 'gpt-5.6-terra', expert: 'gpt-5.6-sol' },
  gemini: { routine: 'gemini-3.8-flash', standard: 'gemini-3.7-flash', expert: 'gemini-3.1-pro' },
  antigravity: { routine: 'gemini-3.8-flash', standard: 'gemini-3.7-flash', expert: 'gemini-3.1-pro' },
});

// Görev zorluk tespiti için anahtar kelime sözlüğü
const ROUTINE_PATTERNS = [
  /\b(css|stil|style|renk|color|buton|button|padding|margin|font|typo|yazım|düzelt|çevir|translate|readme|doküman|doc|yorum|comment|log)\b/i,
  /\b(küçük|ufak|basit|kolay|hızlı|minor|simple|quick|easy)\b/i,
];

const EXPERT_PATTERNS = [
  /\b(mimari|architecture|refactor|yeniden yapılandır|güvenlik|security|vulnerability|açık|exploit|smart contract|sözleşme|concurrency|race condition|deadlock|migration|migrasyon|algoritma|algorithm|optimizasyon|optimize|tdd|test-driven)\b/i,
  /\b(kritik|ağır|complex|karmaşık|critical|p0|urgent)\b/i,
];

/**
 * Görevin karmaşıklık sınıfını tespit eder: 'routine' | 'standard' | 'expert'
 */
function classifyTask(taskText) {
  if (!taskText || typeof taskText !== 'string') return 'standard';
  const text = taskText.toLowerCase();

  for (const pattern of EXPERT_PATTERNS) {
    if (pattern.test(text)) return 'expert';
  }

  for (const pattern of ROUTINE_PATTERNS) {
    if (pattern.test(text)) return 'routine';
  }

  return 'standard';
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

/**
 * Bağlı AI motorları ve görev gereksinimine göre en uygun modeli seçer.
 * @param {Object} params
 * @param {string} params.title - Görev başlığı
 * @param {string} [params.description] - Görev açıklaması
 * @param {string} [params.currentEngine] - Ajanın atanmış varsayılan motoru (örn. 'claude')
 * @param {Array<string>} [params.availableEngines] - Kullanıcının giriş yaptığı aktif motorlar
 * @param {Object} [params.pricing] - Fiyatlandırma ve alias tablosu
 * @returns {Object} Routing kararı
 */
function routeTaskWithJev(params = {}) {
  const {
    title = '',
    description = '',
    currentEngine = 'claude',
    availableEngines = ['claude'],
    pricing = DEFAULT_PRICING,
  } = params;
  const combinedText = `${title} ${description}`.trim();
  const taskClass = classifyTask(combinedText);

  const selectedEngine = availableEngines.includes('gemini')
    ? 'gemini'
    : availableEngines.includes('claude')
      ? 'claude'
      : currentEngine;

  const effortMap = {
    routine: 'low',
    standard: 'medium',
    expert: 'high',
  };

  const reasonCodeMap = {
    routine: 'jev.reason.routine_lightweight',
    standard: 'jev.reason.standard_balanced',
    expert: 'jev.reason.expert_deep_reasoning',
  };

  const effort = effortMap[taskClass] || 'medium';
  const model = resolveTierModel(selectedEngine, taskClass, pricing);

  return {
    taskClass,
    engine: selectedEngine,
    model,
    effort,
    reason: {
      code: reasonCodeMap[taskClass] || 'jev.reason.standard_balanced',
      tier: taskClass,
    },
    // Geriye dönük uyumluluk (metin arayan çağıranlar için)
    reasonCode: reasonCodeMap[taskClass] || 'jev.reason.standard_balanced',
  };
}

module.exports = {
  classifyTask,
  resolveTierModel,
  routeTaskWithJev,
  ROUTINE_PATTERNS,
  EXPERT_PATTERNS,
};
