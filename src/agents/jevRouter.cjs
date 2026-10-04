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

const fs = require('fs');
const path = require('path');

// Görev zorluk tespiti için anahtar kelime sözlüğü
const ROUTINE_PATTERNS = [
  /\b(css|stil|style|renk|color|buton|button|padding|margin|font|typo|yazım|düzelt|çevir|translate|readme|doküman|doc|yorum|comment|log)\b/i,
  /\b(küçük|ufak|basit|kolay|hızlı|minor|simple|quick|easy)\b/i
];

const EXPERT_PATTERNS = [
  /\b(mimari|architecture|refactor|yeniden yapılandır|güvenlik|security|vulnerability|açık|exploit|smart contract|sözleşme|concurrency|race condition|deadlock|migration|migrasyon|algoritma|algorithm|optimizasyon|optimize|tdd|test-driven)\b/i,
  /\b(kritik|ağır|complex|karmaşık|critical|p0|urgent)\b/i
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

/**
 * Bağlı AI motorları ve görev gereksinimine göre en uygun modeli seçer.
 * @param {Object} params
 * @param {string} params.title - Görev başlığı
 * @param {string} [params.description] - Görev açıklaması
 * @param {string} [params.currentEngine] - Ajanın atanmış varsayılan motoru (örn. 'claude')
 * @param {Array<string>} [params.availableEngines] - Kullanıcının giriş yaptığı aktif motorlar
 * @returns {Object} Routing kararı
 */
function routeTaskWithJev(params = {}) {
  const { title = '', description = '', currentEngine = 'claude', availableEngines = ['claude'] } = params;
  const combinedText = `${title} ${description}`.trim();
  const taskClass = classifyTask(combinedText);

  // Model Haritası: Her sınıf için fiyat/performans/hız dengesi
  switch (taskClass) {
    case 'routine':
      return {
        taskClass: 'routine',
        engine: availableEngines.includes('gemini') ? 'gemini' : (availableEngines.includes('claude') ? 'claude' : currentEngine),
        model: currentEngine === 'gemini' ? 'gemini-2.0-flash' : 'claude-3-5-haiku-latest',
        effort: 'low',
        reason: 'Rutin veya stil/dokümantasyon görevi: Maksimum yanıt hızı ve %80 token tasarrufu için hafif model seçildi.',
        priceScore: 'Very Low ($)',
        speedScore: 'Ultra Fast (5x)'
      };

    case 'expert':
      return {
        taskClass: 'expert',
        engine: currentEngine,
        model: currentEngine === 'codex' ? 'o1' : 'claude-3-7-sonnet-latest',
        effort: 'high',
        reason: 'Kritik mimari / güvenlik görevi: Hatasız tek seferde çözüm ve derin akıl yürütme için amiral gemisi model seçildi.',
        priceScore: 'High ($$$)',
        speedScore: 'Deep Reasoning'
      };

    case 'standard':
    default:
      return {
        taskClass: 'standard',
        engine: currentEngine,
        model: currentEngine === 'codex' ? 'gpt-4o' : 'claude-3-5-sonnet-latest',
        effort: 'medium',
        reason: 'Standart iş mantığı görevi: İdeal kalite ve dengeli hız için standart model seçildi.',
        priceScore: 'Balanced ($$)',
        speedScore: 'Normal'
      };
  }
}

module.exports = {
  classifyTask,
  routeTaskWithJev,
  ROUTINE_PATTERNS,
  EXPERT_PATTERNS
};
