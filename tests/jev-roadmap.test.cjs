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
  assert.deepStrictEqual(defs.jev, { mode: 'suggest', policy: 'balanced', maxCostPerTaskUsd: null });

  // 2. Geçersiz girdi sanitizasyonu
  assert.deepStrictEqual(sanitizeJev(null), { mode: 'suggest', policy: 'balanced', maxCostPerTaskUsd: null });
  assert.deepStrictEqual(sanitizeJev({ mode: 'invalid', policy: 'hack' }), { mode: 'suggest', policy: 'balanced', maxCostPerTaskUsd: null });
  assert.deepStrictEqual(sanitizeJev({ mode: 'auto', policy: 'frugal' }), { mode: 'auto', policy: 'frugal', maxCostPerTaskUsd: null });
  assert.deepStrictEqual(sanitizeJev({ mode: 'off', policy: 'quality' }), { mode: 'off', policy: 'quality', maxCostPerTaskUsd: null });
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

test('Jev Roadmap - Faz 4: goalGate evaluateRound and checkStopConditions work accurately', async (t) => {
  const { createGoalGate, checkStopConditions, isEligibleChecker } = require('../src/agents/goalGate.cjs');

  // 1. Checker kuralı: Kendi işini onaylayamaz
  assert.strictEqual(isEligibleChecker('worker-1', 'worker-1'), false);
  assert.strictEqual(isEligibleChecker('worker-1', 'reviewer-2'), true);

  // 2. Durma koşulu: maxRounds dolunca abort
  const maxStop = checkStopConditions({
    goal: { maxRounds: 3 },
    rounds: [{ round: 1 }, { round: 2 }, { round: 3 }],
  });
  assert.strictEqual(maxStop.abort, true);
  assert.strictEqual(maxStop.reason, 'goal.abort.max_rounds_reached');

  // 3. Durma koşulu: abortIfNoProgress (ilerleme durursa)
  const stallStop = checkStopConditions({
    goal: { checks: ['npm test', 'npm run lint'], abortIfNoProgress: 2 },
    rounds: [
      { round: 1, passedCount: 1 },
      { round: 2, passedCount: 1 },
    ],
  });
  assert.strictEqual(stallStop.abort, true);
  assert.strictEqual(stallStop.reason, 'goal.abort.no_progress');

  // 4. Komut koşturma ve LLM-okunur özet
  let runCount = 0;
  const gate = createGoalGate({
    runCommand: async ({ command }) => {
      runCount++;
      if (command === 'npm test') return { code: 0, stdout: 'tests passed', stderr: '' };
      return { code: 1, stdout: '', stderr: 'AssertionError: expected true to be false on test.js:42:10' };
    },
  });

  const res = await gate.evaluateRound({
    goal: { checks: ['npm test', 'npm run lint'] },
    rounds: [],
  });
  assert.strictEqual(res.passed, false);
  assert.strictEqual(res.passedCount, 1);
  assert.strictEqual(res.totalChecks, 2);
  assert.strictEqual(res.failedCheck, 'npm run lint');
  assert.ok(res.feedback.includes('AssertionError'));
  assert.strictEqual(runCount, 2, 'Should execute checks sequentially until failure');
});

test('Jev Roadmap - Faz 4: supervisor checkGoal runs broken test -> fix round -> pass flow', async (t) => {
  const { createDelegationSupervisor } = require('../src/agents/supervisor/supervisorCore.cjs');
  const { createTaskOutcomeLedger } = require('../src/agents/taskOutcomeLedger.cjs');
  const { buildQueueBoard } = require('../src/agents/queueBoard.cjs');

  const ledger = createTaskOutcomeLedger();
  const supervisor = createDelegationSupervisor({
    outcomeLedger: ledger,
    log: () => {},
    now: () => 1000,
  });

  // Görev goal ile kaydedildi
  supervisor.record({
    delegationId: 'del-goal-1',
    subtaskId: 'sub-goal-1',
    title: 'Yeni modül yaz ve testleri geçir',
    engine: 'claude',
    model: 'claude-sonnet-5-5',
    goal: {
      checks: ['npm test'],
      maxRounds: 3,
      abortIfNoProgress: 2,
    },
  });

  // 1. Tur: Test bilerek kırık (kod=1)
  let testFails = true;
  const round1 = await supervisor.checkGoal('del-goal-1', 'sub-goal-1', {
    runCommand: async () => {
      if (testFails) return { code: 1, stdout: 'fail: 1 error on auth.test.js:12' };
      return { code: 0, stdout: 'all pass' };
    },
  });
  assert.strictEqual(round1.ok, false);
  assert.strictEqual(round1.evaluation.passed, false);
  assert.strictEqual(ledger.getEntry('del-goal-1', 'sub-goal-1').turns, 2, 'Turn must increment on failed check');

  // QueueBoard goal ilerlemesini göstermeli
  const boardDuring = buildQueueBoard({
    supervisor: { records: { 'del-goal-1:sub-goal-1': supervisor.snapshot().records['del-goal-1:sub-goal-1'] } },
    outcomeLedger: ledger,
  });
  assert.strictEqual(boardDuring.inflight[0].goal.defined, true);
  assert.strictEqual(boardDuring.inflight[0].goal.round, 1);
  assert.strictEqual(boardDuring.inflight[0].turns, 2);

  // 2. Tur: Düzeltme yapıldı, testler geçti (kod=0)
  testFails = false;
  const round2 = await supervisor.checkGoal('del-goal-1', 'sub-goal-1', {
    runCommand: async () => ({ code: 0, stdout: 'all 5 tests passed' }),
  });
  assert.strictEqual(round2.ok, true);
  assert.strictEqual(round2.evaluation.passed, true);

  // Settle et
  const settled = supervisor.settle('del-goal-1', 'sub-goal-1', { status: 'done' });
  assert.strictEqual(settled, true);
});

test('Jev Roadmap - Faz 5: decide() escalates tier on failed rounds or aborted status', (t) => {
  const { decide } = require('../src/agents/jev/decide.cjs');
  const installedEngines = [{ id: 'claude', installed: true, loggedIn: true }];

  // 1. Normalde routine olan görev, 2 tur başarısızlıktan sonra standard'a yükseltilir
  const res1 = decide({
    task: { title: 'Buton rengini mavi yap' }, // normalde routine
    engines: installedEngines,
    goalFailure: {
      failedRounds: 2,
    },
  });
  assert.strictEqual(res1.tier, 'standard');
  assert.strictEqual(res1.reason.code, 'escalated-after-failed-checks');
  assert.ok(res1.reason.signals.includes('signal:escalated-after-failed-checks'));

  // 2. Aborted olan görev, bir üst seviyeye yükseltilir
  const res2 = decide({
    task: { title: 'Basit profil sayfası css düzeltmesi' }, // routine
    engines: installedEngines,
    goalFailure: {
      aborted: true,
      lastTier: 'standard',
    },
  });
  assert.strictEqual(res2.tier, 'expert');
  assert.strictEqual(res2.reason.code, 'escalated-after-failed-checks');
});

test('Jev Roadmap - Faz 5: budget cap limits escalation and asks user when exceeded', (t) => {
  const { decide } = require('../src/agents/jev/decide.cjs');
  const installedEngines = [{ id: 'claude', installed: true, loggedIn: true }];

  // Görev çok ucuz bütçeyle sınırlandırılmış ($0.001)
  // Expert tier bir model (Opus vb.) bu bütçeyi kesinlikle aşar
  const res = decide({
    task: { title: 'Basit css düzelt' },
    engines: installedEngines,
    goalFailure: {
      failedRounds: 2,
      lastTier: 'standard', // escalates to expert
    },
    maxCostPerTaskUsd: 0.001,
  });

  assert.strictEqual(res.budgetExceeded, true);
  assert.strictEqual(res.reason.code, 'budget-cap-exceeded');
  assert.ok(res.reason.signals.includes('budget:cap-exceeded'));
});

test('Jev Roadmap - Faz 5: generateWeeklyReport accurately calculates cost vs estimated default', (t) => {
  const { createTaskOutcomeLedger } = require('../src/agents/taskOutcomeLedger.cjs');
  const { generateWeeklyReport } = require('../src/agents/jev/report.cjs');

  const ledger = createTaskOutcomeLedger();
  const dayMs = 24 * 60 * 60 * 1000;
  const baseTime = 1700000000000;

  // 1. Görev: Haiku (ucuz) kullanılmış, 10,000 giriş, 2,000 çıkış
  ledger.recordStart({
    delegationId: 'd1',
    subtaskId: 's1',
    engine: 'claude',
    model: 'claude-haiku-5-5',
    startedAt: baseTime - 15 * dayMs, // 15 gün önce
  });
  ledger.recordTurn({
    delegationId: 'd1',
    subtaskId: 's1',
    tokensIn: 10000,
    tokensOut: 2000,
  });
  ledger.settle({
    delegationId: 'd1',
    subtaskId: 's1',
    outcome: 'done',
    settledAt: baseTime - 15 * dayMs,
  });

  // 2. Görev: Sonnet (orta) kullanılmış
  ledger.recordStart({
    delegationId: 'd2',
    subtaskId: 's2',
    engine: 'claude',
    model: 'claude-sonnet-5-5',
    startedAt: baseTime - 2 * dayMs, // 2 gün önce
  });
  ledger.recordTurn({
    delegationId: 'd2',
    subtaskId: 's2',
    tokensIn: 8000,
    tokensOut: 1000,
  });
  ledger.settle({
    delegationId: 'd2',
    subtaskId: 's2',
    outcome: 'done',
    settledAt: baseTime - 2 * dayMs,
  });

  // Rapor üret (Varsayılan model: claude-sonnet-5-5)
  const report = generateWeeklyReport({
    outcomeLedger: ledger,
    defaultModel: 'claude-sonnet-5-5',
    days: 30,
    now: () => baseTime,
  });

  assert.strictEqual(report.isEstimate, true);
  assert.strictEqual(report.totalTasks, 2);
  assert.strictEqual(report.passedTasks, 2);
  assert.ok(report.totalActualCostUsd > 0);
  assert.ok(report.totalEstimatedDefaultCostUsd > 0);
  // Haiku Sonnet'ten çok daha ucuz olduğu için gerçek maliyet varsayılan model maliyetinden düşük olmalı (tasarruf > 0)
  assert.ok(report.savingsUsd > 0, 'Jev using Haiku on task 1 should yield savings vs Sonnet');
  assert.ok(report.savingsPct > 0);
  // 15 gün öncesine dayanan veri var ve tasarruf pozitif -> canRecommendAuto = true
  assert.strictEqual(report.canRecommendAuto, true);

  // Şimdi sadece 5 günlük geçmişe sahip bir rapor deneyelim -> canRecommendAuto = false (< 14 gün)
  const freshLedger = createTaskOutcomeLedger();
  freshLedger.recordStart({
    delegationId: 'd3',
    subtaskId: 's3',
    engine: 'claude',
    model: 'claude-haiku-5-5',
    startedAt: baseTime - 5 * dayMs,
  });
  freshLedger.recordTurn({
    delegationId: 'd3',
    subtaskId: 's3',
    tokensIn: 5000,
    tokensOut: 500,
  });
  freshLedger.settle({
    delegationId: 'd3',
    subtaskId: 's3',
    outcome: 'done',
    settledAt: baseTime - 5 * dayMs,
  });

  const freshReport = generateWeeklyReport({
    outcomeLedger: freshLedger,
    defaultModel: 'claude-sonnet-5-5',
    days: 30,
    now: () => baseTime,
  });
  assert.strictEqual(freshReport.canRecommendAuto, false, 'Cannot recommend auto mode when history < 14 days');
});

test('Jev Roadmap - Faz 6a: scanDiffForSecrets detects secret, masks value, returns warning with line number', (t) => {
  const { scanDiffForSecrets } = require('../src/services/mergeService.cjs');

  const diffWithSecret = `
diff --git a/src/config.js b/src/config.js
--- a/src/config.js
+++ b/src/config.js
@@ -10,4 +10,5 @@
 const port = 3000;
 const host = 'localhost';
+const apiKey = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789-AA';
 const env = 'production';
`.trim();

  const scan = scanDiffForSecrets(diffWithSecret);
  assert.strictEqual(scan.ok, false);
  assert.ok(scan.findings.length >= 1);
  assert.strictEqual(scan.warning.code, 'secret-in-diff');
  assert.strictEqual(scan.findings[0].file, 'src/config.js');
  assert.strictEqual(scan.findings[0].line, 12);
  assert.strictEqual(scan.findings[0].location, 'src/config.js:12');
  // Değer maskelenmiş olmalı, orijinal anahtar sızmamalı
  assert.ok(!scan.findings[0].snippet.includes('abcdefghijklmnopqrstuvwxyz'));
  assert.ok(scan.findings[0].snippet.includes('[gizlendi]') || scan.findings[0].snippet.includes('••••'));

  // Temiz diff
  const cleanDiff = `
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1,3 +1,4 @@
 # Proje
+Yeni açıklama eklendi.
`.trim();

  const cleanScan = scanDiffForSecrets(cleanDiff);
  assert.strictEqual(cleanScan.ok, true);
  assert.strictEqual(cleanScan.warning, null);
  assert.strictEqual(cleanScan.findings.length, 0);
});

test('Jev Roadmap - Faz 6b: memory validity with supersededBy and validUntil fields', async (t) => {
  const { composeFact } = require('../src/memory/agentMemory.cjs');
  const { parseFact } = require('../src/memory/memoryGraph.cjs');
  const { recall, isMemoryRecordValid } = require('../src/memory/memoryRecall.cjs');

  // 1. composeFact & parseFact
  const fact = composeFact({
    name: 'api-migration-guide',
    description: 'V1 to V2 migration steps',
    body: 'Use the new endpoints.',
    supersededBy: 'api-v3-migration',
    validUntil: 1700000000000,
  });
  assert.ok(fact.content.includes('supersededBy: api-v3-migration'));
  assert.ok(fact.content.includes('validUntil: 1700000000000'));

  const parsed = parseFact(fact.content);
  assert.strictEqual(parsed.supersededBy, 'api-v3-migration');
  assert.strictEqual(parsed.validUntil, 1700000000000);

  // 2. isMemoryRecordValid checks
  const nowTime = 1750000000000;
  assert.strictEqual(isMemoryRecordValid({ supersededBy: 'other-fact' }, { now: () => nowTime }), false);
  assert.strictEqual(isMemoryRecordValid({ validUntil: 1700000000000 }, { now: () => nowTime }), false);
  assert.strictEqual(isMemoryRecordValid({ validUntil: 1800000000000 }, { now: () => nowTime }), true);
  assert.strictEqual(isMemoryRecordValid({ supersededBy: 'other' }, { includeInvalid: true }), true);

  // 3. recall() filters expired/superseded records by default
  const fakeSearch = async () => ({
    ok: true,
    results: [
      { name: 'valid-record', text: 'Clean fact', score: 0.9 },
      { name: 'superseded-record', text: 'Old fact', supersededBy: 'new-record', score: 0.85 },
      { name: 'expired-record', text: 'Expired fact', validUntil: 1600000000000, score: 0.8 },
    ],
  });

  const defaultRecall = await recall({
    workspaceRoot: 'd:/mock',
    query: 'fact',
    search: fakeSearch,
    now: () => nowTime,
  });
  assert.strictEqual(defaultRecall.results.length, 1);
  assert.strictEqual(defaultRecall.results[0].name, 'valid-record');

  // includeInvalid: true tüm kayıtları döner
  const allRecall = await recall({
    workspaceRoot: 'd:/mock',
    query: 'fact',
    search: fakeSearch,
    now: () => nowTime,
    includeInvalid: true,
  });
  assert.strictEqual(allRecall.results.length, 3);
});

test('Jev Roadmap - Faz 6c: motion-studio builtin skill catalog integrity and rules', (t) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const crypto = require('node:crypto');

  const catalogPath = path.join(__dirname, '..', 'builtin-skills', 'catalog.json');
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

  const entry = catalog.skills.find((s) => s.name === 'motion-studio');
  assert.ok(entry, 'motion-studio must exist in builtin-skills/catalog.json');
  assert.strictEqual(entry.license, 'MIT');

  const skillPath = path.join(__dirname, '..', 'builtin-skills', 'motion-studio', 'SKILL.md');
  assert.ok(fs.existsSync(skillPath), 'SKILL.md must exist in builtin-skills/motion-studio');

  const content = fs.readFileSync(skillPath);
  const calculatedSha = crypto.createHash('sha256').update(content).digest('hex');

  assert.strictEqual(entry.sizeBytes, content.length, 'Catalog sizeBytes must match physical file size');
  assert.strictEqual(entry.sha256, calculatedSha, 'Catalog sha256 must match physical file hash');

  const text = content.toString('utf8');
  assert.ok(text.includes('ffmpeg'));
  assert.ok(text.includes('H.264'));
  assert.ok(text.includes('Seam Check') || text.includes('seam check'));
  assert.ok(text.includes('Smoke Test') || text.includes('smoke test'));
});





