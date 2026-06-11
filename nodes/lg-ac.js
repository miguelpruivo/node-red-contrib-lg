'use strict';

const acLib = require('../lib/thinq/ac');
const C = require('../lib/thinq/constants');

const POWER_KEY = C.KEYS.POWER;
const WIND_KEY = C.KEYS.WIND_STRENGTH;
const FAN_AUTO = C.WindStrength.AUTO; // windStrength 8 = the app's "auto" fan
const COMMAND_DELAY_MS = 600;         // spacing between the sub-commands of one sequence
const QUEUE_DELAY_MS = 3000;          // debounce before each queued control op (see input handler)

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// When a control sequence powers the AC on, always run the fan at AUTO: drop
// whatever fan the request asked for and append fan=AUTO *after* the power-on
// (LG rejects settings sent while the unit is off, so the fan must come last).
function forceAutoFanOnPowerOn(commands) {
  const poweringOn = commands.some((c) => c.dataKey === POWER_KEY && c.dataValue === 1);
  if (!poweringOn) {
    return commands;
  }
  return [
    ...commands.filter((c) => c.dataKey !== WIND_KEY),
    { dataKey: WIND_KEY, dataValue: FAN_AUTO, label: `fan=${FAN_AUTO}` },
  ];
}

// Is the AC currently on? Trust a recent poller snapshot that says "on";
// otherwise confirm with a fresh read so we don't try to change mode/temp/fan
// while it is off (which LG rejects with a 400).
async function isPoweredOn(node, client, deviceId) {
  const cached = node.account.devices && node.account.devices[deviceId];
  if (cached && cached.parsed && cached.parsed.power === true) {
    return true;
  }
  try {
    const device = await client.getDevice(deviceId);
    return acLib.parseSnapshot(device && device.snapshot).power === true;
  } catch (e) {
    return false;
  }
}

module.exports = function (RED) {
  function LgAcNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.account = RED.nodes.getNode(config.account);
    node.deviceId = config.deviceId;
    node.emitPoll = config.emitPoll !== false; // emit on every poll tick, default true
    node.includeRaw = !!config.includeRaw;
    // Debounce before each queued control op. Default 3s; overridable (mainly so
    // tests can set 0). Set per-device serialization spaces concurrent messages.
    const q = Number(config.queueDelayMs);
    node.queueDelayMs = Number.isFinite(q) && q >= 0 ? q : QUEUE_DELAY_MS;

    if (!node.account) {
      node.status({ fill: 'red', shape: 'ring', text: 'no account' });
      return;
    }
    node.status({ fill: 'grey', shape: 'ring', text: 'waiting...' });

    function setAcStatus(parsed) {
      node.status({
        fill: parsed.power ? 'green' : 'grey',
        shape: 'dot',
        text: (parsed.currentTemperature != null ? parsed.currentTemperature + '°C ' : '') + (parsed.power ? 'on' : 'off'),
      });
    }

    // -------- status output (driven by the account poller) --------
    const unsubscribe = node.account.subscribe((evt) => {
      if (node.deviceId && evt.deviceId !== node.deviceId) {
        return;
      }
      const isChange = evt.changed || evt.first;
      let reason;
      if (evt.source === 'mqtt') {
        // Real-time push from LG (inherently a change). Whether MQTT runs at all
        // is controlled by the account's Real-time option, so there is no
        // per-device toggle here — if a push arrives, emit it.
        reason = 'change';
      } else {
        // Poll tick: emit every time when poll output is enabled.
        if (!node.emitPoll) {
          return;
        }
        reason = evt.first ? 'initial' : (isChange ? 'change' : 'periodic');
      }
      const msg = {
        topic: evt.deviceId,
        deviceId: evt.deviceId,
        name: evt.name,
        event: reason,
        changed: evt.changedKeys,
        payload: evt.parsed,
      };
      if (node.includeRaw) {
        msg.raw = evt.raw;
      }
      node.send(msg);
      setAcStatus(evt.parsed);
    });

    // -------- control input --------
    node.on('input', async (msg, send, done) => {
      send = send || node.send.bind(node);
      done = done || ((err) => { if (err) { node.error(err, msg); } });

      try {
        const deviceId = msg.deviceId || node.deviceId;
        if (!deviceId) {
          throw new Error('No deviceId configured or provided in msg.deviceId');
        }

        const client = node.account.getClient();
        await node.account.ensureReady();

        const request = acLib.normalizeRequest(msg.payload, msg.topic);

        // Query only
        if (request.query) {
          await client.withDeviceLock(deviceId, async () => {
            const device = await client.getDevice(deviceId);
            const parsed = acLib.parseSnapshot(device && device.snapshot);
            emitResult(node, send, msg, deviceId, parsed, device && device.snapshot, 'query');
            setAcStatus(parsed);
          });
          return done();
        }

        // Build the control commands (pure — fail fast on bad input).
        const settingCmds = acLib.buildCommands(request);
        if (!settingCmds.length) {
          throw new Error('No AC command found in payload');
        }

        // Run the whole control sequence under a per-device lock, so rapid or
        // concurrent messages to the same AC apply strictly one-at-a-time.
        // Overlapping control commands can be rejected (0103) or even power the
        // unit off; serializing makes a sequence behave like the LG app.
        await client.withDeviceLock(deviceId, async () => {
          // Debounce: wait before each queued control op so a burst of messages
          // (HomeKit/NRCHKB sends power/mode/temp/fan as separate messages)
          // applies one-at-a-time with breathing room instead of overlapping.
          // The per-device lock makes concurrent messages queue; this spaces them.
          if (node.queueDelayMs > 0) {
            node.status({ fill: 'blue', shape: 'ring', text: 'queued...' });
            await delay(node.queueDelayMs);
          }

          const turningOff = settingCmds.some((c) => c.dataKey === POWER_KEY && c.dataValue === 0);
          const turningOn = settingCmds.some((c) => c.dataKey === POWER_KEY && c.dataValue === 1);
          const nonPowerCmds = settingCmds.filter((c) => c.dataKey !== POWER_KEY);

          let commands;
          if (turningOff) {
            // Powering off: ignore any other settings in the same request.
            commands = [{ dataKey: POWER_KEY, dataValue: 0, label: 'power=0' }];
          } else if (nonPowerCmds.length && !turningOn) {
            // Changing mode/temperature/fan requires the AC to be ON first.
            const on = await isPoweredOn(node, client, deviceId);
            commands = on
              ? nonPowerCmds
              : [{ dataKey: POWER_KEY, dataValue: 1, label: 'power=1' }, ...nonPowerCmds];
          } else {
            commands = settingCmds; // power on (optionally with settings), or power-only
          }

          // Whenever this op powers the unit on, always run the fan at AUTO.
          commands = forceAutoFanOnPowerOn(commands);

          node.status({ fill: 'blue', shape: 'dot', text: 'sending...' });
          await client.sendCommands(deviceId, commands, { delayMs: COMMAND_DELAY_MS });

          // Read back the resulting state.
          const device = await client.getDevice(deviceId);
          const parsed = acLib.parseSnapshot(device && device.snapshot);
          msg.commands = commands.map((c) => c.label);
          emitResult(node, send, msg, deviceId, parsed, device && device.snapshot, 'command');
          setAcStatus(parsed);
        });
        return done();
      } catch (err) {
        node.status({ fill: 'red', shape: 'ring', text: String(err.message).slice(0, 28) });
        if (err.body) {
          node.debug('ThinQ error body: ' + JSON.stringify(err.body));
        }
        return done(err);
      }
    });

    node.on('close', () => {
      if (unsubscribe) {
        unsubscribe();
      }
    });
  }

  function emitResult(node, send, msg, deviceId, parsed, raw, event) {
    msg.payload = parsed;
    msg.deviceId = deviceId;
    msg.topic = deviceId;
    msg.event = event;
    if (node.includeRaw) {
      msg.raw = raw;
    }
    send(msg);
  }

  RED.nodes.registerType('lg-ac', LgAcNode);
};
