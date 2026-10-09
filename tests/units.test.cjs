'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

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
  const seatMod = require('../src/security/seat/index.cjs');

  assert.ok(typeof seatGate.createSeatGate === 'function', 'createSeatGate should be a function');
  assert.ok(typeof seatGate.decideAccess === 'function', 'decideAccess should be a function');
  assert.ok(typeof seatGate.readPastDue === 'function', 'readPastDue should be a function');
  assert.ok(typeof seatGate.readCancelEnding === 'function', 'readCancelEnding should be a function');
  assert.strictEqual(seatGate.SEAT_PRODUCT, 'crewpane.seat', 'SEAT_PRODUCT should match');

  // Modular export parity (5/5 exports)
  assert.deepStrictEqual(Object.keys(seatGate).sort(), Object.keys(seatMod).sort(), 'seatGate and seat/index must have identical exports');

  // Test access decision in dev/unrequired seat environment
  const decision = seatGate.decideAccess({
    customerBuild: false,
    requireSeat: false,
    requireLogin: false
  });
  assert.strictEqual(decision.allowed, true, 'Access should be granted in dev build without seat gate');

  // Test denial when requireSeat=true and not signed in
  const denied = seatGate.decideAccess({
    requireSeat: true,
    signedIn: false
  });
  assert.strictEqual(denied.allowed, false);
  assert.strictEqual(denied.reason, 'not_signed_in');
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

test('Units - Agents: delegationSupervisor facade and submodules preserve contract and state operations', (t) => {
  const supervisor = require('../src/agents/delegationSupervisor.cjs');
  const supervisorIndex = require('../src/agents/supervisor/index.cjs');

  assert.strictEqual(typeof supervisor.createDelegationSupervisor, 'function');
  assert.strictEqual(typeof supervisor.recordKey, 'function');
  assert.strictEqual(typeof supervisor.normalizeState, 'function');
  assert.strictEqual(typeof supervisor.deliveryVerdict, 'function');
  assert.strictEqual(typeof supervisor.wakeDue, 'function');
  assert.strictEqual(typeof supervisor.wakeTextFor, 'function');
  assert.strictEqual(supervisor.STORE_VERSION, 1);
  assert.strictEqual(typeof supervisor.DEFAULTS, 'object');
  assert.strictEqual(typeof supervisor.SETTLE_SOURCES, 'object');

  // Verify export parity between facade and modular supervisor
  const facadeKeys = Object.keys(supervisor).sort();
  const indexKeys = Object.keys(supervisorIndex).sort();
  assert.strictEqual(facadeKeys.length, 9, 'Expected 9 exports');
  assert.deepStrictEqual(facadeKeys, indexKeys, 'Facade and supervisor/index must have identical exports');

  // Verify pure helper behaviors
  assert.strictEqual(supervisor.recordKey('dlg-1', 'sub-2'), 'dlg-1:sub-2');

  const norm = supervisor.normalizeState({
    records: {
      'd1:s1': { delegationId: 'd1', subtaskId: 's1' },
      invalid: { something: true },
    },
  });
  assert.strictEqual(norm.version, 1);
  assert.ok('d1:s1' in norm.records);
  assert.ok(!('invalid' in norm.records));

  assert.strictEqual(supervisor.deliveryVerdict({ transcript: true }), true);
  assert.strictEqual(supervisor.deliveryVerdict({ transcript: false }), false);
  assert.strictEqual(supervisor.deliveryVerdict({ transcript: null, buffer: 'match sig', signature: 'sig' }), true);
  assert.strictEqual(supervisor.deliveryVerdict({ transcript: null }), null);

  const instance = supervisor.createDelegationSupervisor();
  assert.strictEqual(typeof instance.record, 'function');
  assert.strictEqual(typeof instance.settle, 'function');
  assert.strictEqual(typeof instance.ack, 'function');
  assert.strictEqual(typeof instance.sweep, 'function');
  assert.strictEqual(typeof instance.leaderStatus, 'function');
  assert.strictEqual(typeof instance.start, 'function');
  assert.strictEqual(typeof instance.stop, 'function');
});

test('Units - Agents: delegationBridge facade and submodules preserve contract and validators', (t) => {
  const bridge = require('../src/agents/delegationBridge.js');
  const bridgeIndex = require('../src/agents/bridge/index.cjs');

  assert.strictEqual(typeof bridge.startDelegationBridge, 'function');
  assert.strictEqual(typeof bridge.mintToken, 'function');
  assert.strictEqual(typeof bridge.checkToken, 'function');
  assert.strictEqual(typeof bridge.validateDelegatePayload, 'function');
  assert.strictEqual(typeof bridge.validateReportPayload, 'function');
  assert.strictEqual(typeof bridge.validateSprintPayload, 'function');
  assert.strictEqual(typeof bridge.validateComposePayload, 'function');
  assert.strictEqual(typeof bridge.stripAnsi, 'function');
  assert.strictEqual(typeof bridge.cleanPaneTail, 'function');
  assert.strictEqual(typeof bridge.paneHasApiError, 'function');
  assert.strictEqual(typeof bridge.enrichDelegationSnapshot, 'function');

  // Verify export parity between facade and modular bridge
  const facadeKeys = Object.keys(bridge).sort();
  const indexKeys = Object.keys(bridgeIndex).sort();
  assert.strictEqual(facadeKeys.length, 28, 'Expected 28 exports');
  assert.deepStrictEqual(facadeKeys, indexKeys, 'Facade and bridge/index must have identical exports');

  // Verify token operations
  const token = bridge.mintToken();
  assert.strictEqual(typeof token, 'string');
  assert.strictEqual(token.length, 64);
  assert.strictEqual(bridge.checkToken(token, token), true);
  assert.strictEqual(bridge.checkToken('Bearer ' + token, token), true);
  assert.strictEqual(bridge.checkToken('invalid', token), false);

  // Verify payload validators
  const validDelegate = bridge.validateDelegatePayload({
    objective: 'Test objective',
    leaderId: 'leader-1',
    department: 'frontend',
  });
  assert.strictEqual(validDelegate.ok, true);
  assert.strictEqual(validDelegate.value.objective, 'Test objective');

  const invalidDelegate = bridge.validateDelegatePayload({
    objective: '',
    leaderId: 'leader-1',
    department: 'frontend',
  });
  assert.strictEqual(invalidDelegate.ok, false);

  // Verify ANSI stripping & API error detection
  assert.strictEqual(bridge.stripAnsi('\u001b[32mSuccess\u001b[0m'), 'Success');
  assert.strictEqual(bridge.cleanPaneTail('Line 1\n\n\u001b[31mLine 2\u001b[0m\n'), 'Line 1\nLine 2');
  assert.strictEqual(bridge.paneHasApiError('Overloaded error 529 encountered'), true);
  assert.strictEqual(bridge.paneHasApiError('Everything completed normally'), false);
});

test('Units - Terminal: resumeDaemonCore facade and submodules preserve contract and state machine', (t) => {
  const daemon = require('../src/terminal/resumeDaemonCore.cjs');
  const daemonIndex = require('../src/terminal/resume/index.cjs');
  const { formatClock, formatWhen, assistantText } = require('../src/terminal/resume/transcriptVerify.cjs');

  assert.strictEqual(typeof daemon.ResumeDaemonCore, 'function');
  assert.strictEqual(daemon.DEFAULT_VERIFY_WINDOW_MS, 180_000);
  assert.strictEqual(daemon.VERIFY_MAX_ATTEMPTS, 6);
  assert.strictEqual(daemon.DEFER_PROBE_MS, 300_000);
  assert.strictEqual(daemon.UNKNOWN_MAX_DEFER_MS, 3_600_000);
  assert.strictEqual(daemon.MAX_TOTAL_DEFER_MS, 21_600_000);
  assert.strictEqual(daemon.STALE_CLOCK_GRACE_MS, 21_600_000);
  assert.strictEqual(daemon.WATCHDOG_MIN_GAP_MS, 300_000);
  assert.strictEqual(daemon.PROBE_SETTLE_MS, 1_500);
  assert.strictEqual(daemon.PROBE_RETRY_MS, 60_000);
  assert.strictEqual(daemon.PROBE_MAX_UNKNOWN, 3);
  assert.strictEqual(daemon.SENTINEL_GRACE_MS, 600_000);
  assert.strictEqual(daemon.SENTINEL_QUIET_MS, 600_000);
  assert.strictEqual(daemon.SENTINEL_MAX_NUDGES, 2);
  assert.strictEqual(typeof daemon.transcriptInterruptedAfter, 'function');
  assert.strictEqual(typeof daemon.hasAssistantLineAfter, 'function');
  assert.strictEqual(typeof daemon.assistantLinesAfter, 'function');
  assert.strictEqual(typeof daemon.paneSignature, 'function');

  // Verify export parity between facade and modular resume
  const facadeKeys = Object.keys(daemon).sort();
  const indexKeys = Object.keys(daemonIndex).sort();
  assert.strictEqual(facadeKeys.length, 19, 'Expected 19 exports');
  assert.deepStrictEqual(facadeKeys, indexKeys, 'Facade and resume/index must have identical exports');

  // Verify pure helper functions
  const sig1 = daemon.paneSignature('test buffer content');
  const sig2 = daemon.paneSignature('test buffer content');
  const sig3 = daemon.paneSignature('different buffer content');
  assert.strictEqual(typeof sig1, 'string');
  assert.strictEqual(sig1, sig2);
  assert.notStrictEqual(sig1, sig3);
  assert.ok(sig1.startsWith('19:'));

  const fixedTime = Date.parse('2026-10-09T14:30:00.000Z');
  const clock = formatClock(fixedTime);
  assert.strictEqual(typeof clock, 'string');
  assert.ok(clock.includes(':'));

  const whenSameDay = formatWhen(fixedTime, fixedTime + 1000);
  assert.strictEqual(whenSameDay, clock);
  const whenOtherDay = formatWhen(fixedTime + 3 * 86_400_000, fixedTime);
  assert.ok(whenOtherDay.includes('.'), 'Date formatted when > 24h away');

  const textFromObj = assistantText({
    message: {
      content: [
        { type: 'text', text: 'Hello assistant' },
        { type: 'tool_use', id: 'call_1' },
      ],
    },
  });
  assert.strictEqual(textFromObj, 'Hello assistant\n');

  // Verify ResumeDaemonCore class instantiation and methods
  const core = new daemon.ResumeDaemonCore({
    dryRun: true,
  });
  assert.ok(core);
  assert.strictEqual(core.dryRun, true);
  assert.strictEqual(typeof core.observe, 'function');
  assert.strictEqual(typeof core.fire, 'function');
  assert.strictEqual(typeof core.verify, 'function');
  assert.strictEqual(typeof core.rescheduleOnBoot, 'function');
  assert.strictEqual(typeof core.stop, 'function');

  // Clean observe on empty buffer returns null
  const cleanObserve = core.observe('', { paneRef: '%1' });
  assert.strictEqual(cleanObserve, null);

  core.stop();
});

test('Units - Agents: agentSettings facade and submodules preserve contract and sanitizers', (t) => {
  const settings = require('../src/agents/agentSettings.cjs');
  const settingsIndex = require('../src/agents/settings/index.cjs');

  assert.strictEqual(typeof settings.settingsPath, 'function');
  assert.strictEqual(typeof settings.defaults, 'function');
  assert.strictEqual(typeof settings.readSettings, 'function');
  assert.strictEqual(typeof settings.writeSettings, 'function');
  assert.strictEqual(typeof settings.applySettingsPatch, 'function');
  assert.strictEqual(typeof settings.sanitizeTheme, 'function');
  assert.strictEqual(typeof settings.sanitizeLocale, 'function');
  assert.strictEqual(typeof settings.sanitizeVoiceLocale, 'function');
  assert.strictEqual(typeof settings.sanitizeBrowserTrust, 'function');
  assert.strictEqual(typeof settings.sanitizeTelemetryState, 'function');
  assert.strictEqual(typeof settings.sanitizeResourceGovernor, 'function');
  assert.strictEqual(typeof settings.sanitizeMemorySearch, 'function');
  assert.strictEqual(typeof settings.sanitizeEngines, 'function');
  assert.strictEqual(typeof settings.sanitizeTeamCompose, 'function');
  assert.strictEqual(typeof settings.ensureTeamScopeMandate, 'function');
  assert.strictEqual(typeof settings.teamScopePolicy, 'function');
  assert.strictEqual(typeof settings.grantTeamScope, 'function');
  assert.strictEqual(typeof settings.revokeTeamScope, 'function');
  assert.strictEqual(typeof settings.probeDir, 'function');
  assert.strictEqual(typeof settings.isDir, 'function');
  assert.strictEqual(typeof settings.configuredWorkspaceRoot, 'function');
  assert.strictEqual(typeof settings.configuredWorkspaceRootStatus, 'function');
  assert.strictEqual(typeof settings.resolveWorkspaceRoot, 'function');
  assert.strictEqual(typeof settings.openAiKeyFromSettings, 'function');
  assert.strictEqual(typeof settings.invalidateCache, 'function');
  assert.strictEqual(typeof settings._resetCache, 'function');

  // Verify export parity between facade and modular settings
  const facadeKeys = Object.keys(settings).sort();
  const indexKeys = Object.keys(settingsIndex).sort();
  assert.strictEqual(facadeKeys.length, 32, 'Expected 32 exports');
  assert.deepStrictEqual(facadeKeys, indexKeys, 'Facade and settings/index must have identical exports');

  // Test defaults
  const defs = settings.defaults();
  assert.ok(defs);
  assert.strictEqual(defs.workspaceRoot, null);
  assert.strictEqual(defs.locale, 'system');
  assert.strictEqual(defs.voiceLocale, 'follow-ui');
  assert.strictEqual(defs.terminalFontScale, 'medium');

  // Test sanitizers
  const validTheme = settings.sanitizeTheme({ mode: 'dark', accent: '#ff00aa', preset: 'custom-preset' });
  assert.deepStrictEqual(validTheme, { mode: 'dark', accent: '#ff00aa', preset: 'custom-preset' });
  assert.strictEqual(settings.sanitizeTheme({ mode: 'invalid-mode' }), null);

  assert.strictEqual(settings.sanitizeLocale('tr'), 'tr');
  assert.strictEqual(settings.sanitizeLocale('en'), 'en');
  assert.strictEqual(settings.sanitizeLocale('invalid'), 'system');

  assert.strictEqual(settings.sanitizeVoiceLocale('tr'), 'tr');
  assert.strictEqual(settings.sanitizeVoiceLocale('invalid'), 'follow-ui');

  const trust = settings.sanitizeBrowserTrust({ mode: 'siki', trustedOrigins: ['HTTPS://EXAMPLE.COM'] });
  assert.strictEqual(trust.mode, 'siki');
  assert.ok(trust.trustedOrigins.includes('https://example.com'));

  const gov = settings.sanitizeResourceGovernor({ enabled: true, warnFreePct: 20, criticalFreePct: 10 });
  assert.deepStrictEqual(gov, { enabled: true, warnFreePct: 20, criticalFreePct: 10 });

  // Test probeDir and isDir
  const selfDir = settings.probeDir(__dirname);
  assert.strictEqual(selfDir.ok, true);
  assert.strictEqual(selfDir.reason, 'ok');
  assert.strictEqual(settings.isDir(__dirname), true);

  const nonExistent = settings.probeDir(path.join(__dirname, 'non_existent_dir_12345'));
  assert.strictEqual(nonExistent.ok, false);
  assert.strictEqual(nonExistent.reason, 'missing');
  assert.strictEqual(settings.isDir(path.join(__dirname, 'non_existent_dir_12345')), false);

  // Invalidate cache
  settings.invalidateCache();
});

test('Units - Voice: ttsProviders facade and submodules preserve contract and cost estimation', (t) => {
  const facade = require('../src/voice/ttsProviders.cjs');
  const mod = require('../src/voice/tts/index.cjs');

  assert.strictEqual(Object.keys(facade).length, 42, 'ttsProviders should export 42 symbols');
  assert.deepStrictEqual(Object.keys(facade).sort(), Object.keys(mod).sort(), 'Facade and modular index must have identical exports');

  // Verify pure helpers
  assert.strictEqual(facade.sanitizeApiKey('  "test-key"  '), 'test-key');
  assert.strictEqual(facade.isHeaderSafeKey('valid-token-123'), true);
  assert.strictEqual(facade.isHeaderSafeKey('invalid token with spaces'), false);
  assert.strictEqual(facade.escapeSsml('<tag & "quote">'), '&lt;tag &amp; &quot;quote&quot;&gt;');

  // Verify cost calculation
  const cost = facade.estimateCost('elevenlabs');
  assert.ok(cost, 'elevenlabs should have cost details');
  assert.strictEqual(typeof cost.usdPer1kChars, 'number');
  assert.strictEqual(typeof cost.monthlyHeavyUsd, 'number');

  // Verify engine resolution
  const resolved = facade.resolveTtsEngine({ jarvis: { ttsEngine: 'elevenlabs' } });
  assert.strictEqual(resolved, 'elevenlabs');

  // Verify ttsConfig
  const config = facade.ttsConfig({ jarvis: {} });
  assert.ok(config && Array.isArray(config.engines));
  assert.strictEqual(config.previewText, facade.TTS_PREVIEW_TEXT_TR);
});

test('Units - Agents: engineAuth facade and submodules preserve contract and status parsing', (t) => {
  const facade = require('../src/agents/engineAuth.cjs');
  const mod = require('../src/agents/engineAuth/index.cjs');

  assert.strictEqual(Object.keys(facade).length, 30, 'engineAuth should export 30 symbols');
  assert.deepStrictEqual(Object.keys(facade).sort(), Object.keys(mod).sort(), 'Facade and modular index must have identical exports');

  // Verify pure helpers and parsers
  assert.strictEqual(facade.maskSecrets('auth code=secret12345'), 'auth code=«gizlendi»');
  assert.strictEqual(facade.extractUrl('Follow https://example.com/oauth/authorize to authenticate'), 'https://example.com/oauth/authorize');
  assert.strictEqual(facade.wantsCode('Please paste code here:'), true);
  assert.strictEqual(facade.engineMessageOf('Error: API key is invalid or expired'), 'API key is invalid or expired');

  // Verify JSON and text parsers
  const jsonStatus = facade.parseJsonStatus('{"loggedIn":true,"email":"dev@crewpane.com","subscriptionType":"pro"}');
  assert.strictEqual(jsonStatus.loggedIn, true);
  assert.strictEqual(jsonStatus.account, 'dev@crewpane.com');
  assert.strictEqual(jsonStatus.plan, 'pro');

  const textStatus = facade.parseTextStatus('Logged in using ChatGPT (user@example.com)', 0);
  assert.strictEqual(textStatus.loggedIn, true);
  assert.strictEqual(textStatus.account, 'user@example.com');

  // Verify descriptors and argv
  const claudeDesc = facade.authDescriptor('claude');
  assert.ok(claudeDesc, 'claude descriptor must exist');
  assert.strictEqual(claudeDesc.engine, 'claude');
  assert.ok(Array.isArray(facade.statusArgv('claude')));
});

test('Units - Terminal: limitDetect facade and submodules preserve contract, time resolver, and limit detection', (t) => {
  const facade = require('../src/terminal/limitDetect.cjs');
  const mod = require('../src/terminal/limit/index.cjs');

  assert.strictEqual(Object.keys(facade).length, 34, 'limitDetect should export 34 symbols');
  assert.deepStrictEqual(Object.keys(facade).sort(), Object.keys(mod).sort(), 'Facade and modular index must have identical exports');

  // Verify ANSI stripping
  const colored = '\u001b[31mRed Alert\u001b[0m \u001b[1mBold\u001b[22m';
  assert.strictEqual(facade.stripAnsi(colored), 'Red Alert Bold');
  assert.strictEqual(facade.stripAnsiRobust(colored), 'Red Alert Bold');

  // Verify text helpers & engine inference
  assert.strictEqual(facade.inferEngine('You have reached the Claude usage limit'), 'claude');
  assert.strictEqual(facade.inferEngine('Codex message limit reached, try again in 2 hours'), 'codex');
  assert.strictEqual(facade.inferEngine('Some random terminal text'), null);
  assert.strictEqual(facade.resolveEngine('codex', 'claude text'), 'codex');
  assert.strictEqual(facade.resolveEngine(null, 'claude usage limit'), 'claude');

  // Verify time resolver functions
  assert.strictEqual(facade.isUsableTimeZone('America/New_York'), true);
  assert.strictEqual(facade.isUsableTimeZone('UTC'), true);
  assert.strictEqual(facade.isUsableTimeZone('Invalid/Zone/123'), false);

  const baseEpoch = 1700000000000;
  const saneFuture = baseEpoch + 3600000; // +1 hour
  const insaneFuture = baseEpoch + 100 * 86400000; // +100 days
  assert.strictEqual(facade.isSaneResetAt(saneFuture, baseEpoch), true);
  assert.strictEqual(facade.isSaneResetAt(insaneFuture, baseEpoch), false);

  // Verify clock epochs and roll over
  const epochs = facade.clockEpochs(14, 30, baseEpoch, 'UTC');
  assert.ok(epochs && typeof epochs.at === 'number');

  // Verify option classification
  assert.strictEqual(facade.classifyOption('1. Stop and wait'), 'wait');
  assert.strictEqual(facade.classifyOption('2. Switch to another model'), 'upgrade');
  assert.strictEqual(facade.classifyOption('3. Purchase extra credits'), 'upgrade');
  assert.strictEqual(facade.classifyOption('4. Random custom action'), 'other');

  // Verify limit state detection on non-limit text
  const normalOutput = 'npm test\nRunning 33 tests...\nPassed: 33\n';
  assert.strictEqual(facade.detectLimit(normalOutput), null);
  assert.strictEqual(facade.detectLimitState(normalOutput), null);
  assert.strictEqual(facade.looksLikeLimitText(normalOutput), false);
});

test('Units - Mobile: mobileGateway facade and submodules preserve contract, routes, and query parser', (t) => {
  const facade = require('../src/mobile/mobileGateway.js');
  const mod = require('../src/mobile/gateway/index.js');

  assert.strictEqual(Object.keys(facade).length, 12, 'mobileGateway should export 12 symbols');
  assert.deepStrictEqual(Object.keys(facade).sort(), Object.keys(mod).sort(), 'Facade and modular index must have identical exports');

  // Verify routeKeyFor
  const r1 = facade.routeKeyFor('GET', '/m/panes/pane-123/tail');
  assert.strictEqual(r1.key, 'GET /m/panes/:paneId/tail');
  assert.strictEqual(r1.paneId, 'pane-123');

  const r2 = facade.routeKeyFor('GET', '/m/panes/pane-456/transcript');
  assert.strictEqual(r2.key, 'GET /m/panes/:paneId/transcript');
  assert.strictEqual(r2.paneId, 'pane-456');

  const r3 = facade.routeKeyFor('POST', '/m/tasks/task-789/delegate');
  assert.strictEqual(r3.key, 'POST /m/tasks/:taskId/delegate');
  assert.strictEqual(r3.taskId, 'task-789');

  const r4 = facade.routeKeyFor('GET', '/m/sprite/agent_idle.png');
  assert.strictEqual(r4.key, 'GET /m/sprite/:key');
  assert.strictEqual(r4.spriteKey, 'agent_idle');

  const r5 = facade.routeKeyFor('GET', '/m/health');
  assert.strictEqual(r5.key, 'GET /m/health');

  // Verify queryParamsFor
  const u1 = new URL('http://localhost:7823/m/tasks?status=in_progress&limit=50&offset=10&team=backend');
  const p1 = facade.queryParamsFor('tasks', u1);
  assert.strictEqual(p1.status, 'in_progress');
  assert.strictEqual(p1.limit, 50);
  assert.strictEqual(p1.offset, 10);
  assert.strictEqual(p1.team, 'backend');

  const u2 = new URL('http://localhost:7823/m/tasks?limit=999');
  const p2 = facade.queryParamsFor('tasks', u2);
  assert.strictEqual(p2.limit, 100, 'Tasks limit must be clamped to MAX 100');

  const u3 = new URL('http://localhost:7823/m/agents?free=true&taskId=task-1');
  const p3 = facade.queryParamsFor('agents', u3);
  assert.strictEqual(p3.free, true);
  assert.strictEqual(p3.taskId, 'task-1');

  // Verify parseMultipart
  const boundary = '----WebKitFormBoundaryXYZ';
  const multipartBody = Buffer.from(
    `--${boundary}\r\n` +
    'Content-Disposition: form-data; name="text"\r\n\r\n' +
    'hello jarvis\r\n' +
    `--${boundary}\r\n` +
    'Content-Disposition: form-data; name="audio"; filename="voice.m4a"\r\n' +
    'Content-Type: audio/m4a\r\n\r\n' +
    'audio-raw-bytes\r\n' +
    `--${boundary}--\r\n`
  );
  const parsed = facade.parseMultipart(multipartBody, `multipart/form-data; boundary=${boundary}`);
  assert.ok(parsed, 'Multipart body should be parsed');
  assert.strictEqual(parsed.text, 'hello jarvis');
  assert.ok(parsed.audio && parsed.audio.audioBase64);
  assert.strictEqual(parsed.audio.fileName, 'voice.m4a');
  assert.strictEqual(parsed.audio.mimeType, 'audio/m4a');
});


