// CrewPane — Faz 1: GÖREV BAŞINA MALİYET VE SONUÇ DEFTERİ (Task Outcome Ledger).
//
// ── AMACI ───────────────────────────────────────────────────────────────────
// Jev Akıllı Yönlendirici'nin kararlarını (ve genel olarak motor/model seçimlerini)
// nesnel verilerle ölçmek: her görev için harcanan jeton, hesaplanan dolar karşılığı,
// tur/tekrar sayısı ve nihai sonuç ('passed' | 'failed' | 'aborted' | 'unknown').
//
// ── KURALLAR (CREWPANE_ROADMAP §0) ──────────────────────────────────────────
// 1. SAF LEAF MODÜL: fs/electron require'ı yok. Tüm IO enjekte edilir.
// 2. DETERMINISTIK: Date.now() yerine `now()` enjekte edilir.
// 3. MAIN SÜREÇTE METİN YOK: reason/outcome kod döner ('passed', 'aborted' vb.).
// 4. DÜRÜSTLÜK KURALI: Ölçülmemiş maliyet için sayı UYDURULMAZ, null döner.
//
'use strict';

const defaultTokenCost = require('../services/tokenCost.cjs');

const STORE_VERSION = 1;

/** İzin verilen tamamlanma sonuçları */
const OUTCOMES = Object.freeze(['passed', 'failed', 'aborted', 'unknown']);
const OUTCOME_SET = new Set(OUTCOMES);

/** Delegasyon + alt-görev tekil anahtarı */
function recordKey(delegationId, subtaskId) {
  return `${String(delegationId || '')}:${String(subtaskId || '')}`;
}

/** Ham sonucu geçerli sonuca normalize eder */
function normalizeOutcome(raw) {
  if (typeof raw !== 'string') return 'unknown';
  const norm = raw.trim().toLowerCase();
  if (norm === 'done' || norm === 'passed' || norm === 'success') return 'passed';
  if (norm === 'failed' || norm === 'error') return 'failed';
  if (norm === 'aborted' || norm === 'cancelled') return 'aborted';
  return OUTCOME_SET.has(norm) ? norm : 'unknown';
}

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function numOrZero(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

function computeTaskCost(entry, tokenCost, costUsd) {
  if (numOrNull(costUsd) !== null) return costUsd;
  if (!entry.model || (entry.tokensIn <= 0 && entry.tokensOut <= 0 && entry.cacheRead <= 0)) {
    return null;
  }
  try {
    const price = tokenCost.priceFor(entry.model, { speed: entry.effort });
    if (!price) return null;
    const usage = {
      inputTokens: entry.tokensIn,
      outputTokens: entry.tokensOut,
      cacheReadTokens: entry.cacheRead,
    };
    const calc = tokenCost.usdForUsage(usage, price);
    return calc && typeof calc.usd === 'number' ? Number(calc.usd.toFixed(6)) : null;
  } catch {
    return null;
  }
}

function buildStartEntry(existing, input, now) {
  const { delegationId, subtaskId, engine, model, effort, startedAt } = input;
  const t = numOrNull(startedAt) || now();
  return {
    delegationId: String(delegationId),
    subtaskId: String(subtaskId),
    engine: engine ? String(engine) : (existing ? existing.engine : null),
    model: model ? String(model) : (existing ? existing.model : null),
    effort: effort ? String(effort) : (existing ? existing.effort : null),
    tokensIn: existing ? existing.tokensIn : 0,
    tokensOut: existing ? existing.tokensOut : 0,
    cacheRead: existing ? existing.cacheRead : 0,
    costUsd: existing ? existing.costUsd : null,
    turns: existing ? existing.turns : 1,
    retries: existing ? existing.retries : 0,
    startedAt: existing ? existing.startedAt : t,
    settledAt: null,
    settledBy: null,
    outcome: null,
    overriddenBy: input.overriddenBy || (existing ? existing.overriddenBy : null),
  };
}

function updateModelStats(byModel, r) {
  const mKey = r.model || 'unknown';
  if (!byModel[mKey]) {
    byModel[mKey] = { tasks: 0, passed: 0, failed: 0, costUsd: 0, pricedTasks: 0 };
  }
  byModel[mKey].tasks++;
  if (r.outcome === 'passed') byModel[mKey].passed++;
  else byModel[mKey].failed++;
  if (typeof r.costUsd === 'number') {
    byModel[mKey].costUsd += r.costUsd;
    byModel[mKey].pricedTasks++;
  }
}

function updateEngineStats(byEngine, r) {
  const eKey = r.engine || 'unknown';
  if (!byEngine[eKey]) {
    byEngine[eKey] = { tasks: 0, passed: 0, failed: 0, costUsd: 0 };
  }
  byEngine[eKey].tasks++;
  if (r.outcome === 'passed') byEngine[eKey].passed++;
  else byEngine[eKey].failed++;
  if (typeof r.costUsd === 'number') {
    byEngine[eKey].costUsd += r.costUsd;
  }
}

function formatModelStats(byModel) {
  const out = {};
  for (const [k, v] of Object.entries(byModel)) {
    out[k] = {
      tasks: v.tasks,
      passed: v.passed,
      failed: v.failed,
      passRate: v.tasks > 0 ? Number((v.passed / v.tasks).toFixed(3)) : null,
      costUsd: Number(v.costUsd.toFixed(4)),
      avgCostUsd: v.pricedTasks > 0 ? Number((v.costUsd / v.pricedTasks).toFixed(4)) : null,
    };
  }
  return out;
}

function computeSummary(records) {
  const list = Array.from(records.values()).filter((r) => r.outcome !== null);
  const totalTasks = list.length;
  let passedCount = 0;
  let failedCount = 0;
  let abortedCount = 0;
  let unknownCount = 0;
  let totalCost = 0;
  let pricedTasksCount = 0;
  const byModel = {};
  const byEngine = {};

  for (const r of list) {
    if (r.outcome === 'passed') passedCount++;
    else if (r.outcome === 'failed') failedCount++;
    else if (r.outcome === 'aborted') abortedCount++;
    else unknownCount++;

    if (typeof r.costUsd === 'number') {
      totalCost += r.costUsd;
      pricedTasksCount++;
    }
    updateModelStats(byModel, r);
    updateEngineStats(byEngine, r);
  }

  return {
    totalTasks,
    passedCount,
    failedCount,
    abortedCount,
    unknownCount,
    passRate: totalTasks > 0 ? Number((passedCount / totalTasks).toFixed(3)) : null,
    totalCostUsd: pricedTasksCount > 0 ? Number(totalCost.toFixed(4)) : null,
    avgCostUsd: pricedTasksCount > 0 ? Number((totalCost / pricedTasksCount).toFixed(4)) : null,
    byModel: formatModelStats(byModel),
    byEngine,
  };
}

/**
 * Task Outcome Ledger Fabrikası
 */
function createTaskOutcomeLedger(opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const persist = typeof opts.persist === 'function' ? opts.persist : null;
  const tokenCost = opts.tokenCost || defaultTokenCost;
  const records = new Map();

  if (opts.initialState && typeof opts.initialState === 'object') {
    const src = opts.initialState.records || opts.initialState;
    if (src && typeof src === 'object') {
      for (const [k, v] of Object.entries(src)) {
        if (v && typeof v === 'object' && v.delegationId && v.subtaskId) records.set(k, { ...v });
      }
    }
  }

  function touch() {
    if (persist) persist(getState());
  }

  function recordStart(input = {}) {
    if (!input.delegationId || !input.subtaskId) return null;
    const key = recordKey(input.delegationId, input.subtaskId);
    const existing = records.get(key);
    const entry = buildStartEntry(existing, input, now);
    records.set(key, entry);
    touch();
    return { ...entry };
  }

  function recordTurn(input = {}) {
    const key = recordKey(input.delegationId, input.subtaskId);
    let entry = records.get(key) || recordStart(input);
    entry.turns = (entry.turns || 0) + 1;
    entry.tokensIn = (entry.tokensIn || 0) + numOrZero(input.tokensIn);
    entry.tokensOut = (entry.tokensOut || 0) + numOrZero(input.tokensOut);
    entry.cacheRead = (entry.cacheRead || 0) + numOrZero(input.cacheRead);
    if (numOrNull(input.costUsd) !== null) entry.costUsd = (entry.costUsd || 0) + input.costUsd;
    touch();
    return { ...entry };
  }

  function recordRetry(delegationId, subtaskId) {
    const key = recordKey(delegationId, subtaskId);
    let entry = records.get(key) || recordStart({ delegationId, subtaskId });
    entry.retries = (entry.retries || 0) + 1;
    touch();
    return { ...entry };
  }

  function settle(input = {}) {
    if (!input.delegationId || !input.subtaskId) return null;
    const key = recordKey(input.delegationId, input.subtaskId);
    let entry = records.get(key) || recordStart(input);

    if (input.engine) entry.engine = String(input.engine);
    if (input.model) entry.model = String(input.model);
    if (input.effort) entry.effort = String(input.effort);
    if (input.overriddenBy) entry.overriddenBy = String(input.overriddenBy);

    if (numOrNull(input.tokensIn) !== null) entry.tokensIn = input.tokensIn;
    if (numOrNull(input.tokensOut) !== null) entry.tokensOut = input.tokensOut;
    if (numOrNull(input.cacheRead) !== null) entry.cacheRead = input.cacheRead;

    entry.settledAt = numOrNull(input.settledAt) || now();
    entry.settledBy = input.settledBy ? String(input.settledBy) : 'unknown';
    entry.outcome = normalizeOutcome(input.outcome);
    entry.costUsd = computeTaskCost(entry, tokenCost, input.costUsd);

    touch();
    return { ...entry };
  }

  function getState() {
    const out = {};
    for (const [k, v] of records.entries()) out[k] = { ...v };
    return { version: STORE_VERSION, records: out };
  }

  return {
    recordStart,
    recordTurn,
    recordRetry,
    settle,
    getEntry: (dId, sId) => {
      const r = records.get(recordKey(dId, sId));
      return r ? { ...r } : null;
    },
    listEntries: (filter = {}) => {
      let list = Array.from(records.values());
      if (filter.outcome) list = list.filter((r) => r.outcome === filter.outcome);
      if (filter.engine) list = list.filter((r) => r.engine === filter.engine);
      if (filter.model) list = list.filter((r) => r.model === filter.model);
      return list.map((r) => ({ ...r }));
    },
    summary: () => computeSummary(records),
    getState,
  };
}

module.exports = {
  STORE_VERSION,
  OUTCOMES,
  recordKey,
  normalizeOutcome,
  createTaskOutcomeLedger,
};
