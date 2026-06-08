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

    const keyFile = path.join(storageDir(RED), `webos-${node.id}.key`);

    node.tv = new WebosTv({
      host: node.host,
      mac: node.mac,
      broadcast: node.broadcast,
      secure: node.secure,
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
