'use strict';

const path = require('path');
const { WebosTv } = require('../lib/webos/tv');
const { storageDir, makeLogger } = require('../lib/red-helpers');

module.exports = function (RED) {
  function LgTvNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.host = config.host;
    node.mac = config.mac;
    node.broadcast = config.broadcast || '255.255.255.255';
    node.secure = !!config.secure;
    // Retry interval while the TV is off/unreachable (seconds -> ms, min 1s).
    // This controls how quickly an OFF -> ON transition is detected.
    node.reconnect = Math.max(parseInt(config.reconnect, 10) || 5, 1) * 1000;

    const keyFile = path.join(storageDir(RED), `webos-${node.id}.key`);

    node.tv = new WebosTv({
      host: node.host,
      mac: node.mac,
      broadcast: node.broadcast,
      secure: node.secure,
      reconnect: node.reconnect,
      name: config.name || node.host,
      keyFile,
      logger: makeLogger(node),
    });

    node.getTv = () => node.tv;

    node.tv.on('prompt', () => {
      node.warn(`Accept the pairing request on TV "${config.name || node.host}"`);
    });

    node.tv.start();

    node.on('close', (done) => {
      node.tv.stop();
      done();
    });
  }

  RED.nodes.registerType('lg-tv', LgTvNode);
};
