'use strict';

const step01 = require('./01-network.js');
const step02 = require('./02-instance-id.js');
const step03 = require('./03-env-profile.js');
const step04 = require('./04-app-identity.js');
const step05 = require('./05-single-instance-lock.js');
const step06 = require('./06-command-line-switches.js');
const step07 = require('./07-shell-env-scrub.js');

const STEPS = [step01, step02, step03, step04, step05, step06, step07];

/**
 * Runs all early synchronous bootstrap steps before any main services start.
 *
 * @param {object} ctx - Shared bootstrap context
 * @returns {object} ctx populated with instance, profile, lock, and shell info
 */
function runBootstrap(ctx = {}) {
  for (const step of STEPS) {
    step.run(ctx);
  }
  return ctx;
}

module.exports = {
  runBootstrap,
  STEPS,
  step01,
  step02,
  step03,
  step04,
  step05,
  step06,
  step07,
};
