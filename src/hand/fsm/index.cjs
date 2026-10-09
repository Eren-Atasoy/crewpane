'use strict';

const {
  IDLE,
  MOVE,
  ARMED,
  CLICK,
  DRAG,
  SCROLL,
  ZOOM,
  PARK,
  action,
} = require('./constants.cjs');
const { defaultConfig } = require('./config.cjs');
const { ClickFSM } = require('./coreFsm.cjs');

module.exports = {
  ClickFSM,
  defaultConfig,
  action,
  IDLE,
  MOVE,
  ARMED,
  CLICK,
  DRAG,
  SCROLL,
  ZOOM,
  PARK,
};
