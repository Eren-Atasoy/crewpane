'use strict';

/**
 * src/agents/jev/report.cjs
 *
 * Jev AI — Haftalık Maliyet ve Karşılaştırma Raporu (Faz 5)
 *
 * Defterdeki gerçekleşen görevleri inceler:
 * - Jev ile gerçekleşen gerçek toplam maliyet ($)
 * - Her görev varsayılan modelle (varsayılan: claude-sonnet-5-5) çalıştırılsaydı
 *   tahmini maliyet (gerçekleşen token sayıları × varsayılan model fiyatı).
 * - Açıkça "tahmin" olarak etiketlenir.
 * - Auto modun önerilip önerilemeyeceğini ölçer (en az 14 günlük olumlu veri şartı).
 *
 * Kural 0: Saf yaprak modül (fs/electron yok, IO/now enjekte edilir).
 */

const defaultTokenCost = require('../../services/tokenCost.cjs');

const DAY_MS = 24 * 60 * 60 * 1000;

function computeEstimatedDefaultCost(entries, defaultModel, tokenCost) {
  let totalEst = 0;
  const price = tokenCost.priceFor(defaultModel);
  if (!price) return 0;

  for (const entry of entries) {
    if ((entry.tokensIn || entry.tokensOut) && Number.isFinite(entry.tokensIn)) {
      const calc = tokenCost.usdForUsage({
        inputTokens: entry.tokensIn || 0,
        outputTokens: entry.tokensOut || 0,
        cacheReadTokens: entry.cacheRead || 0,
      }, price);
      if (calc && typeof calc.usd === 'number') {
        totalEst += calc.usd;
      }
    }
  }
  return Number(totalEst.toFixed(4));
}

function computeActualCost(entries) {
  let total = 0;
  let hasPriced = false;
  for (const entry of entries) {
    if (typeof entry.costUsd === 'number' && Number.isFinite(entry.costUsd)) {
      total += entry.costUsd;
      hasPriced = true;
    }
  }
  return hasPriced ? Number(total.toFixed(4)) : null;
}

function calculateSavings(actual, estimated) {
  if (actual === null || estimated <= 0) {
    return { savingsUsd: null, savingsPct: null };
  }
  const savingsUsd = Number((estimated - actual).toFixed(4));
  const savingsPct = Number(((savingsUsd / estimated) * 100).toFixed(1));
  return { savingsUsd, savingsPct };
}

function evaluateAutoRecommendation(entries, savingsUsd, now) {
  if (!entries.length || savingsUsd === null || savingsUsd <= 0) return false;
  const oldest = entries.reduce((min, e) => (e.startedAt < min ? e.startedAt : min), now());
  const timespanDays = (now() - oldest) / DAY_MS;
  return timespanDays >= 14 && savingsUsd > 0;
}

function generateWeeklyReport(params = {}) {
  const {
    outcomeLedger,
    defaultModel = 'claude-sonnet-5-5',
    tokenCost = defaultTokenCost,
    days = 7,
    now = () => Date.now(),
  } = params;

  const since = now() - (days * DAY_MS);
  const allEntries = outcomeLedger && typeof outcomeLedger.listEntries === 'function'
    ? outcomeLedger.listEntries()
    : [];

  const periodEntries = allEntries.filter((e) => (e.startedAt || 0) >= since);
  const targetEntries = periodEntries.length > 0 ? periodEntries : allEntries;

  let passedTasks = 0;
  let failedTasks = 0;
  let abortedTasks = 0;

  for (const e of targetEntries) {
    if (e.outcome === 'passed') passedTasks++;
    else if (e.outcome === 'failed') failedTasks++;
    else if (e.outcome === 'aborted') abortedTasks++;
  }

  const totalActualCostUsd = computeActualCost(targetEntries);
  const totalEstimatedDefaultCostUsd = computeEstimatedDefaultCost(targetEntries, defaultModel, tokenCost);
  const { savingsUsd, savingsPct } = calculateSavings(totalActualCostUsd, totalEstimatedDefaultCostUsd);
  const canRecommendAuto = evaluateAutoRecommendation(allEntries, savingsUsd, now);

  return {
    periodDays: days,
    isEstimate: true,
    totalTasks: targetEntries.length,
    passedTasks,
    failedTasks,
    abortedTasks,
    defaultModel,
    totalActualCostUsd,
    totalEstimatedDefaultCostUsd,
    savingsUsd,
    savingsPct,
    canRecommendAuto,
    label: 'Jev ile toplam maliyet vs varsayılan model tahmini',
  };
}

module.exports = {
  generateWeeklyReport,
  computeEstimatedDefaultCost,
  computeActualCost,
  calculateSavings,
  evaluateAutoRecommendation,
};
