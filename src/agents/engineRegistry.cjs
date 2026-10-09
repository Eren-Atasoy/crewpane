// ENG-04 (SPRINT-ENGINE-03) — MOTOR TANIMLAYICISI (Engine Descriptor)
//
// Decomposed in Phase 4 into:
//   • src/agents/engines/schema.cjs (enums & constants)
//   • src/agents/engines/descriptors/*.cjs (per-engine descriptors)
//   • src/agents/engines/validate.cjs (schema & auth validation)
//   • src/agents/engines/registry.cjs (registry factory & lookup methods)
'use strict';

const schema = require('./engines/schema.cjs');
const { ENGINE_REGISTRY } = require('./engines/descriptors/index.cjs');
const { createRegistry } = require('./engines/registry.cjs');
const { validateAuth, validateDescriptor, validateRegistry } = require('./engines/validate.cjs');

const defaultRegistry = createRegistry(ENGINE_REGISTRY);
const {
  engineIds,
  isRegisteredEngine,
  getEngine,
  capability,
  tuiSignals,
  engineAutonomy,
  unsupportedCapabilities,
  unsupportedSummary,
} = defaultRegistry;

module.exports = {
  ENGINE_REGISTRY,
  ...schema,
  validateAuth,
  createRegistry,
  engineIds,
  isRegisteredEngine,
  getEngine,
  capability,
  tuiSignals,
  engineAutonomy,
  unsupportedCapabilities,
  unsupportedSummary,
  validateDescriptor,
  validateRegistry,
};
