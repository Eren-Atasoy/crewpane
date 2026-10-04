'use strict';
/**
 * CrewPane Domain: UI
 */
const path = require('node:path');

module.exports = {
  get overlayPreload() { return require(path.join(__dirname, "overlayPreload.js")); },
  get preload() { return require(path.join(__dirname, '..', '..', 'dist', 'preload.js')); },
  get trayPreload() { return require(path.join(__dirname, "trayPreload.js")); },
};
