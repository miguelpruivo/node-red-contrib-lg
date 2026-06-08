'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Directory where this package keeps its runtime state (cached ThinQ refresh
 * tokens and webOS pairing keys). Lives under the Node-RED user dir.
 */
function storageDir(RED) {
  const base = (RED && RED.settings && RED.settings.userDir) || process.cwd();
  const dir = path.join(base, 'node-red-contrib-lg');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Adapt a Node-RED node to the simple logger interface used by the libraries.
 */
function makeLogger(node) {
  return {
    debug: (msg) => node.debug(msg),
    info: (msg) => node.log(msg),
    warn: (msg) => node.warn(msg),
    error: (msg) => node.error(msg),
  };
}

/**
 * Keys of a parsed AC snapshot we use for change detection.
 */
const AC_DIFF_KEYS = [
  'online',
  'power',
  'mode',
  'currentTemperature',
  'targetTemperature',
  'fanSpeed',
  'humidity',
];

function diffParsed(prev, next) {
  if (!prev) {
    return AC_DIFF_KEYS.slice();
  }
  const changed = [];
  for (const k of AC_DIFF_KEYS) {
    if (prev[k] !== next[k]) {
      changed.push(k);
    }
  }
  return changed;
}

module.exports = { storageDir, makeLogger, diffParsed, AC_DIFF_KEYS };
