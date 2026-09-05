'use strict';

const path = require('path');
const { WebosTv } = require('../lib/webos/tv');
const { KEYS, describePictureWrite } = require('../lib/webos/picture');
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

// The picture keys live in lib/webos/picture.js, next to the on-screen labels
// that name them -- both need the same key strings.
// BRIGHTNESS is `backlight`, the panel light ("OLED Pixel Brightness"): the
// picture category's own `brightness` key is Black Level, not the panel light.
// BLUE_LIGHT is `eyeComfortMode`, "Reduce Blue Light" in the TV's own menus,
// whose values are the strings 'on'/'off'.
const PICTURE_KEY_BRIGHTNESS = KEYS.BRIGHTNESS;
const PICTURE_KEY_BLUE_LIGHT = KEYS.BLUE_LIGHT;

// How long the write alert stays on screen. Closing it is what executes the
// write, so this is also added latency -- see WebosTv.lunaSend.
const TOAST_MS = 2000;

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

// A settings write goes out through an alert the TV closes on its own, so a
// silently ignored or clamped value looks identical to a successful one. Read
// the keys back (a plain SSAP read, no alert needed) so the output message
// carries what the TV actually holds rather than an echo of the request. This
// is the only way to attribute a value that "changed by itself" -- Energy
// Saving can clamp the panel light, and values are stored per picture preset
// and separately for SDR/HDR, so a write can land in a slot other than the one
// being watched.
async function readBackPictureSettings(node, settings) {
  try {
    const res = await node.tv.getSystemSettings('picture', Object.keys(settings));
    return (res && res.settings) || null;
  } catch (err) {
    // Best-effort: a raw `picture` payload may carry a key the TV refuses to
    // read back, which must not turn a successful write into a failed message.
    node.debug(`Could not read picture settings back: ${err.message}`);
    return null;
  }
}

function warnOnMismatch(node, requested, actual) {
  if (!actual) {
    return;
  }
  const differing = Object.keys(requested).filter(
    (key) => key in actual && String(actual[key]) !== String(requested[key]),
  );
  if (differing.length) {
    const detail = differing.map((k) => `${k}: asked ${requested[k]}, got ${actual[k]}`).join('; ');
    node.warn(`TV did not apply the picture settings as sent (${detail})`);
  }
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
    // Not surfaced in the editor on purpose, like offGraceMs/watchdogMs: tests
    // pass 0 to skip the hold.
    node.toastMs = Number.isFinite(config.toastMs) ? config.toastMs : TOAST_MS;

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
            // The write leaves through an alert the TV shows, so label it with
            // what is being changed, in the TV's own menu language, and hold it
            // long enough to read. The hold delays the write by that long.
            const message = describePictureWrite(command.settings, await node.tv.uiLanguage());
            await node.tv.setPictureSettings(command.settings, { message, holdMs: node.toastMs });
            const actual = await readBackPictureSettings(node, command.settings);
            msg.payload = { ok: true, settings: command.settings, actual };
            warnOnMismatch(node, command.settings, actual);
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
module.exports._readBackPictureSettings = readBackPictureSettings;
module.exports._warnOnMismatch = warnOnMismatch;
module.exports._describePictureWrite = describePictureWrite;
