'use strict';

const path = require('path');
const { WebosTv } = require('../lib/webos/tv');
const { storageDir, makeLogger } = require('../lib/red-helpers');

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

module.exports = function (RED) {
  function LgTvNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.host = config.host;
    node.mac = config.mac;
    node.broadcast = config.broadcast || '255.255.255.255';
    node.secure = !!config.secure;
    node.reconnect = Math.max(parseInt(config.reconnect, 10) || 5, 1) * 1000;
    node.action = config.action || 'msg';
    node.emitInitial = config.emitInitial !== false;

    if (!node.host) {
      node.status({ fill: 'red', shape: 'ring', text: 'no IP' });
      return;
    }

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

    node.tv.on('prompt', () => {
      node.warn(`Accept the pairing request on TV "${config.name || node.host}"`);
    });

    // Routine connection failures (TV off / unreachable) are expected; keep them
    // at debug level so they never surface as fatal errors.
    node.tv.on('error', (err) => {
      node.debug(`webOS TV "${config.name || node.host}": ${err && err.message ? err.message : err}`);
    });

    function emitStatus(event) {
      const st = node.tv.getState();
      node.send({
        topic: node.tv.name,
        payload: { power: st.power, state: st.state, connected: st.connected },
        event: event || (st.power ? 'on' : 'off'),
      });
      node.status({
        fill: st.power ? 'green' : 'grey',
        shape: 'dot',
        text: st.power ? 'on' : (st.connected ? 'off' : 'offline'),
      });
    }

    // -------- status output --------
    node.tv.on('powerStateChanged', () => emitStatus());

    node.tv.start();
    node.status({ fill: 'grey', shape: 'ring', text: 'connecting...' });

    if (node.emitInitial) {
      setTimeout(() => {
        const st = node.tv.getState();
        if (st.power !== null) {
          emitStatus();
        }
      }, 200);
    }

    // -------- control input --------
    node.on('input', async (msg, send, done) => {
      send = send || node.send.bind(node);
      done = done || ((err) => { if (err) { node.error(err, msg); } });

      try {
        let action = node.action;
        if (action === 'msg') {
          action = deriveAction(msg.payload);
        }

        node.status({ fill: 'blue', shape: 'dot', text: action + '...' });
        let result;
        if (action === 'on') {
          result = await node.tv.turnOn();
        } else if (action === 'off') {
          result = await node.tv.turnOff();
        } else if (action === 'toggle') {
          result = await node.tv.toggle();
        } else {
          throw new Error('Unknown TV action: ' + action);
        }

        msg.payload = { power: result.power, state: result.state, connected: result.connected };
        msg.event = 'command';
        msg.topic = node.tv.name;
        send(msg);
        node.status({ fill: result.power ? 'green' : 'grey', shape: 'dot', text: result.power ? 'on' : 'off' });
        return done();
      } catch (err) {
        node.status({ fill: 'red', shape: 'ring', text: String(err.message).slice(0, 24) });
        return done(err);
      }
    });

    node.on('close', (done) => {
      node.tv.stop();
      done();
    });
  }

  RED.nodes.registerType('lg-tv', LgTvNode);

  // Exposed for unit testing.
  LgTvNode._deriveAction = deriveAction;
};

module.exports._deriveAction = deriveAction;
