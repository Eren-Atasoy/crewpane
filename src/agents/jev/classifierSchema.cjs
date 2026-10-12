'use strict';

/**
 * src/agents/jev/classifierSchema.cjs
 *
 * Jev AI — Tek-Geçişli Birleşik Sınıflandırma ve Güvenlik Şeması (Single-Pass Classifier Schema)
 *
 * Vercel AI Gateway veya harici LLM üzerinden yönlendirme yapılırken:
 * İki ayrı API isteği atıp çift input token ödemek yerine, zorluk derecesi (tier),
 * güvenlik/migrasyon tetikleyicisi (security_trigger) ve gerekçe tek bir
 * yapılandırılmış JSON şemasında (tek istek / tek yanıt) toplanır.
 *
 * Kural: "security_trigger" true olduğunda, LLM tier için ne önerirse önersin
 * sistem bunu otomatik olarak "expert" seviyesine kilitler (güvenlik koruması).
 */

const JEV_CLASSIFIER_JSON_SCHEMA = Object.freeze({
  name: 'jev_task_classification',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      tier: {
        type: 'string',
        enum: ['routine', 'standard', 'expert'],
        description: 'Görev zorluk sınıfı: routine (küçük/stil/yazım), standard (özellik/test/bileşen), expert (mimari/karmaşık/ağır)',
      },
      security_trigger: {
        type: 'boolean',
        description: 'Metin güvenlik, kimlik doğrulama, yetkilendirme, veri tabanı şema migrasyonu veya kritik açık içeriyor mu?',
      },
      confidence: {
        type: 'number',
        description: 'Karar güven skoru (0.0 ile 1.0 arası)',
      },
      reason: {
        type: 'string',
        description: 'Kararın kısa teknik gerekçesi',
      },
    },
    required: ['tier', 'security_trigger', 'confidence', 'reason'],
    additionalProperties: false,
  },
});

const JEV_CLASSIFIER_SYSTEM_PROMPT = `You are Jev AI Orchestrator Router for Crewpane.
Analyze the given coding task and classify it accurately in a single structured JSON response.

Evaluation Criteria:
1. "security_trigger": Set to true if the task mentions security, vulnerability, exploit, authentication (auth), authorization, cryptography, database migration, or breaking schema changes.
2. "tier":
   - "routine": Minor CSS/styling tweaks, button styles, typo fixes, documentation updates, translations, small logging.
   - "standard": Routine feature development, bug fixes, UI components, normal integration tests.
   - "expert": Architectural refactoring, concurrency/race conditions, complex algorithms, system design, or any security_trigger=true task.
3. "confidence": Value between 0.0 and 1.0 reflecting classification certainty.
4. "reason": Brief 1-sentence technical justification.`;

/**
 * Tek bir görev nesnesinden Vercel AI Gateway / OpenAI uyumlu mesaj gövdesi üretir.
 */
function buildSinglePassPayload(task = {}) {
  const title = String(task.title || '').trim();
  const desc = String(task.description || '').trim();
  const files = Array.isArray(task.filesTouched) ? task.filesTouched.join(', ') : 'none';

  const userContent = `Task Title: ${title || 'Untitled'}
Task Description: ${desc || 'None'}
Files Touched: ${files}`;

  return {
    messages: [
      { role: 'system', content: JEV_CLASSIFIER_SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: JEV_CLASSIFIER_JSON_SCHEMA,
    },
    temperature: 0.1,
    max_tokens: 150,
  };
}

/**
 * Model çıktısını güvenli şekilde doğrular ve dönüştürür.
 * Eğer security_trigger true ise, tier otomatik olarak "expert" seviyesine yükseltilir.
 */
function parseClassifierResult(raw) {
  if (!raw) return null;

  let parsed = null;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch (_err) {
      return null;
    }
  } else if (typeof raw === 'object') {
    parsed = raw;
  }

  if (!parsed) return null;

  const securityTrigger = Boolean(parsed.security_trigger);
  let tier = String(parsed.tier || 'standard').toLowerCase();
  if (!['routine', 'standard', 'expert'].includes(tier)) {
    tier = 'standard';
  }

  // Güvenlik kuralı: security_trigger true ise tier zorunlu 'expert'
  if (securityTrigger && tier !== 'expert') {
    tier = 'expert';
  }

  const confidence = typeof parsed.confidence === 'number'
    ? Math.max(0, Math.min(1, parsed.confidence))
    : 0.85;

  return {
    tier,
    securityTrigger,
    confidence,
    reason: String(parsed.reason || ''),
  };
}

module.exports = {
  JEV_CLASSIFIER_JSON_SCHEMA,
  JEV_CLASSIFIER_SYSTEM_PROMPT,
  buildSinglePassPayload,
  parseClassifierResult,
};
