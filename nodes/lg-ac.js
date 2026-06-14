'use strict';

const acLib = require('../lib/thinq/ac');
const C = require('../lib/thinq/constants');

const POWER_KEY = C.KEYS.POWER;
const WIND_KEY = C.KEYS.WIND_STRENGTH;
const FAN_AUTO = C.WindStrength.AUTO; // windStrength 8 = the app's "auto" fan
const COMMAND_DELAY_MS = 600;         // spacing between the sub-commands of one sequence
// Collect a burst of messages this long, then send once. Kept short so a lone
// command reacts almost immediately; it only needs to be long enough to merge the
// separate messages of one user action (e.g. power + mode + temp from HomeKit).
// Power-safety no longer depends on this window — the "settings only apply while
// on" rule in flush() makes a power-off final regardless of timing.
const COALESCE_MS = 150;

// Scalar settings we can safely skip when the device is already at the requested
// value (every command makes the AC beep, so dropping no-ops cuts the beeping and
// the cloud calls down to genuine changes). Power is handled separately; `raw` and
// anything else is always sent — we can't know its current value reliably.
const DEDUPE_KEYS = new Set([
  C.KEYS.OP_MODE,
  C.KEYS.TARGET_TEMP,
  C.KEYS.WIND_STRENGTH,
  C.KEYS.VANE_VERTICAL,
  C.KEYS.VANE_HORIZONTAL,
]);

// True when this command would set a value the device already holds. Conservative:
// only the modelled scalar keys, and only when the snapshot actually reports the
// key (a missing key means "unknown" → send it, never skip on uncertainty).
function isNoOp(cmd, snap) {
  if (!DEDUPE_KEYS.has(cmd.dataKey)) {
    return false;
  }
  const current = snap ? snap[cmd.dataKey] : undefined;
  if (current === undefined || current === null || current === '') {
    return false;
  }
  return Number(current) === Number(cmd.dataValue);
}

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

// The device's current raw snapshot, used both to decide power state and to drop
// no-op commands. Trust a cached snapshot that says "on" (fast, no network); if it
// is missing or says "off", confirm with a fresh read — a stale "off" would
// otherwise cause a needless power-on (+ fan reset) and let us wrongly skip a
// settings change. The poller and real-time MQTT keep the cache fresh.
async function currentSnapshot(node, client, deviceId) {
  const cached = node.account.devices && node.account.devices[deviceId];
  if (cached && cached.raw && Number(cached.raw[POWER_KEY]) === 1) {
    return cached.raw;
  }
  try {
    const device = await client.getDevice(deviceId);
    return (device && device.snapshot) || (cached && cached.raw) || {};
  } catch (e) {
    return (cached && cached.raw) || {};
  }
}

// Refresh the account's shared cache after we change the device, so a rapid
// follow-up burst dedupes against the truth instead of pre-command state.
function cacheSnapshot(node, deviceId, raw) {
  if (!node.account.devices || !raw) {
    return;
  }
  const prev = node.account.devices[deviceId];
  node.account.devices[deviceId] = {
    device: (prev && prev.device) || { deviceId, alias: deviceId },
    parsed: acLib.parseSnapshot(raw),
    raw,
  };
}

module.exports = function (RED) {
  function LgAcNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.account = RED.nodes.getNode(config.account);
    node.deviceId = config.deviceId;
    node.emitPoll = config.emitPoll !== false; // emit on every poll tick, default true
    node.includeRaw = !!config.includeRaw;
    // Trailing-coalesce window (ms): after the leading flush, messages that arrive
    // within this window are merged and sent once. Overridable (tests set 0).
    const c = Number(config.coalesceMs);
    node.coalesceMs = Number.isFinite(c) && c >= 0 ? c : COALESCE_MS;
    node._pending = {}; // deviceId -> { request, dones, baseMsg, send }
    node._busy = {};    // deviceId -> timer handle | true (flush scheduled/in-flight)

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
    // Leading-edge coalescing per device: the first message of an idle device is
    // flushed on the next tick (~0ms — a lone command reacts immediately), with
    // messages that arrive in the same tick merged into it. Anything that arrives
    // while that flush is in flight, or within the trailing node.coalesceMs window
    // after it, is merged and sent once more. The per-device lock serializes
    // flushes; power-safety comes from the "settings only apply while on" rule in
    // flush() (not from waiting), so firing early is safe. Queries are not queued.
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

    // Add a message to the per-device batch. If the device is idle, schedule the
    // leading flush on the next tick (~0ms); same-tick messages merge into it.
    // While a flush is scheduled/in-flight, just accumulate — the trailing window
    // will pick this up.
    function enqueue(deviceId, request, msg, send, done) {
      let p = node._pending[deviceId];
      if (!p) {
        p = node._pending[deviceId] = { request: {}, dones: [], baseMsg: msg, send: send };
      }
      mergeRequest(p.request, request);
      p.dones.push(done);
      p.baseMsg = msg;
      p.send = send;
      node.status({ fill: 'blue', shape: 'ring', text: 'queued...' });
      if (!node._busy[deviceId]) {
        node._busy[deviceId] = setTimeout(() => { flush(deviceId); }, 0);
      }
    }

    // Send the current batch for a device as ONE ordered control sequence, under
    // the per-device lock. Re-arms a trailing window afterwards so stragglers are
    // coalesced into a single follow-up; an empty window returns the device to idle.
    async function flush(deviceId) {
      const p = node._pending[deviceId];
      if (!p) {
        node._busy[deviceId] = false; // trailing window elapsed with nothing new
        return;
      }
      node._pending[deviceId] = null;
      node._busy[deviceId] = true; // in flight
      const { request, dones, baseMsg, send } = p;

      try {
        const client = node.account.getClient();
        await node.account.ensureReady();

        const settingCmds = acLib.buildCommands(request);
        if (!settingCmds.length) {
          dones.forEach((d) => d()); // finally still re-arms the trailing window
          return;
        }

        await client.withDeviceLock(deviceId, async () => {
          // Current state drives both the power decision and no-op skipping.
          const snap = await currentSnapshot(node, client, deviceId);
          const currentlyOn = Number(snap[POWER_KEY]) === 1;

          const turningOff = settingCmds.some((c) => c.dataKey === POWER_KEY && c.dataValue === 0);
          const turningOn = settingCmds.some((c) => c.dataKey === POWER_KEY && c.dataValue === 1);
          // Drop settings the device already holds — fewer cloud calls, fewer beeps.
          const nonPowerCmds = settingCmds
            .filter((c) => c.dataKey !== POWER_KEY)
            .filter((c) => !isNoOp(c, snap));

          let commands;
          if (turningOff) {
            // Power off wins over everything else; drop all settings. Already off → nothing.
            commands = currentlyOn ? [{ dataKey: POWER_KEY, dataValue: 0, label: 'power=0' }] : [];
          } else if (turningOn) {
            // Explicit power-on: turn on if needed, then apply the (changed) settings.
            commands = currentlyOn
              ? nonPowerCmds
              : [{ dataKey: POWER_KEY, dataValue: 1, label: 'power=1' }, ...nonPowerCmds];
          } else if (currentlyOn) {
            // Unit on, no power command: apply the (changed) settings.
            commands = nonPowerCmds;
          } else {
            // Unit off and not being turned on: discard settings. A setting only takes
            // effect while on and never auto-powers the unit, so a power-off is final —
            // a setting arriving right after it (even in a separate, immediate flush) is
            // dropped instead of switching the AC back on.
            commands = [];
          }

          // Whenever this op powers the unit on, always run the fan at AUTO.
          commands = forceAutoFanOnPowerOn(commands);

          // Read back the resulting state and emit one consolidated result. When
          // nothing needed sending, report current state without a cloud call.
          let raw = snap;
          if (commands.length) {
            node.status({ fill: 'blue', shape: 'dot', text: 'sending...' });
            await client.sendCommands(deviceId, commands, { delayMs: COMMAND_DELAY_MS });
            const device = await client.getDevice(deviceId);
            raw = (device && device.snapshot) || raw;
            cacheSnapshot(node, deviceId, raw);
          }
          const parsed = acLib.parseSnapshot(raw);
          baseMsg.commands = commands.map((c) => c.label);
          emitResult(node, send, baseMsg, deviceId, parsed, raw, 'command');
          setAcStatus(parsed);
        });
        dones.forEach((d) => d());
      } catch (err) {
        node.status({ fill: 'red', shape: 'ring', text: String(err.message).slice(0, 28) });
        if (err.body) {
          node.debug('ThinQ error body: ' + JSON.stringify(err.body));
        }
        dones.forEach((d) => d(err));
      } finally {
        // Trailing edge: flush anything queued during this send after the window
        // (an empty window then returns the device to idle via the early return).
        node._busy[deviceId] = setTimeout(() => { flush(deviceId); }, node.coalesceMs);
      }
    }

    node.on('close', () => {
      if (unsubscribe) {
        unsubscribe();
      }
      for (const id of Object.keys(node._busy)) {
        if (node._busy[id] && node._busy[id] !== true) {
          clearTimeout(node._busy[id]);
        }
      }
      for (const id of Object.keys(node._pending)) {
        if (node._pending[id]) {
          node._pending[id].dones.forEach((d) => d());
        }
      }
      node._pending = {};
      node._busy = {};
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
