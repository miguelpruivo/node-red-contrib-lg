'use strict';

const acLib = require('../lib/thinq/ac');

module.exports = function (RED) {
  function LgAcNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.account = RED.nodes.getNode(config.account);
    node.deviceId = config.deviceId;

    if (!node.account) {
      node.status({ fill: 'red', shape: 'ring', text: 'no account' });
    } else {
      node.status({});
    }

    node.on('input', async (msg, send, done) => {
      send = send || node.send.bind(node);
      done = done || ((err) => { if (err) { node.error(err, msg); } });

      try {
        if (!node.account) {
          throw new Error('No LG ThinQ account configured');
        }
        const deviceId = msg.deviceId || node.deviceId;
        if (!deviceId) {
          throw new Error('No deviceId configured or provided in msg.deviceId');
        }

        const client = node.account.getClient();
        await node.account.ensureReady();

        const request = acLib.normalizeRequest(msg.payload, msg.topic);

        // Query only
        if (request.query) {
          const device = await client.getDevice(deviceId);
          const parsed = acLib.parseSnapshot(device && device.snapshot);
          msg.payload = parsed;
          msg.raw = device && device.snapshot;
          msg.deviceId = deviceId;
          send(msg);
          node.status({ fill: 'green', shape: 'dot', text: statusText(parsed) });
          return done();
        }

        // Control
        const commands = acLib.buildCommands(request);
        if (!commands.length) {
          throw new Error('No AC command found in payload');
        }
        node.status({ fill: 'blue', shape: 'dot', text: 'sending...' });
        await client.sendCommands(deviceId, commands);

        // Read back the resulting state.
        const device = await client.getDevice(deviceId);
        const parsed = acLib.parseSnapshot(device && device.snapshot);
        msg.payload = parsed;
        msg.raw = device && device.snapshot;
        msg.deviceId = deviceId;
        msg.commands = commands.map((c) => c.label);
        send(msg);
        node.status({ fill: 'green', shape: 'dot', text: commands.map((c) => c.label).join(' ') });
        return done();
      } catch (err) {
        node.status({ fill: 'red', shape: 'ring', text: String(err.message).slice(0, 24) });
        return done(err);
      }
    });
  }

  function statusText(parsed) {
    const t = parsed.currentTemperature != null ? parsed.currentTemperature + '°C ' : '';
    return t + (parsed.power ? 'on' : 'off');
  }

  RED.nodes.registerType('lg-ac', LgAcNode);
};
