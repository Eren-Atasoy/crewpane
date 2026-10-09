// ENG-04 / ENG-07 — Motor Defteri Fabrikası ve Okuma Kapıları
'use strict';

const {
  CAPABILITY_KEYS,
  SECURITY_CRITICAL_CAPABILITIES,
} = require('./schema.cjs');

/**
 * ENG-04/5 — bir pane'in YAPAMAYACAKLARI (ENG-10 rozet girdisi).
 */
function unsupportedCapabilitiesIn(d, engineId) {
  const out = [];
  if (!d) {
    const id = typeof engineId === 'string' && engineId.trim() ? engineId.trim() : '(boş)';
    for (const key of CAPABILITY_KEYS) {
      out.push({
        capability: key,
        state: 'missing',
        reason: `motor kayıtlı değil (engineRegistry'de '${id}' yok) → yetenek BEYAN EDİLMEMİŞ sayılır`,
        severity: SECURITY_CRITICAL_CAPABILITIES.includes(key) ? 'security' : 'info',
      });
    }
    return out;
  }
  for (const key of CAPABILITY_KEYS) {
    const severity = SECURITY_CRITICAL_CAPABILITIES.includes(key) ? 'security' : 'info';
    if (d[key] === null || d[key] === undefined) {
      out.push({
        capability: key,
        state: 'missing',
        reason: (d.unsupported && d.unsupported[key]) || 'gerekçe beyan edilmemiş',
        severity,
      });
    } else if (d.partial && d.partial[key]) {
      out.push({ capability: key, state: 'partial', reason: d.partial[key], severity });
    }
  }
  return out;
}

/** Tek satırlık özet (log/rozet ipucu). Eksik yoksa boş dize. */
function summarizeUnsupported(items) {
  if (!items.length) return '';
  const missing = items.filter((i) => i.state === 'missing').map((i) => i.capability);
  const partial = items.filter((i) => i.state === 'partial').map((i) => i.capability);
  const parts = [];
  if (missing.length) parts.push(`yok: ${missing.join(', ')}`);
  if (partial.length) parts.push(`kısmi: ${partial.join(', ')}`);
  return parts.join(' · ');
}

/**
 * Verilen motor haritası üstünde okuma API'si üretir (saf; haritayı KOPYALAMAZ,
 * çağıranın donmuş nesnesine bakar).
 */
function createRegistry(engines) {
  const map = engines && typeof engines === 'object' ? engines : {};

  /** Kayıtlı motor kimlikleri (defter sırası). */
  const engineIds = () => Object.keys(map);

  /** Bu kimlik kayıtlı bir motor mu? */
  const isRegisteredEngine = (engineId) =>
    typeof engineId === 'string' && Object.prototype.hasOwnProperty.call(map, engineId);

  /** Kayıt (donmuş) — bilinmeyen motor → `null` (uydurma kayıt ÜRETİLMEZ). */
  const getEngine = (engineId) => (isRegisteredEngine(engineId) ? map[engineId] : null);

  /**
   * Bir yeteneğin bu motordaki değeri. Bilinmeyen motor/alan → `null`.
   */
  const capability = (engineId, key) => {
    const d = getEngine(engineId);
    if (!d || !CAPABILITY_KEYS.includes(key)) return null;
    return d[key] === undefined ? null : d[key];
  };

  /**
   * ENG-07 L2 — TUI SİNYAL BEYANI.
   */
  const tuiSignals = (engineId) => {
    const d = capability(engineId, 'tui');
    if (!d) return null;
    return {
      measured: true,
      signalsModule: d.signalsModule || null,
      composerHints: d.composerHints === true,
      blockers: Array.isArray(d.blockers) ? [...d.blockers] : [],
      measuredVersion: d.measuredVersion || null,
    };
  };

  const unsupportedCapabilities = (engineId) => unsupportedCapabilitiesIn(getEngine(engineId), engineId);
  const unsupportedSummary = (engineId) => summarizeUnsupported(unsupportedCapabilities(engineId));

  /**
   * ENG-20 — "bu pane onay sorar mı?" TEK okuma ucu.
   */
  const engineAutonomy = (engineId) => {
    const d = getEngine(engineId);
    const a = d && d.autonomy;
    if (!a) return Object.freeze({ level: 'unknown', via: null, flags: Object.freeze([]), measured: null, why: null });
    return Object.freeze({
      level: a.level,
      via: a.via ?? null,
      flags: Object.freeze([...(a.flags || [])]),
      measured: a.measured || null,
      why: a.why || null,
    });
  };

  return {
    ENGINE_REGISTRY: map,
    engineIds,
    isRegisteredEngine,
    getEngine,
    capability,
    tuiSignals,
    engineAutonomy,
    unsupportedCapabilities,
    unsupportedSummary,
    validateRegistry: () => require('./validate.cjs').validateRegistry(map),
  };
}

module.exports = {
  createRegistry,
  unsupportedCapabilitiesIn,
  summarizeUnsupported,
};
