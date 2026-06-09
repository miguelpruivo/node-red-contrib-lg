'use strict';

const acLib = require('../lib/thinq/ac');
const C = require('../lib/thinq/constants');

const POWER_KEY = C.KEYS.POWER;
const COMMAND_DELAY_MS = 600;

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
    node.emitPeriodic = config.emitPeriodic !== false; // default true
    node.emitOnChange = config.emitOnChange !== false; // default true
    node.includeRaw = !!config.includeRaw;

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
      if (!node.emitPeriodic && !(node.emitOnChange && isChange)) {
        return;
      }
      const reason = evt.first ? 'initial' : (isChange ? 'change' : 'periodic');
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
          const device = await client.getDevice(deviceId);
          const parsed = acLib.parseSnapshot(device && device.snapshot);
          emitResult(node, send, msg, deviceId, parsed, device && device.snapshot, 'query');
          setAcStatus(parsed);
          return done();
        }

        // Control
        const settingCmds = acLib.buildCommands(request);
        if (!settingCmds.length) {
          throw new Error('No AC command found in payload');
        }

        const turningOff = settingCmds.some((c) => c.dataKey === POWER_KEY && c.dataValue === 0);
        const turningOn = settingCmds.some((c) => c.dataKey === POWER_KEY && c.dataValue === 1);
        const nonPowerCmds = settingCmds.filter((c) => c.dataKey !== POWER_KEY);

        let commands;
        if (turningOff) {
          // Powering off: ignore any other settings in the same request — the AC
          // would reject them and they make no sense while shutting down.
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

        node.status({ fill: 'blue', shape: 'dot', text: 'sending...' });
        await client.sendCommands(deviceId, commands, { delayMs: COMMAND_DELAY_MS });

        // Read back the resulting state.
        const device = await client.getDevice(deviceId);
        const parsed = acLib.parseSnapshot(device && device.snapshot);
        msg.commands = commands.map((c) => c.label);
        emitResult(node, send, msg, deviceId, parsed, device && device.snapshot, 'command');
        setAcStatus(parsed);
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
