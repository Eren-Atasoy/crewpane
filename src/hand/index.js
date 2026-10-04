'use strict';
/**
 * CrewPane Domain: HAND
 */
const path = require('node:path');

module.exports = {
  get handCameraPolicy() { return require(path.join(__dirname, "handCameraPolicy.cjs")); },
  get handClickFsm() { return require(path.join(__dirname, "handClickFsm.cjs")); },
  get handControlCore() { return require(path.join(__dirname, "handControlCore.cjs")); },
  get handCursor() { return require(path.join(__dirname, "handCursor.cjs")); },
  get handDisplayRouter() { return require(path.join(__dirname, "handDisplayRouter.cjs")); },
  get handOverlayContract() { return require(path.join(__dirname, "handOverlayContract.cjs")); },
  get handPointerFilter() { return require(path.join(__dirname, "handPointerFilter.cjs")); },
  get handPoseSampler() { return require(path.join(__dirname, "handPoseSampler.cjs")); },
  get handScale() { return require(path.join(__dirname, "handScale.cjs")); },
  get handTwoHandZoom() { return require(path.join(__dirname, "handTwoHandZoom.cjs")); },
  get handZoomRouter() { return require(path.join(__dirname, "handZoomRouter.cjs")); },
};
