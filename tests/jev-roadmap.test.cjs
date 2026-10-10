'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// ── Faz 0: Model Kataloğu & Fiyatlandırma Doğrulaması ────────────────────────
test('Jev Roadmap - Faz 0: tokenCost prices updated Claude 5.5/5.1 models and aliases', (t) => {
  const tokenCost = require('../src/services/tokenCost.cjs');

  // 1. Yeni 5.5 / 5.1 modelleri fiyat tablosunda mevcut ve doğru
  const opusPrice = tokenCost.priceFor('claude-opus-5-5');
  assert.ok(opusPrice, 'claude-opus-5-5 must be priced');
  assert.strictEqual(opusPrice.input, 5);
  assert.strictEqual(opusPrice.output, 25);

  const sonnetPrice = tokenCost.priceFor('claude-sonnet-5-5');
  assert.ok(sonnetPrice, 'claude-sonnet-5-5 must be priced');
  assert.strictEqual(sonnetPrice.input, 3);
  assert.strictEqual(sonnetPrice.output, 15);

  const haikuPrice = tokenCost.priceFor('claude-haiku-5-5');
  assert.ok(haikuPrice, 'claude-haiku-5-5 must be priced');
  assert.strictEqual(haikuPrice.input, 1);
  assert.strictEqual(haikuPrice.output, 5);

  const fablePrice = tokenCost.priceFor('claude-fable-5-1');
  assert.ok(fablePrice, 'claude-fable-5-1 must be priced');
  assert.strictEqual(fablePrice.input, 10);
  assert.strictEqual(fablePrice.output, 50);

  // 2. Alias'lar en yeni modellere çözülür
  assert.strictEqual(tokenCost.normalizeModelId('opus'), 'claude-opus-5-5');
  assert.strictEqual(tokenCost.normalizeModelId('sonnet'), 'claude-sonnet-5-5');
  assert.strictEqual(tokenCost.normalizeModelId('haiku'), 'claude-haiku-5-5');
  assert.strictEqual(tokenCost.normalizeModelId('fable'), 'claude-fable-5-1');

  // 3. Fiyatlanamayan model null döner ve priced: false olur (0 uydurulmaz)
  assert.strictEqual(tokenCost.priceFor('unpriced-model-xyz'), null);
  const unpricedCost = tokenCost.costForModel({
    model: 'unpriced-model-xyz',
    usage: { inputTokens: 1000, outputTokens: 500 },
  });
  assert.strictEqual(unpricedCost.usd, null);
  assert.strictEqual(unpricedCost.priced, false);
});

test('Jev Roadmap - Faz 0: jevRouter resolves models dynamically without hardcoding', (t) => {
  const router = require('../src/agents/jevRouter.cjs');

  // Model isimleri koda gömülü değil; modelPricing / alias üzerinden çözülür
  const routine = router.routeTaskWithJev({ title: 'CSS buton rengi ve padding düzelt' });
  assert.strictEqual(routine.taskClass, 'routine');
  assert.strictEqual(routine.effort, 'low');
  assert.strictEqual(routine.model, 'claude-haiku-5-5');
  assert.strictEqual(routine.reason.code, 'jev.reason.routine_lightweight');

  const expert = router.routeTaskWithJev({ title: 'Kritik mimari refactor ve güvenlik açığı' });
  assert.strictEqual(expert.taskClass, 'expert');
  assert.strictEqual(expert.effort, 'high');
  assert.strictEqual(expert.model, 'claude-opus-5-5');
  assert.strictEqual(expert.reason.code, 'jev.reason.expert_deep_reasoning');

  const standard = router.routeTaskWithJev({ title: 'Kullanıcı profil sayfasına filtre ekle' });
  assert.strictEqual(standard.taskClass, 'standard');
  assert.strictEqual(standard.effort, 'medium');
  assert.strictEqual(standard.model, 'claude-sonnet-5-5');
  assert.strictEqual(standard.reason.code, 'jev.reason.standard_balanced');
});
