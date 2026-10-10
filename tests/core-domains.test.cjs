'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Domain 1: Security - secretRedactor
test('Core Domains - Security: secretRedactor registers secrets, redacts literals, tails, deep objects, and DSNs', (t) => {
  const { createSecretRedactor, MIN_SECRET_LENGTH } = require('../src/security/secretRedactor.cjs');

  const redactor = createSecretRedactor({
    mask: (secret, service) => (service === 'github' ? 'ghp_••••' : '••••'),
  });

  // Minimum length gate
  assert.strictEqual(redactor.register('short'), false, 'Secrets under MIN_SECRET_LENGTH must be rejected');
  assert.strictEqual(redactor.register('a'.repeat(MIN_SECRET_LENGTH)), true);

  // Literal secret redaction
  const apiKey = 'sk-super-secret-agent-key-999';
  const ghToken = 'ghp_1234567890abcdefghij';
  assert.strictEqual(redactor.register(apiKey, 'openai'), true);
  assert.strictEqual(redactor.register(ghToken, 'github'), true);
  assert.strictEqual(redactor.size(), 3);

  const input = `Starting agent with key ${apiKey} and github token ${ghToken}.`;
  const redacted = redactor.redact(input);
  assert.ok(!redacted.includes(apiKey), 'Literal API key must be redacted');
  assert.ok(!redacted.includes(ghToken), 'Literal GitHub token must be redacted');
  assert.ok(redacted.includes('••••'));
  assert.ok(redacted.includes('ghp_••••'));

  // DSN password redaction
  const dsn = 'postgres://app_user:SuperPassword123@db.crewpane.co:5432/production_db';
  const dsnRedacted = redactor.redactDsnCredentials(dsn);
  assert.strictEqual(dsnRedacted, 'postgres://app_user:••••@db.crewpane.co:5432/production_db');

  // Deep redaction for structured IPC objects
  const payload = {
    env: { KEY: apiKey, TOKEN: ghToken },
    nested: [{ token: apiKey }, 'plain text'],
    unchangedNumber: 42,
  };
  const deepRedacted = redactor.redactDeep(payload);
  assert.strictEqual(deepRedacted.env.KEY, '••••');
  assert.strictEqual(deepRedacted.env.TOKEN, 'ghp_••••');
  assert.strictEqual(deepRedacted.nested[0].token, '••••');
  assert.strictEqual(deepRedacted.unchangedNumber, 42);

  // Clear & registerEnv
  redactor.clear();
  assert.strictEqual(redactor.size(), 0);
  const count = redactor.registerEnv({
    CREWPANE_SECRET_SUPABASE: 'supabase-token-123456789',
    CREWPANE_SECRET_GITHUB: 'github-token-123456789',
    IRRELEVANT_VAR: 'some-other-value',
  });
  assert.strictEqual(count, 2);
  assert.strictEqual(redactor.size(), 2);
});

// Domain 2: Security - browserTrust
test('Core Domains - Security: browserTrust classifies origins, targets, and enforces security modes', (t) => {
  const browserTrust = require('../src/security/browserTrust.cjs');

  // Verify built-in lists
  assert.ok(browserTrust.BUILTIN_TRUSTED.includes('localhost'));
  assert.ok(browserTrust.BUILTIN_TRUSTED.includes('127.0.0.1'));
  assert.ok(browserTrust.BUILTIN_TRUSTED.includes('crewpane.dev'));

  // Origin classification
  const localOrigin = browserTrust.classifyOrigin('http://localhost:3000/dashboard');
  assert.strictEqual(localOrigin.level, 'trusted');

  const unknownOrigin = browserTrust.classifyOrigin('https://random-untrusted-site.com/login');
  assert.strictEqual(unknownOrigin.level, 'unknown');

  const blockedOrigin = browserTrust.classifyOrigin('https://n8n.crewpane.dev/workflow');
  assert.strictEqual(blockedOrigin.level, 'blocked');

  // Target element sensitivity
  const passwordTarget = browserTrust.classifyTarget({
    elementInfo: { tag: 'input', type: 'password' },
    action: 'type',
  });
  assert.strictEqual(passwordTarget.sensitive, true);

  const safeButton = browserTrust.classifyTarget({
    elementInfo: { tag: 'button', text: 'Search' },
    action: 'click',
  });
  assert.strictEqual(safeButton.sensitive, false);

  // Decisions
  // 1. Blocked origin is ALWAYS denied
  const dBlocked = browserTrust.decide({ url: 'https://n8n.crewpane.dev', action: 'click' });
  assert.strictEqual(dBlocked.decision, 'deny');

  // 2. Sensitive target on trusted localhost STILL asks (Zero Trust on sensitive elements)
  const dSensitiveLocal = browserTrust.decide({
    url: 'http://localhost:3000',
    action: 'type',
    elementInfo: { tag: 'input', type: 'password' },
    text: 'mypassword',
  });
  assert.strictEqual(dSensitiveLocal.decision, 'ask');
  assert.strictEqual(dSensitiveLocal.sensitive, true);

  // 3. Normal target on trusted localhost is allowed
  const dSafeLocal = browserTrust.decide({
    url: 'http://localhost:3000',
    action: 'click',
    elementInfo: { tag: 'button', text: 'Next' },
  });
  assert.strictEqual(dSafeLocal.decision, 'allow');

  // 4. Read action is always allowed everywhere
  const dRead = browserTrust.decide({ url: 'https://n8n.crewpane.dev', action: 'readPage' });
  assert.strictEqual(dRead.decision, 'allow');

  // Preview masking
  assert.strictEqual(browserTrust.maskPreview('mySecretPassword', true), '•••(16)');
  assert.strictEqual(browserTrust.maskPreview('Normal Button', false), 'Normal Button');
});

// Domain 3: Security - credentialVault helpers
test('Core Domains - Security: credentialVault specificity ranking, env names, and best matching', (t) => {
  const vault = require('../src/security/credentialVault.cjs');

  // envVarName strips 'cred_' prefix per §3.3
  assert.strictEqual(vault.envVarName('cred_1234'), 'CREWPANE_SECRET_1234');

  // Specificity ranking: project+env (4) > project (3) > workspace+env (2) > workspace (1) > 0
  const records = [
    {
      id: 'rec_global_dev',
      service: 'supabase',
      authKind: 'api_key',
      scope: { type: 'workspace' },
      env: 'dev',
    },
    {
      id: 'rec_proj_dev',
      service: 'supabase',
      authKind: 'api_key',
      scope: { type: 'project', projectId: 'prj-alpha' },
      env: 'dev',
    },
    {
      id: 'rec_proj_any',
      service: 'supabase',
      authKind: 'api_key',
      scope: { type: 'project', projectId: 'prj-alpha' },
      env: null,
    },
    {
      id: 'rec_other_proj',
      service: 'supabase',
      authKind: 'api_key',
      scope: { type: 'project', projectId: 'prj-beta' },
      env: 'dev',
    },
  ];

  // Best match for prj-alpha in dev env must be rec_proj_dev (specificity 4)
  const bestAlpha = vault.pickBest(records, 'supabase', { projectId: 'prj-alpha', env: 'dev' });
  assert.strictEqual(bestAlpha.id, 'rec_proj_dev');

  // Best match for prj-alpha in prod env falls back to rec_proj_any (specificity 3)
  const bestProd = vault.pickBest(records, 'supabase', { projectId: 'prj-alpha', env: 'prod' });
  assert.strictEqual(bestProd.id, 'rec_proj_any');

  // Best match for unmatched project prj-gamma falls back to global dev (specificity 2)
  const bestGamma = vault.pickBest(records, 'supabase', { projectId: 'prj-gamma', env: 'dev' });
  assert.strictEqual(bestGamma.id, 'rec_global_dev');
});

// Domain 4: Memory - memorySecretMask
test('Core Domains - Memory: memorySecretMask detects self-identifying tokens, keywords, and preserves commit hashes', (t) => {
  const memMask = require('../src/memory/memorySecretMask.cjs');

  // Self-identifying token patterns
  const tokens = [
    'sk-ant-api03-abcdefghijklmnop1234567890',
    'sk-abcdef123456789012345678',
    'ghp_1234567890abcdefghij',
    'xoxb-1234567890-123456789012',
    'sk_live_1234567890abcdefghijkl',
    're_12345678_1234567890abcdef',
  ];

  for (const token of tokens) {
    const text = `Configuration parameter: ${token} embedded in line`;
    const masked = memMask.maskSecrets(text);
    assert.ok(!masked.includes(token), `Token ${token} must be masked`);
    assert.ok(masked.includes(memMask.MASK), `Masked string must include ${memMask.MASK}`);
    assert.strictEqual(memMask.containsSecret(text), true);
  }

  // Keyword adjacent secrets
  const kwText = 'API key was set to api_key: SecretPassword123!';
  const kwMasked = memMask.maskSecrets(kwText);
  assert.ok(!kwMasked.includes('SecretPassword123!'));
  assert.ok(kwMasked.includes(memMask.MASK));

  // Commit hashes should NOT be masked
  const commitText = 'Merged PR in commit 66394f631234567890abcdef1234567890abcdef successfully';
  assert.strictEqual(
    memMask.maskSecrets(commitText),
    commitText,
    'Git commit SHA must not be false-positively masked',
  );

  // Deep object masking
  const obj = { notes: ['Found secret: ghp_1234567890abcdefghij', 'Normal comment'], count: 5 };
  const maskedObj = memMask.maskDeep(obj);
  assert.ok(!maskedObj.notes[0].includes('ghp_'));
  assert.strictEqual(maskedObj.notes[1], 'Normal comment');
  assert.strictEqual(maskedObj.count, 5);
});

// Domain 5: Services - tokenCost
test('Core Domains - Services: tokenCost formats tokens, normalizes model IDs, and computes pricing', (t) => {
  const tokenCost = require('../src/services/tokenCost.cjs');

  // Token formatting
  assert.strictEqual(tokenCost.formatTokens(450), '450');
  assert.strictEqual(tokenCost.formatTokens(1500), '1.5K');
  assert.strictEqual(tokenCost.formatTokens(25000), '25K');
  assert.strictEqual(tokenCost.formatTokens(1250000), '1.25M');
  assert.strictEqual(tokenCost.formatTokens(2500000000), '2.50B');
  assert.strictEqual(tokenCost.formatTokens(-10), '—');

  // Model ID normalization
  assert.strictEqual(tokenCost.normalizeModelId('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
  assert.strictEqual(tokenCost.normalizeModelId('claude-sonnet-4-5'), 'claude-sonnet-4-5');

  // Price resolution
  const price = tokenCost.priceFor('claude-sonnet-4-5');
  assert.ok(price, 'Price for claude-sonnet-4-5 should resolve');
  assert.strictEqual(price.key, 'claude-sonnet-4-5');
  assert.strictEqual(typeof price.input, 'number');
  assert.strictEqual(typeof price.output, 'number');

  // Usage computation: 1M input + 1M output
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
  const cost = tokenCost.usdForUsage(usage, price);
  assert.strictEqual(cost.usd, price.input + price.output);
  assert.strictEqual(tokenCost.formatUsd(cost.usd), `$${(price.input + price.output).toFixed(2)}`);
  assert.strictEqual(tokenCost.formatUsd(null), null);
  assert.strictEqual(tokenCost.formatUsd(0), '$0.00');
  assert.strictEqual(tokenCost.formatUsd(0.004), '<$0.01');
});

// Domain 6: Agents - teamCompose
test('Core Domains - Agents: teamCompose caps, autonomy sanitation, and proposal ledger', (t) => {
  const teamCompose = require('../src/agents/teamCompose.cjs');

  // CAPS
  assert.strictEqual(teamCompose.CAPS.maxEmployees, 6);
  assert.strictEqual(teamCompose.CAPS.maxTeams, 1);
  assert.strictEqual(teamCompose.CAPS.maxInstallsPerSession, 3);

  // Autonomy levels
  assert.strictEqual(teamCompose.sanitizeAutonomy('auto'), 'auto');
  assert.strictEqual(teamCompose.sanitizeAutonomy('small-auto'), 'small-auto');
  assert.strictEqual(teamCompose.sanitizeAutonomy('ask'), 'ask');
  assert.strictEqual(teamCompose.sanitizeAutonomy('unknown-level'), 'ask');

  // Cap decisions
  const validRows = [
    { role: 'coder', name: 'Dev 1' },
    { role: 'tester', name: 'QA 1' },
  ];
  const validDecision = teamCompose.capDecision({ rows: validRows, mode: 'team' });
  assert.strictEqual(validDecision.ok, true);

  const overflowRows = Array.from({ length: 7 }, (_, i) => ({ role: 'coder', name: `Dev ${i}` }));
  const overflowDecision = teamCompose.capDecision({ rows: overflowRows, mode: 'team' });
  assert.strictEqual(overflowDecision.ok, false);
  assert.ok(overflowDecision.reason.includes('6'));

  const sessionDecision = teamCompose.capDecision({ rows: validRows, sessionInstalls: 3 });
  assert.strictEqual(sessionDecision.ok, false);
  assert.strictEqual(sessionDecision.code, 'cap');
  assert.strictEqual(sessionDecision.cap, 'session');

  // Ledger proposal and single-use undo
  let fakeTime = 1000000;
  const ledger = teamCompose.createComposeLedger({
    now: () => fakeTime,
    randomId: () => 'prop-test-uuid',
  });

  const proposal = ledger.putProposal({
    objective: 'Build authentication feature',
    teamName: 'team-dev',
    rows: validRows,
    mode: 'team',
  });
  assert.strictEqual(proposal.proposalId, 'cmp-prop-test-uuid');
  assert.ok(ledger.getProposal('cmp-prop-test-uuid'));

  // Record applied undo
  ledger.recordApplied('cmp-prop-test-uuid', {
    teamId: 'team-1',
    createdTeam: true,
    employeeIds: ['agent-1', 'agent-2'],
  });
  assert.ok(ledger.peekUndo('cmp-prop-test-uuid'));

  // takeUndo is single-use
  const undoData = ledger.takeUndo('cmp-prop-test-uuid');
  assert.deepStrictEqual(undoData.employeeIds, ['agent-1', 'agent-2']);
  assert.strictEqual(ledger.takeUndo('cmp-prop-test-uuid'), null, 'Second takeUndo must return null');
});

// Domain 7: Config - envGuard
test('Core Domains - Config: envGuard blocks prod targets and validates safe dev targets', (t) => {
  const envGuard = require('../src/config/envGuard.cjs');

  const prodUrl = 'https://xjhwkikjsqiyywpolmld.supabase.co';
  const localUrl = 'http://127.0.0.1:54321';

  // Production identification
  assert.strictEqual(envGuard.isProdTarget(prodUrl), true);
  assert.strictEqual(envGuard.isProdTarget(localUrl), false);

  // Forbidden target check
  assert.strictEqual(envGuard.isForbiddenTarget(prodUrl), true);
  assert.strictEqual(envGuard.isForbiddenTarget(localUrl), false);

  // Assertion throws on prod target
  assert.throws(() => {
    envGuard.assertNotForbiddenTarget(prodUrl);
  }, envGuard.EnvGuardError);

  assert.doesNotThrow(() => {
    envGuard.assertNotForbiddenTarget(localUrl);
  });

  // URL normalization and host extraction
  assert.strictEqual(
    envGuard.hostOf('https://my-subdomain.supabase.co:8080/path'),
    'my-subdomain.supabase.co',
  );
  assert.strictEqual(envGuard.refFromUrl(prodUrl), envGuard.PROD_PROJECT_REF);
});
