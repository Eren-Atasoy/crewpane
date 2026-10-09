'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Register resolver so all requires find their domain files

test('Units - Config: devChannelTarget resolves to local target with no warnings', (t) => {
  const devChannel = require('../src/config/devChannel.cjs');
  const warning = devChannel.misconfigurationWarning();
  assert.strictEqual(warning, null, 'misconfigurationWarning must be null in dev environment');

  const appDb = devChannel.devAppDbTarget();
  assert.ok(appDb, 'appDb target should be configured');
  assert.strictEqual(appDb.url, 'http://127.0.0.1:54321', 'appDb target should point to local Supabase');

  const identity = devChannel.devIdentityTarget();
  assert.ok(identity, 'identity target should be configured');
  assert.strictEqual(identity.supabaseUrl, 'http://127.0.0.1:54321', 'identity should point to local Supabase');
});

test('Units - Config: mixedTargetGuard allows unified local dev setup', (t) => {
  const mixed = require('../src/config/mixedTargetGuard.cjs');
  const result = mixed.checkMixedTargets({
    authUrl: 'http://127.0.0.1:54321',
    dbUrl: 'http://127.0.0.1:54321',
    loginUrl: 'http://127.0.0.1:54321',
    instanceId: 'dev'
  });

  assert.strictEqual(result.level, 'ok', 'Mixed target check should be ok');
  assert.strictEqual(result.reason, 'same_project', 'Both auth and db should match same local project');
});

test('Units - Agents: leaderRole evaluates all 13 fixtures accurately', (t) => {
  const { isLeaderRoleSlug, LEADER_ROLE_FIXTURES } = require('../src/agents/leaderRole.cjs');

  assert.ok(Array.isArray(LEADER_ROLE_FIXTURES), 'LEADER_ROLE_FIXTURES must be an array');
  assert.ok(LEADER_ROLE_FIXTURES.length >= 10, 'Must have at least 10 fixtures');

  for (const [name, input, expected] of LEADER_ROLE_FIXTURES) {
    const actual = isLeaderRoleSlug(input);
    assert.strictEqual(actual, expected, `Fixture failed: "${name}" -> expected ${expected}, got ${actual}`);
  }
});

test('Units - Voice: turkishMorph correctly handles Turkish lowercase and tokens', (t) => {
  const morph = require('../src/voice/turkishMorph.cjs');

  assert.strictEqual(morph.trLower('İSTANBUL'), 'istanbul', 'Turkish dotted I should lowercase to i');
  assert.strictEqual(morph.trLower('IŞIK'), 'ışık', 'Turkish dotless I should lowercase to ı');

  const tokens = morph.tokens('ajan çalıştır');
  assert.ok(Array.isArray(tokens), 'tokens should return an array');
  assert.strictEqual(tokens.length, 2, 'Should tokenize two words');
});

test('Units - Voice: sttHallucinationGuard loads hallucination lexicon', (t) => {
  const guard = require('../src/voice/sttHallucinationGuard.cjs');
  assert.ok(guard, 'sttHallucinationGuard should load');
  if (typeof guard.isHallucination === 'function') {
    assert.strictEqual(guard.isHallucination(''), true, 'Empty transcript should be treated as hallucination/empty');
  }
});

test('Units - Security: seatGate exports valid decision and product contracts', (t) => {
  const seatGate = require('../src/security/seatGate.cjs');
  assert.ok(typeof seatGate.decideAccess === 'function', 'decideAccess should be a function');
  assert.strictEqual(seatGate.SEAT_PRODUCT, 'crewpane.seat', 'SEAT_PRODUCT should match');

  // Test access decision in dev/unrequired seat environment
  const decision = seatGate.decideAccess({
    customerBuild: false,
    requireSeat: false,
    requireLogin: false
  });
  assert.strictEqual(decision.allowed, true, 'Access should be granted in dev build without seat gate');
});

test('Units - Security: integrityCheck skips unpackaged dev builds (no false positives)', (t) => {
  const integrityCheck = require('../src/security/integrityCheck.cjs');
  const gate = integrityCheck.shouldRun({
    packagedBaked: null,
    bakedBuild: 'dev',
    customerBuild: false,
    resources: null
  });

  assert.strictEqual(gate.run, false, 'Integrity check should NOT run in unpackaged dev environment');
  assert.strictEqual(gate.reason, integrityCheck.SKIP.NOT_PACKAGED);
});

test('Units - Memory: memoryChunker splits text into valid chunks', (t) => {
  const chunker = require('../src/memory/memoryChunker.cjs');
  assert.ok(chunker, 'memoryChunker should be loaded');
  if (typeof chunker.chunkText === 'function') {
    const sample = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
    const chunks = chunker.chunkText(sample, { maxChars: 50 });
    assert.ok(Array.isArray(chunks), 'Chunks should be an array');
    assert.ok(chunks.length > 0, 'Should produce at least 1 chunk');
  }
});

test('Units - Services: taskBrainService exports cleanup and summary contracts', (t) => {
  const taskBrain = require('../src/services/taskBrainService.cjs');
  assert.strictEqual(typeof taskBrain.cleanTeamDoneTasks, 'function', 'cleanTeamDoneTasks should be a function');
  assert.strictEqual(typeof taskBrain.cleanAllTasks, 'function', 'cleanAllTasks should be a function');
  assert.strictEqual(typeof taskBrain.listTasksSummary, 'function', 'listTasksSummary should be a function');
});

test('Units - Agents: jev engine is registered and valid in engineRegistry', (t) => {
  const reg = require('../src/agents/engineRegistry.cjs');
  assert.ok(reg.isRegisteredEngine('jev'), 'jev should be a registered engine');
  const jev = reg.getEngine('jev');
  assert.strictEqual(jev.id, 'jev', 'Engine id should be jev');
  const val = reg.validateDescriptor(jev);
  assert.strictEqual(val.ok, true, 'jev descriptor should validate without errors');
});

test('Units - Agents: jevRouter classifies task difficulty and routes optimal model', (t) => {
  const router = require('../src/agents/jevRouter.cjs');
  const routineRes = router.routeTaskWithJev({ title: 'Buton rengini değiştir ve padding düzelt' });
  assert.strictEqual(routineRes.taskClass, 'routine', 'Should classify CSS task as routine');
  assert.strictEqual(routineRes.effort, 'low', 'Routine task should have low effort');

  const expertRes = router.routeTaskWithJev({ title: 'Kritik mimari refactor ve güvenlik açığı giderme' });
  assert.strictEqual(expertRes.taskClass, 'expert', 'Should classify security/refactor task as expert');
  assert.strictEqual(expertRes.effort, 'high', 'Expert task should have high effort');
});

test('Units - Main: createIpcRouter registers contract-based handlers with schema validation', async (t) => {
  const { createIpcRouter } = require('../src/main/ipc/router.js');

  const registeredHandlers = new Map();
  const fakeIpcMain = {
    handle: (channel, fn) => {
      registeredHandlers.set(channel, fn);
    },
  };

  const fakeLogger = {
    warnLogs: [],
    errorLogs: [],
    warn(msg, meta) { this.warnLogs.push({ msg, meta }); },
    error(msg, meta) { this.errorLogs.push({ msg, meta }); },
  };

  const router = createIpcRouter({ ipcMain: fakeIpcMain, logger: fakeLogger });

  const testContract = {
    channels: {
      ping: 'test:ping',
      calc: 'test:calc',
    },
    schemas: {
      'test:calc': {
        safeParse: (payload) => {
          if (typeof payload?.num === 'number') {
            return { success: true, data: payload };
          }
          return { success: false, error: { issues: ['num must be number'] } };
        },
      },
    },
  };

  router(testContract, {
    ping: () => 'pong',
    calc: ({ num }) => ({ result: num * 2 }),
  });

  assert.strictEqual(registeredHandlers.has('test:ping'), true);
  assert.strictEqual(registeredHandlers.has('test:calc'), true);

  // Test ping
  const pingHandler = registeredHandlers.get('test:ping');
  const pingRes = await pingHandler({}, null);
  assert.deepStrictEqual(pingRes, { ok: true, data: 'pong' });

  // Test valid calc
  const calcHandler = registeredHandlers.get('test:calc');
  const validCalc = await calcHandler({}, { num: 21 });
  assert.deepStrictEqual(validCalc, { ok: true, data: { result: 42 } });

  // Test invalid calc
  const invalidCalc = await calcHandler({}, { num: 'not-a-number' });
  assert.deepStrictEqual(invalidCalc, { ok: false, error: 'INVALID_PAYLOAD' });
  assert.strictEqual(fakeLogger.warnLogs.length, 1);
});

test('Units - Agents: agentRunner facade and submodules preserve contract and buildSpawn', (t) => {
  const runner = require('../src/agents/agentRunner.js');
  const runnerIndex = require('../src/agents/runner/index.cjs');

  assert.strictEqual(typeof runner.buildSpawn, 'function', 'buildSpawn must be exported');
  assert.strictEqual(typeof runner.statusFor, 'function', 'statusFor must be exported');
  assert.strictEqual(typeof runner.resolveCommand, 'function', 'resolveCommand must be exported');
  assert.strictEqual(typeof runner.ALLOWED_COMMANDS, 'object', 'ALLOWED_COMMANDS must be object');
  assert.ok('claude' in runner.ALLOWED_COMMANDS, 'ALLOWED_COMMANDS should include claude');
  assert.ok('codex' in runner.ALLOWED_COMMANDS, 'ALLOWED_COMMANDS should include codex');

  // Verify export parity between facade and modular runner
  const facadeKeys = Object.keys(runner).sort();
  const indexKeys = Object.keys(runnerIndex).sort();
  assert.deepStrictEqual(facadeKeys, indexKeys, 'Facade and runner/index must have identical exports');

  // Verify buildSpawn execution
  const spawn = runner.buildSpawn({ command: 'claude', agentId: 'unit-test-agent' });
  assert.ok(spawn, 'buildSpawn should produce a spawn object');
  assert.strictEqual(spawn.isAgent, true);
  assert.strictEqual(spawn.file, 'claude');
  assert.ok(Array.isArray(spawn.argv));
  assert.strictEqual(typeof spawn.env, 'object');
  assert.strictEqual(runner.statusFor(null), 'working');
  assert.strictEqual(runner.statusFor(Date.now(), Date.now()), 'working');
  assert.strictEqual(runner.statusFor(Date.now() - 100000, Date.now()), 'idle');
});

test('Units - Voice: jarvisVoice facade and submodules preserve contract and intent parsing', (t) => {
  const voice = require('../src/voice/jarvisVoice.js');
  const voiceIndex = require('../src/voice/jarvis/index.cjs');

  assert.strictEqual(typeof voice.decide, 'function', 'decide must be exported');
  assert.strictEqual(typeof voice.parseIntent, 'function', 'parseIntent must be exported');
  assert.strictEqual(typeof voice.fastLocalDecision, 'function', 'fastLocalDecision must be exported');
  assert.strictEqual(typeof voice.normalizeDecision, 'function', 'normalizeDecision must be exported');
  assert.strictEqual(typeof voice.speakSay, 'function', 'speakSay must be exported');
  assert.strictEqual(typeof voice.transcribeSpeech, 'function', 'transcribeSpeech must be exported');

  // Verify export parity between facade and modular jarvis
  const facadeKeys = Object.keys(voice).sort();
  const indexKeys = Object.keys(voiceIndex).sort();
  assert.strictEqual(facadeKeys.length, 78, 'Expected 78 exports');
  assert.deepStrictEqual(facadeKeys, indexKeys, 'Facade and jarvis/index must have identical exports');

  // Verify functional behaviors
  const killDecision = voice.parseIntent('terminalleri kapat');
  assert.strictEqual(killDecision.action, 'terminal');
  assert.strictEqual(killDecision.op, 'kill');

  const fastKill = voice.fastLocalDecision('terminalleri kapat');
  assert.ok(fastKill, 'terminalleri kapat should resolve via fastLocalDecision');
  assert.strictEqual(fastKill.op, 'kill');

  assert.strictEqual(voice.normalizeSilenceMs(null), 900);
  assert.strictEqual(voice.normalizeSilenceMs(1200), 1200);
  assert.strictEqual(voice.normalizeDecision({ action: 'status' }).action, 'status');
});


