'use strict';

const infraServices = require('./infraServices.cjs');
const devServices = require('./devServices.cjs');
const collabServices = require('./collabServices.cjs');
const commServices = require('./commServices.cjs');
const aiServices = require('./aiServices.cjs');

/**
 * ADP-584 / ADP-588 / BR-03 / INT-0-E / INT-1 / INT-2 / INT-3 / INT-4
 * Servis kataloğu: TEK doğruluk kaynağı.
 *
 * @type {Record<string, import('../index.cjs').IntegrationEntry>}
 */
const CATALOG = {
  supabase: infraServices.supabase,
  github: devServices.github,
  sentry: devServices.sentry,
  stripe: commServices.stripe,
  posthog: devServices.posthog,
  hostinger: infraServices.hostinger,
  coolify: infraServices.coolify,
  postgres: infraServices.postgres,
  vercel: infraServices.vercel,
  gitlab: devServices.gitlab,
  linear: collabServices.linear,
  netlify: infraServices.netlify,
  resend: commServices.resend,
  shopify: commServices.shopify,
  n8n: collabServices.n8n,
  metabase: collabServices.metabase,
  notion: collabServices.notion,
  figma: collabServices.figma,
  discord: commServices.discord,
  slack: commServices.slack,
  fal: aiServices.fal,
  elevenlabs: aiServices.elevenlabs,
};

module.exports = {
  CATALOG,
};
