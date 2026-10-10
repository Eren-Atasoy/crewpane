'use strict';

/**
 * src/agents/goalGate.cjs
 *
 * Goal Gate — Kanıtlanmış "Bitti" Doğrulama Motoru (Faz 4)
 *
 * Bir alt görev DONE dediğinde, önceden tanımlanmış kontrol adımlarını
 * (checks: lint, test vb.) koşarak işin doğruluğunu makine seviyesinde ölçer.
 * Tur durumu, ilerleme takibi ve durma kararlarını yöneten saf yaprak modüldür.
 *
 * Kural 0: Saf yaprak modül (fs/electron yok, komut koşucu ve zaman enjekte edilir).
 */

const DEFAULT_MAX_ROUNDS = 5;
const DEFAULT_ABORT_NO_PROGRESS = 2;

function extractErrorSummary(stdout = '', stderr = '') {
  const combined = `${stderr}\n${stdout}`.trim();
  if (!combined) return 'Bilinmeyen hata (çıktı boş)';

  const lines = combined.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const errorLines = [];

  for (const line of lines) {
    if (/(error|fail|exception|assert|syntaxerror|typeerror|kırık|başarısız)/i.test(line)) {
      errorLines.push(line);
      if (errorLines.length >= 3) break;
    }
  }

  if (errorLines.length > 0) {
    return errorLines.join(' | ').slice(0, 300);
  }

  return lines[0].slice(0, 300);
}

function checkStopConditions(params = {}) {
  const { goal = {}, rounds = [] } = params;
  const maxRounds = Number(goal.maxRounds) || DEFAULT_MAX_ROUNDS;
  const abortIfNoProgress = Number(goal.abortIfNoProgress) || DEFAULT_ABORT_NO_PROGRESS;
  const currentRound = rounds.length;

  if (currentRound >= maxRounds) {
    return {
      abort: true,
      reason: 'goal.abort.max_rounds_reached',
      message: `Maksimum tur sayısına (${maxRounds}) ulaşıldı`,
    };
  }

  if (abortIfNoProgress > 0 && rounds.length >= abortIfNoProgress) {
    const recent = rounds.slice(-abortIfNoProgress);
    const firstPassed = recent[0].passedCount || 0;
    const allStalled = recent.every((r) => (r.passedCount || 0) <= firstPassed);
    if (allStalled && recent[recent.length - 1].passedCount < (goal.checks || []).length) {
      return {
        abort: true,
        reason: 'goal.abort.no_progress',
        message: `${abortIfNoProgress} tur boyunca kontrol ilerlemesi kaydedilemedi`,
      };
    }
  }

  return { abort: false, reason: null };
}

function isEligibleChecker(workerAgentId, checkerAgentId) {
  if (!workerAgentId || !checkerAgentId) return false;
  return String(workerAgentId).trim() !== String(checkerAgentId).trim();
}

async function executeSingleCheck(checkCmd, runCommand, cwd) {
  try {
    const res = await runCommand({ command: checkCmd, cwd });
    const code = typeof res.code === 'number' ? res.code : (res.error ? 1 : 0);
    const passed = code === 0;
    return {
      command: checkCmd,
      passed,
      code,
      summary: passed ? 'OK' : extractErrorSummary(res.stdout, res.stderr),
    };
  } catch (err) {
    return {
      command: checkCmd,
      passed: false,
      code: 1,
      summary: err.message || 'Komut çalıştırma hatası',
    };
  }
}

async function evaluateChecks(checks, runCommand, cwd) {
  const results = [];
  let passedCount = 0;

  for (const cmd of checks) {
    const res = await executeSingleCheck(cmd, runCommand, cwd);
    results.push(res);
    if (res.passed) {
      passedCount++;
    } else {
      break; // İlk başarısız kontrolde dur, çıktıyı özete al
    }
  }

  return { results, passedCount };
}

function buildRoundOutcome(ctx) {
  const { results, passedCount, totalChecks, goal, rounds, checkerAgentId } = ctx;
  const allPassed = passedCount === totalChecks;
  const roundIndex = rounds.length + 1;

  if (allPassed) {
    const needsReview = Boolean(goal.checker);
    const reviewReady = needsReview ? isEligibleChecker(goal.workerAgentId, checkerAgentId) : true;
    return {
      passed: true,
      canSettle: reviewReady,
      needsReview: needsReview && !reviewReady,
      round: roundIndex,
      passedCount,
      totalChecks,
      results,
      statusText: 'Tüm kontroller geçti',
      code: reviewReady ? 'goal.checks_passed' : 'goal.awaiting_checker_review',
    };
  }

  const failed = results.find((r) => !r.passed) || results[results.length - 1];
  const newRounds = [...rounds, { round: roundIndex, passedCount }];
  const stop = checkStopConditions({ goal, rounds: newRounds });

  return {
    passed: false,
    canSettle: false,
    abort: stop.abort,
    abortReason: stop.reason,
    round: roundIndex,
    passedCount,
    totalChecks,
    results,
    failedCheck: failed.command,
    feedback: failed.summary,
    statusText: `${passedCount}/${totalChecks} kontrol geçti · ${failed.command} başarısız`,
    code: stop.abort ? stop.reason : 'goal.checks_failed_round_retry',
  };
}

/**
 * Goal Gate fabrikası
 */
function createGoalGate(deps = {}) {
  const runCommand = deps.runCommand || (async () => ({ code: 0, stdout: 'ok', stderr: '' }));

  async function evaluateRound(params = {}) {
    const { goal = {}, rounds = [], cwd = null, checkerAgentId = null } = params;
    const checks = Array.isArray(goal.checks) ? goal.checks.filter(Boolean) : [];
    if (!checks.length) {
      return {
        passed: true,
        canSettle: true,
        round: 0,
        passedCount: 0,
        totalChecks: 0,
        results: [],
        code: 'goal.no_checks_defined',
      };
    }

    const { results, passedCount } = await evaluateChecks(checks, runCommand, cwd);
    return buildRoundOutcome({
      results,
      passedCount,
      totalChecks: checks.length,
      goal,
      rounds,
      checkerAgentId,
    });
  }

  return {
    evaluateRound,
    checkStopConditions,
    extractErrorSummary,
    isEligibleChecker,
  };
}

module.exports = {
  createGoalGate,
  extractErrorSummary,
  checkStopConditions,
  isEligibleChecker,
  DEFAULT_MAX_ROUNDS,
  DEFAULT_ABORT_NO_PROGRESS,
};
