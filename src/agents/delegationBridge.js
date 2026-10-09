'use strict';

/**
 * ADP-050 (ADR-004 §A1) — delegation bridge TRANSPORT facade.
 * Modularized under ./bridge/ (Phase 4.5).
 * Re-exports the 28 canonical exports with 100% backward compatibility.
 */
module.exports = require('./bridge/index.cjs');
