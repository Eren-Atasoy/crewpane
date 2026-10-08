'use strict';

const planLimitsDefault = require('../../config/planLimits.cjs');
const analyticsSchemaDefault = require('../../../telemetry/analyticsSchema.cjs');
const workspaceOnboardingDefault = require('../../agents/workspaceOnboarding.cjs');
const spawnSpecDefault = require('../../agents/spawnSpec.cjs');

const PLAN_NUDGE_MIN_MS = 60_000;

function trackPlanLimitHit(denial, planLimits, analyticsNow, analyticsSchema) {
  try {
    const spec = planLimits.FEATURES[denial.feature];
    analyticsNow().track('plan_limit_hit', {
      feature: analyticsSchema.featureOf(denial.feature),
      limit: denial.limit,
      current: denial.current,
      kind: (spec && spec.kind) || 'other',
    });
  } catch {
    /* analitik reddi bildirmeyi düşüremez */
  }
}

/**
 * Plan Limit Deciders, Nudge Throttling & Workspace Plan Service (Faz 3.6.13)
 */
function createPlanLimitService(deps = {}) {
  const {
    getSeatGate = () => null,
    getAppWindow = () => null,
    analyticsNow = () => ({ track: () => {} }),
    logLine = () => {},
    planLimits = planLimitsDefault,
    workspaceOnboarding = workspaceOnboardingDefault,
    analyticsSchema = analyticsSchemaDefault,
    defaultWaveLimit = spawnSpecDefault.SPRINT_DEFAULT_WAVE,
  } = deps;

  const planNudgeLast = new Map();

  function pushPlanLimit(denial) {
    if (!denial) return;
    trackPlanLimitHit(denial, planLimits, analyticsNow, analyticsSchema);

    const last = planNudgeLast.get(denial.feature) || 0;
    const now = Date.now();
    if (now - last < PLAN_NUDGE_MIN_MS) return;
    planNudgeLast.set(denial.feature, now);

    const win = getAppWindow();
    if (win && !win.isDestroyed()) {
      try {
        win.webContents.send('plan:limit', denial);
      } catch {
        /* pencere kapandı / gitti */
      }
    }
  }

  function planDenial(feature, current = 0, opts = {}) {
    const { notify = true, variant = null, context = null } = opts;
    const seatGate = getSeatGate();
    const snapshot = seatGate ? seatGate.state() : null;
    const decision = planLimits.decide({ snapshot, feature, current, variant, context });
    if (decision.allowed) return null;

    logLine(`planLimits: ${feature} REDDEDİLDİ (katman=${decision.tier} tavan=${decision.limit} kullanım=${decision.current})`);
    if (notify) pushPlanLimit(decision);
    return decision;
  }

  function workspacePlanDenial(root) {
    let known;
    try {
      if (workspaceOnboarding.isKnownWorkspace(root)) return null;
      known = workspaceOnboarding.knownWorkspaces();
    } catch (err) {
      logLine(`planLimits: workspaces sayımı okunamadı (${err && err.message}) — limit UYGULANMADI`);
      return null;
    }
    return planDenial('workspaces', known.length);
  }

  function planWaveLimit(requested) {
    const asked = Number.isInteger(requested) && requested > 0 ? requested : defaultWaveLimit;
    const seatGate = getSeatGate();
    const snapshot = seatGate ? seatGate.state() : null;
    const { value, clamped, denial } = planLimits.clamp({ snapshot, feature: 'delegateWave', requested: asked });

    if (clamped && denial) {
      logLine(`planLimits: delegateWave KISITLANDI (katman=${denial.tier} tavan=${denial.limit} istenen=${denial.current})`);
      pushPlanLimit(denial);
    }
    return value;
  }

  function rememberWorkspaceRoot(root) {
    try {
      workspaceOnboarding.rememberWorkspace(root);
    } catch (err) {
      logLine(`workspace defteri yazılamadı (${err && err.message}) — aktif kök yine bilinir sayılır`);
    }
  }

  return {
    pushPlanLimit,
    planDenial,
    workspacePlanDenial,
    planWaveLimit,
    rememberWorkspaceRoot,
  };
}

module.exports = {
  createPlanLimitService,
  PLAN_NUDGE_MIN_MS,
};
