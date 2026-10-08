'use strict';

const engineRegistry = require('./engineRegistry.cjs');

/**
 * ENG-10 — YETENEK MATRİSİNİN DEFTERİ (+ e2e SAHTE-MOTOR DİKİŞİ)
 * Rozetlerin ÜÇ hâlini (tam / kısmi / yok) gerçek bir kısıtlı motor beklemeden
 * ölçebilmek için defter enjekte edilebilir olmalı. Dikiş ENG-08'in AUTH dikişiyle
 * AYNI disiplindedir ve aynı env adlarını kullanır:
 *   • açık opt-in bayrağı ŞART (ambient env tek başına yetmez),
 *   • gelen her kayıt ürünün KENDİ şemasından geçer (`validateRegistry`) — geçmeyen
 *     kayıt YÜKLENMEZ (fail-closed).
 */
function parseFakeDescriptors(env) {
  if (!env || env.CREWPANE_FAKE_ENGINE_DESCRIPTORS !== '1') return null;
  try {
    const raw = JSON.parse(String(env.CREWPANE_FAKE_ENGINE_DESCRIPTORS_JSON || '{}'));
    return (raw && typeof raw === 'object') ? raw : null;
  } catch {
    return null;
  }
}

function mergeFakeDescriptors(baseMap, raw, logLine, registry) {
  let added = 0;
  for (const [id, d] of Object.entries(raw)) {
    if (!d || typeof d !== 'object' || baseMap[id]) continue; // gerçek kaydı EZMEZ
    const verdict = registry.validateRegistry({ [id]: d });
    if (!verdict || verdict.ok !== true) {
      const errs = (verdict && verdict.errors && verdict.errors[id]) || [];
      if (typeof logLine === 'function') {
        logLine(`engine:capabilityMatrix fake descriptor REDDEDİLDİ id=${id} errors=${errs.length}: ${errs.slice(0, 3).join(' · ')}`);
      }
      continue;
    }
    baseMap[id] = d;
    added += 1;
  }
  return added;
}

function getCapabilityRegistry(opts = {}) {
  const env = opts.env || process.env;
  const logLine = opts.logLine;
  const registry = opts.registry || engineRegistry;

  const raw = parseFakeDescriptors(env);
  if (!raw) return registry;

  const map = {};
  for (const id of registry.engineIds()) map[id] = registry.getEngine(id);
  const added = mergeFakeDescriptors(map, raw, logLine, registry);
  if (!added) return registry;

  if (typeof logLine === 'function') {
    logLine(`engine:capabilityMatrix fake descriptors loaded count=${added}`);
  }
  return registry.createRegistry(map);
}

// Singleton / function interface matching main.js usage
function capabilityRegistry(opts) {
  return getCapabilityRegistry(opts);
}

capabilityRegistry.getCapabilityRegistry = getCapabilityRegistry;
capabilityRegistry.parseFakeDescriptors = parseFakeDescriptors;
capabilityRegistry.mergeFakeDescriptors = mergeFakeDescriptors;

module.exports = capabilityRegistry;
