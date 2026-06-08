'use strict';

module.exports = function (RED) {
  function deriveAction(payload) {
    if (payload === true || payload === 1) {
      return 'on';
    }
    if (payload === false || payload === 0) {
      return 'off';
    }
    if (typeof payload === 'string') {
      const v = payload.trim().toLowerCase();
      if (['on', 'true', '1'].includes(v)) {
        return 'on';
      }
      if (['off', 'false', '0'].includes(v)) {
        return 'off';
      }
      if (v === 'toggle') {
        return 'toggle';
      }
    }
    if (payload && typeof payload === 'object' && 'power' in payload) {
      return payload.power ? 'on' : 'off';
    }
    throw new Error('Cannot derive on/off/toggle from payload');
  }

  function LgTvControlNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.tvConfig = RED.nodes.getNode(config.tv);
    node.action = config.action || 'msg';

    if (!node.tvConfig) {
      node.status({ fill: 'red', shape: 'ring', text: 'no TV' });
    }

    node.on('input', async (msg, send, done) => {
      send = send || node.send.bind(node);
      done = done || ((err) => { if (err) { node.error(err, msg); } });

      try {
        if (!node.tvConfig) {
          throw new Error('No LG TV configured');
        }
        const tv = node.tvConfig.getTv();

        let action = node.action;
        if (action === 'msg') {
          action = deriveAction(msg.payload);
        }

        node.status({ fill: 'blue', shape: 'dot', text: action + '...' });
        let result;
        if (action === 'on') {
          result = await tv.turnOn();
        } else if (action === 'off') {
          result = await tv.turnOff();
        } else if (action === 'toggle') {
          result = await tv.toggle();
        } else {
          throw new Error('Unknown TV action: ' + action);
        }

        msg.payload = result;
        send(msg);
        node.status({ fill: result.power ? 'green' : 'grey', shape: 'dot', text: result.power ? 'on' : 'off' });
        return done();
      } catch (err) {
        node.status({ fill: 'red', shape: 'ring', text: String(err.message).slice(0, 24) });
        return done(err);
      }
    });
  }

  RED.nodes.registerType('lg-tv-control', LgTvControlNode);
};
