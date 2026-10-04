'use strict';
/**
 * CrewPane Domain: MOBILE
 */
const path = require('node:path');

module.exports = {
  get mobileAuth() { return require(path.join(__dirname, "mobileAuth.cjs")); },
  get mobileDeviceStore() { return require(path.join(__dirname, "mobileDeviceStore.cjs")); },
  get mobileGateway() { return require(path.join(__dirname, "mobileGateway.js")); },
  get mobileOffice() { return require(path.join(__dirname, "mobileOffice.cjs")); },
  get mobileProbe() { return require(path.join(__dirname, "mobileProbe.cjs")); },
  get mobileReports() { return require(path.join(__dirname, "mobileReports.cjs")); },
  get mobileStartFailure() { return require(path.join(__dirname, "mobileStartFailure.cjs")); },
  get mobileTranscript() { return require(path.join(__dirname, "mobileTranscript.cjs")); },
  get mobileUploads() { return require(path.join(__dirname, "mobileUploads.cjs")); },
};
