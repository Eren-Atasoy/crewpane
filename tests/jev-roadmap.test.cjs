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

// ── Faz 1: Görev Başına Maliyet Ölçümü (Task Outcome Ledger) ──────────────────
test('Jev Roadmap - Faz 1: taskOutcomeLedger tracks lifecycle, tokens, cost, and aggregates stats', (t) => {
  const { createTaskOutcomeLedger } = require('../src/agents/taskOutcomeLedger.cjs');

  let fakeTime = 1000000;
  let persistedState = null;
  const ledger = createTaskOutcomeLedger({
    now: () => fakeTime,
    persist: (state) => {
      persistedState = state;
    },
  });

  // 1. Görev başlangıç kaydı
  const start = ledger.recordStart({
    delegationId: 'del-001',
    subtaskId: 'sub-001',
    engine: 'claude',
    model: 'claude-haiku-5-5',
    effort: 'low',
  });
  assert.strictEqual(start.delegationId, 'del-001');
  assert.strictEqual(start.subtaskId, 'sub-001');
  assert.strictEqual(start.turns, 1);
  assert.strictEqual(start.retries, 0);
  assert.strictEqual(start.outcome, null);

  // 2. Tur ve token ilerlemesi
  ledger.recordTurn({
    delegationId: 'del-001',
    subtaskId: 'sub-001',
    tokensIn: 5000,
    tokensOut: 1000,
    cacheRead: 20000,
  });
  const afterTurn = ledger.getEntry('del-001', 'sub-001');
  assert.strictEqual(afterTurn.turns, 2);
  assert.strictEqual(afterTurn.tokensIn, 5000);
  assert.strictEqual(afterTurn.tokensOut, 1000);
  assert.strictEqual(afterTurn.cacheRead, 20000);

  // 3. Tekrar (retry) kaydı
  ledger.recordRetry('del-001', 'sub-001');
  assert.strictEqual(ledger.getEntry('del-001', 'sub-001').retries, 1);

  // 4. Görev tamamlama ve otomatik maliyet hesaplama (Haiku 5.5: $1 / 1M in, $5 / 1M out)
  fakeTime += 30000;
  const settled = ledger.settle({
    delegationId: 'del-001',
    subtaskId: 'sub-001',
    outcome: 'done', // -> 'passed'
    settledBy: 'renderer',
  });
  assert.strictEqual(settled.outcome, 'passed');
  assert.strictEqual(settled.settledAt, fakeTime);
  assert.ok(settled.costUsd > 0, 'Cost must be calculated based on tokens and Haiku pricing');

  // 5. İkinci bir görev (başarısız olan / expert / Opus 5.5)
  ledger.recordStart({
    delegationId: 'del-002',
    subtaskId: 'sub-002',
    engine: 'claude',
    model: 'claude-opus-5-5',
    effort: 'high',
  });
  ledger.recordTurn({
    delegationId: 'del-002',
    subtaskId: 'sub-002',
    tokensIn: 10000,
    tokensOut: 2000,
  });
  ledger.settle({
    delegationId: 'del-002',
    subtaskId: 'sub-002',
    outcome: 'failed',
    settledBy: 'ghost-reaper',
  });

  // 6. Bilinmeyen model (fiyat uydurulmaz -> costUsd: null)
  ledger.recordStart({
    delegationId: 'del-003',
    subtaskId: 'sub-003',
    engine: 'custom',
    model: 'unpriced-mystery-model',
  });
  ledger.recordTurn({
    delegationId: 'del-003',
    subtaskId: 'sub-003',
    tokensIn: 5000,
    tokensOut: 500,
  });
  ledger.settle({
    delegationId: 'del-003',
    subtaskId: 'sub-003',
    outcome: 'aborted',
    settledBy: 'user',
  });
  assert.strictEqual(ledger.getEntry('del-003', 'sub-003').costUsd, null);

  // 7. Özet (Summary) & İstatistikler
  const summary = ledger.summary();
  assert.strictEqual(summary.totalTasks, 3);
  assert.strictEqual(summary.passedCount, 1);
  assert.strictEqual(summary.failedCount, 1);
  assert.strictEqual(summary.abortedCount, 1);
  assert.strictEqual(summary.passRate, 0.333); // 1 / 3
  assert.ok(summary.totalCostUsd > 0);
  assert.ok(summary.byModel['claude-haiku-5-5']);
  assert.strictEqual(summary.byModel['claude-haiku-5-5'].passed, 1);
  assert.strictEqual(summary.byModel['claude-opus-5-5'].failed, 1);

  // 8. Kalıcılık (Persist) doğrulaması
  assert.ok(persistedState);
  assert.strictEqual(persistedState.records['del-001:sub-001'].outcome, 'passed');
});

test('Jev Roadmap - Faz 1: queueBoard exposes cost, turns, retries, and outcome on board rows', (t) => {
  const { buildQueueBoard } = require('../src/agents/queueBoard.cjs');
  const { createTaskOutcomeLedger } = require('../src/agents/taskOutcomeLedger.cjs');

  const ledger = createTaskOutcomeLedger();
  ledger.recordStart({
    delegationId: 'del-99',
    subtaskId: 'sub-99',
    engine: 'claude',
    model: 'claude-sonnet-5-5',
  });
  ledger.recordTurn({
    delegationId: 'del-99',
    subtaskId: 'sub-99',
    tokensIn: 4000,
    tokensOut: 800,
  });
  ledger.settle({
    delegationId: 'del-99',
    subtaskId: 'sub-99',
    outcome: 'done',
    settledBy: 'evidence',
  });

  const fakeSupervisor = {
    records: {
      'del-99:sub-99': {
        key: 'del-99:sub-99',
        delegationId: 'del-99',
        subtaskId: 'sub-99',
        agentId: 'worker-1',
        title: 'Sonnet ile test modülü yaz',
        dispatchedAt: 1000,
        settledAt: 2000,
        status: 'done',
      },
    },
  };

  const board = buildQueueBoard({
    now: 3000,
    supervisor: fakeSupervisor,
    outcomeLedger: ledger,
  });

  assert.strictEqual(board.done.length, 1);
  const row = board.done[0];
  assert.strictEqual(row.delegationId, 'del-99');
  assert.strictEqual(row.subtaskId, 'sub-99');
  assert.strictEqual(row.outcome, 'passed');
  assert.strictEqual(row.turns, 2);
  assert.strictEqual(row.retries, 0);
  assert.ok(typeof row.costUsd === 'number' && row.costUsd > 0);
});

test('Jev Roadmap - Faz 2: decide() zero-model pre-checks skip execution cleanly', (t) => {
  const { decide } = require('../src/agents/jev/decide.cjs');

  // 1. Kuyruk boş
  const res1 = decide({ queueEmpty: true });
  assert.strictEqual(res1.skip?.code, 'empty-queue');

  // 2. Boş görev tanımı
  const res2 = decide({ task: {} });
  assert.strictEqual(res2.skip?.code, 'empty-task');

  // 3. Tekrar eden görev hash'i (duplicate-task)
  const task = { title: 'Düğme rengi düzelt', description: 'Mavi yap' };
  const res3 = decide({
    task,
    lastTaskHash: 'Düğme rengi düzelt::Mavi yap::',
  });
  assert.strictEqual(res3.skip?.code, 'duplicate-task');

  // 4. Halihazırda koşan görev (already-running)
  const res4 = decide({
    task,
    activeTasks: [task],
  });
  assert.strictEqual(res4.skip?.code, 'already-running');
});

test('Jev Roadmap - Faz 2: engine discovery filters only installed and loggedIn engines', (t) => {
  const { decide } = require('../src/agents/jev/decide.cjs');

  // 1. Hiç motor yok veya hiçbiri giriş yapmamış
  const noEngRes = decide({
    task: { title: 'Dosya listesi göster' },
    engines: [
      { id: 'claude', installed: true, loggedIn: false },
      { id: 'codex', installed: false, loggedIn: false },
    ],
  });
  assert.strictEqual(noEngRes.engine, null);
  assert.strictEqual(noEngRes.reason.code, 'no-engine');

  // 2. Tek motor hazır
  const singleRes = decide({
    task: { title: 'Dosya listesi göster' },
    engines: [
      { id: 'codex', installed: true, loggedIn: true },
      { id: 'claude', installed: true, loggedIn: false },
    ],
  });
  assert.strictEqual(singleRes.engine, 'codex');
  assert.ok(singleRes.model);
});

test('Jev Roadmap - Faz 2: risk keywords cannot be downgraded by routine words or classifier', (t) => {
  const { decide } = require('../src/agents/jev/decide.cjs');

  const installedEngines = [{ id: 'claude', installed: true, loggedIn: true }];

  // 'basit ve kolay' var ama 'güvenlik' ve 'refactor' de var -> Katman A expert olmalı ve aşağı inemez!
  const riskyRes = decide({
    task: {
      title: 'Basit ve kolay güvenlik refactor düzeltmesi',
      description: 'Hızlıca authentication açığını kapat',
    },
    engines: installedEngines,
  });
  assert.strictEqual(riskyRes.tier, 'expert');
  assert.strictEqual(riskyRes.effort, 'high');
  assert.ok(riskyRes.reason.signals.includes('signal:risk-overrides-routine'));

  // Sınıflandırıcı (Katman B) yüksek güvenle bile 'routine' dese, riskli kelime aşağı çekmeyi engeller
  const spoofClassifier = () => ({ tier: 'routine', confidence: 0.99 });
  const blockedRes = decide({
    task: {
      title: 'Kritik veritabanı migration',
      description: 'Hızlıca hallet',
    },
    engines: installedEngines,
    classifier: spoofClassifier,
  });
  assert.strictEqual(blockedRes.tier, 'expert');
  assert.ok(blockedRes.reason.signals.includes('classifier:downgrade-blocked-by-risk'));
});

test('Jev Roadmap - Faz 2: classifier low confidence fallback and valid adoption', (t) => {
  const { decide } = require('../src/agents/jev/decide.cjs');
  const installedEngines = [{ id: 'claude', installed: true, loggedIn: true }];

  // 1. Düşük güven (< 0.7) -> Katman A fallback
  const lowConfClassifier = () => ({ tier: 'expert', confidence: 0.55 });
  const fallbackRes = decide({
    task: { title: 'CSS buton rengini mavi yap' }, // Katman A -> routine
    engines: installedEngines,
    classifier: lowConfClassifier,
  });
  assert.strictEqual(fallbackRes.tier, 'routine');
  assert.ok(fallbackRes.reason.signals.includes('classifier:low-confidence-fallback'));

  // 2. Yeterli güven (>= 0.7) risksiz görevde benimsenir
  const goodClassifier = () => ({ tier: 'standard', confidence: 0.88 });
  const adoptedRes = decide({
    task: { title: 'Yeni bir arayüz bileşeni ekle' },
    engines: installedEngines,
    classifier: goodClassifier,
  });
  assert.strictEqual(adoptedRes.tier, 'standard');
  assert.ok(adoptedRes.reason.signals.includes('classifier:adopted'));
});

test('Jev Roadmap - Faz 2: policy selection (frugal, quality, balanced with history)', (t) => {
  const { decide } = require('../src/agents/jev/decide.cjs');

  const multipleEngines = [
    { id: 'claude', installed: true, loggedIn: true, authKind: 'api-key' },
    { id: 'gemini', installed: true, loggedIn: true, authKind: 'subscription' },
  ];

  const standardTask = { title: 'Kullanıcı profil sayfasına avatar yükleme desteği ekle' };

  // 1. Frugal: Abonelik (ücretsiz kota / $0 ilave maliyet) veya en ucuz modeli önceler
  const frugalRes = decide({
    task: standardTask,
    engines: multipleEngines,
    policy: 'frugal',
  });
  assert.strictEqual(frugalRes.engine, 'gemini');
  assert.strictEqual(frugalRes.reason.code, 'jev.reason.frugal_cheapest');

  // 2. Quality: En yüksek kalitedeki modeli seçer
  const qualityRes = decide({
    task: { title: 'Kritik mimari refactor ve optimizasyon' },
    engines: multipleEngines,
    policy: 'quality',
  });
  assert.strictEqual(qualityRes.tier, 'expert');
  assert.strictEqual(qualityRes.reason.code, 'jev.reason.quality_best');

  // 3. Balanced: Geçmişte >= %80 başarı oranı olan modeli seçer
  const fakeHistory = {
    models: {
      'claude-sonnet-5-5': { totalRuns: 10, passedRuns: 9 }, // %90 başarı
    },
  };
  const balancedRes = decide({
    task: standardTask,
    engines: [{ id: 'claude', installed: true, loggedIn: true }],
    policy: 'balanced',
    history: fakeHistory,
  });
  assert.strictEqual(balancedRes.reason.code, 'jev.reason.balanced_historical');
  assert.ok(balancedRes.reason.signals.some((s) => s.includes('history:pass-rate-90%')));
});

test('Jev Roadmap - Faz 3: jev.mode and jev.policy settings defaults and sanitization', (t) => {
  const { defaults } = require('../src/agents/settings/constants.cjs');
  const { sanitizeJev } = require('../src/agents/settings/sanitizers.cjs');

  // 1. Varsayılanlar
  const defs = defaults();
  assert.deepStrictEqual(defs.jev, { mode: 'suggest', policy: 'balanced' });

  // 2. Geçersiz girdi sanitizasyonu
  assert.deepStrictEqual(sanitizeJev(null), { mode: 'suggest', policy: 'balanced' });
  assert.deepStrictEqual(sanitizeJev({ mode: 'invalid', policy: 'hack' }), { mode: 'suggest', policy: 'balanced' });
  assert.deepStrictEqual(sanitizeJev({ mode: 'auto', policy: 'frugal' }), { mode: 'auto', policy: 'frugal' });
  assert.deepStrictEqual(sanitizeJev({ mode: 'off', policy: 'quality' }), { mode: 'off', policy: 'quality' });
});

test('Jev Roadmap - Faz 3: jev:route-task and jev:decision-log IPC handlers work correctly', async (t) => {
  const { registerJevIpc, clearDecisionLogs } = require('../src/features/agents/jevIpc.js');

  clearDecisionLogs();
  const handlers = new Map();
  const fakeIpcMain = {
    handle: (ch, fn) => handlers.set(ch, fn),
  };

  const fakeSettings = {
    readSettings: () => ({ jev: { mode: 'suggest', policy: 'balanced' } }),
  };

  registerJevIpc({
    ipcMain: fakeIpcMain,
    agentSettings: fakeSettings,
    engineAuth: {
      readAllStatus: async () => ({
        engines: [{ id: 'claude', installed: true, loggedIn: true, authKind: 'api-key' }],
      }),
    },
    logLine: () => {},
  });

  assert.ok(handlers.has('jev:route-task'), 'Must register jev:route-task handler');
  assert.ok(handlers.has('jev:decision-log'), 'Must register jev:decision-log handler');

  // 1. Route task IPC call
  const routeFn = handlers.get('jev:route-task');
  const routeResult = await routeFn({}, {
    task: { title: 'Buton stilini güncelle' },
  });
  assert.strictEqual(routeResult.ok, true);
  assert.strictEqual(routeResult.mode, 'suggest');
  assert.strictEqual(routeResult.decision.tier, 'routine');
  assert.ok(routeResult.decision.model);

  // 2. Decision log IPC call
  const logFn = handlers.get('jev:decision-log');
  const logResult = await logFn({}, { limit: 10 });
  assert.strictEqual(logResult.ok, true);
  assert.strictEqual(logResult.logs.length, 1);
  assert.strictEqual(logResult.logs[0].task.title, 'Buton stilini güncelle');
});

test('Jev Roadmap - Faz 3: supervisor record tracks user override signal in outcome ledger', (t) => {
  const { createTaskOutcomeLedger } = require('../src/agents/taskOutcomeLedger.cjs');
  const { createDelegationSupervisor } = require('../src/agents/supervisor/supervisorCore.cjs');

  const ledger = createTaskOutcomeLedger();
  const supervisor = createDelegationSupervisor({
    outcomeLedger: ledger,
    log: () => {},
    now: () => 1000,
  });

  // Görevi kullanıcı modeli değiştirerek (overriddenBy: 'user') dispatch etti
  supervisor.record({
    delegationId: 'del-override-1',
    subtaskId: 'sub-override-1',
    engine: 'claude',
    model: 'claude-opus-5-5',
    effort: 'high',
    overriddenBy: 'user',
  });

  const entry = ledger.getEntry('del-override-1', 'sub-override-1');
  assert.ok(entry, 'Entry must be in ledger');
  assert.strictEqual(entry.model, 'claude-opus-5-5');
  assert.strictEqual(entry.overriddenBy, 'user', 'overriddenBy signal must be captured in ledger');
});


