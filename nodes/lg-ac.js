'use strict';

const acLib = require('../lib/thinq/ac');
const C = require('../lib/thinq/constants');

const POWER_KEY = C.KEYS.POWER;
const WIND_KEY = C.KEYS.WIND_STRENGTH;
const FAN_AUTO = C.WindStrength.AUTO; // windStrength 8 = the app's "auto" fan
const COMMAND_DELAY_MS = 600;         // spacing between the sub-commands of one sequence
const COALESCE_MS = 600;              // collect a burst of messages this long, then send once

// Merge a parsed request into an accumulating batch: later values win per field
// (so power on→off in the same burst ends up off). `raw` is merged key-by-key so
// successive raw escape-hatch messages combine instead of replacing each other.
function mergeRequest(target, src) {
  for (const [key, value] of Object.entries(src)) {
    if (key === 'raw' && value && typeof value === 'object') {
      target.raw = Object.assign({}, target.raw, value);
    } else {
      target[key] = value;
    }
  }
  return target;
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
    // Coalescing window: collect a burst of messages for this long, merge them,
    // and send ONE ordered sequence. Default 600ms; overridable (tests set 0).
    const c = Number(config.coalesceMs);
    node.coalesceMs = Number.isFinite(c) && c >= 0 ? c : COALESCE_MS;
    node._pending = {}; // deviceId -> { request, dones, baseMsg, send, timer }

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
    // Messages are coalesced per device: a burst arriving within node.coalesceMs
    // is merged into a single request and sent as ONE ordered sequence. This makes
    // the first message react quickly (no per-message debounce), collapses an
    // NRCHKB/HomeKit burst into a single set of cloud calls, and — crucially —
    // lets power be decided after the whole burst is seen, so a vane change that
    // arrives next to a power-off can't power the unit back on. The per-device lock
    // still serializes whole bursts. Queries are not coalesced (answered at once).
    node.on('input', async (msg, send, done) => {
      send = send || node.send.bind(node);
      done = done || ((err) => { if (err) { node.error(err, msg); } });

      try {
        const deviceId = msg.deviceId || node.deviceId;
        if (!deviceId) {
          throw new Error('No deviceId configured or provided in msg.deviceId');
        }

        const request = acLib.normalizeRequest(msg.payload, msg.topic);

        // Query only — answer immediately (still serialized via the device lock).
        if (request.query) {
          const client = node.account.getClient();
          await node.account.ensureReady();
          await client.withDeviceLock(deviceId, async () => {
            const device = await client.getDevice(deviceId);
            const parsed = acLib.parseSnapshot(device && device.snapshot);
            emitResult(node, send, msg, deviceId, parsed, device && device.snapshot, 'query');
            setAcStatus(parsed);
          });
          return done();
        }

        // Validate this message up front so bad input fails fast (the real build
        // happens at flush, from the merged request).
        if (!acLib.buildCommands(request).length) {
          throw new Error('No AC command found in payload');
        }

        enqueue(deviceId, request, msg, send, done);
      } catch (err) {
        node.status({ fill: 'red', shape: 'ring', text: String(err.message).slice(0, 28) });
        return done(err);
      }
    });

    // Add a message to the per-device batch, arming the flush timer on the first.
    function enqueue(deviceId, request, msg, send, done) {
      let p = node._pending[deviceId];
      if (!p) {
        p = node._pending[deviceId] = { request: {}, dones: [], baseMsg: msg, send: send, timer: null };
        p.timer = setTimeout(() => { flush(deviceId); }, node.coalesceMs);
      }
      mergeRequest(p.request, request);
      p.dones.push(done);
      p.baseMsg = msg;
      p.send = send;
      node.status({ fill: 'blue', shape: 'ring', text: 'queued...' });
    }

    // Send the merged batch for a device as ONE ordered control sequence, under
    // the per-device lock (so a new burst queues behind one still in flight).
    async function flush(deviceId) {
      const p = node._pending[deviceId];
      if (!p) {
        return;
      }
      delete node._pending[deviceId];
      clearTimeout(p.timer);
      const { request, dones, baseMsg, send } = p;

      try {
        const client = node.account.getClient();
        await node.account.ensureReady();

        const settingCmds = acLib.buildCommands(request);
        if (!settingCmds.length) {
          dones.forEach((d) => d());
          return;
        }

        await client.withDeviceLock(deviceId, async () => {
          const turningOff = settingCmds.some((c) => c.dataKey === POWER_KEY && c.dataValue === 0);
          const turningOn = settingCmds.some((c) => c.dataKey === POWER_KEY && c.dataValue === 1);
          const nonPowerCmds = settingCmds.filter((c) => c.dataKey !== POWER_KEY);

          let commands;
          if (turningOff) {
            // Powering off wins over everything else in the burst: send power=0
            // only, so a coincident setting change can't power the unit back on.
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

          // Read back the resulting state and emit one consolidated result.
          const device = await client.getDevice(deviceId);
          const parsed = acLib.parseSnapshot(device && device.snapshot);
          baseMsg.commands = commands.map((c) => c.label);
          emitResult(node, send, baseMsg, deviceId, parsed, device && device.snapshot, 'command');
          setAcStatus(parsed);
        });
        dones.forEach((d) => d());
      } catch (err) {
        node.status({ fill: 'red', shape: 'ring', text: String(err.message).slice(0, 28) });
        if (err.body) {
          node.debug('ThinQ error body: ' + JSON.stringify(err.body));
        }
        dones.forEach((d) => d(err));
      }
    }

    node.on('close', () => {
      if (unsubscribe) {
        unsubscribe();
      }
      for (const id of Object.keys(node._pending)) {
        clearTimeout(node._pending[id].timer);
        node._pending[id].dones.forEach((d) => d());
      }
      node._pending = {};
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
