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

// On an OLED panel this is "OLED Pixel Brightness". Note that the picture
// category's own `brightness` key is Black Level, not the panel light.
const PICTURE_KEY_BRIGHTNESS = 'backlight';
// "Reduce Blue Light" in the TV's own menus. Values are the strings 'on'/'off'.
const PICTURE_KEY_BLUE_LIGHT = 'eyeComfortMode';

/**
 * Work out what an incoming payload is asking for. Power control keeps its old
 * shapes; object payloads carrying a settings/raw key take precedence.
 */
function deriveCommand(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    if ('request' in payload) {
      if (typeof payload.request !== 'string' || !payload.request.startsWith('ssap://')) {
        throw new Error('request must be an ssap:// URI');
      }
      return { type: 'request', uri: payload.request, params: payload.params || {} };
    }
    if ('luna' in payload) {
      if (typeof payload.luna !== 'string' || !payload.luna.startsWith('luna://')) {
        throw new Error('luna must be a luna:// URI');
      }
      return { type: 'luna', uri: payload.luna, params: payload.params || {} };
    }
    // Picture settings. Collected rather than returned one at a time so that
    // several in one message are all applied instead of silently dropped.
    const settings = {};
    if ('brightness' in payload) {
      const n = payload.brightness;
      if (!Number.isInteger(n) || n < 0 || n > 100) {
        throw new Error('brightness must be an integer 0-100');
      }
      settings[PICTURE_KEY_BRIGHTNESS] = n;
    }
    if ('reduceBlueLight' in payload) {
      const v = payload.reduceBlueLight;
      if (typeof v !== 'boolean') {
        throw new Error('reduceBlueLight must be true or false');
      }
      settings[PICTURE_KEY_BLUE_LIGHT] = v ? 'on' : 'off';
    }
    if ('pictureMode' in payload) {
      if (typeof payload.pictureMode !== 'string' || !payload.pictureMode) {
        throw new Error('pictureMode must be a non-empty string');
      }
      settings.pictureMode = payload.pictureMode;
    }
    if ('picture' in payload) {
      const raw = payload.picture;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('picture must be an object of settings');
      }
      Object.assign(settings, raw); // explicit keys win over the sugar above
    }
    if (Object.keys(settings).length) {
      return { type: 'picture', settings };
    }
  }
  return { type: 'power', action: deriveAction(payload) };
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
        const command = node.action === 'msg'
          ? deriveCommand(msg.payload)
          : { type: 'power', action: node.action };

        if (command.type === 'power') {
          node.status({ fill: 'blue', shape: 'dot', text: command.action + '...' });
          let result;
          if (command.action === 'on') {
            result = await node.tv.turnOn();
          } else if (command.action === 'off') {
            result = await node.tv.turnOff();
          } else if (command.action === 'toggle') {
            result = await node.tv.toggle();
          } else {
            throw new Error('Unknown TV action: ' + command.action);
          }
          msg.payload = { power: result.power, state: result.state, connected: result.connected };
        } else {
          node.status({ fill: 'blue', shape: 'dot', text: command.type + '...' });
          if (command.type === 'picture') {
            await node.tv.setPictureSettings(command.settings);
            msg.payload = { ok: true, settings: command.settings };
          } else if (command.type === 'luna') {
            msg.payload = { ok: true, ...(await node.tv.lunaSend(command.uri, command.params)) };
          } else {
            msg.payload = await node.tv.request(command.uri, command.params);
          }
        }

        msg.event = 'command';
        msg.topic = node.tv.name;
        send(msg);
        const st = node.tv.getState();
        node.status({ fill: st.power ? 'green' : 'grey', shape: 'dot', text: st.power ? 'on' : 'off' });
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
  LgTvNode._deriveCommand = deriveCommand;
};

module.exports._deriveAction = deriveAction;
module.exports._deriveCommand = deriveCommand;
