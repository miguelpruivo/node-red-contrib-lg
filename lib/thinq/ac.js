'use strict';

const { OpMode, WindStrength, KEYS } = require('./constants');

const OP_MODE_BY_VALUE = invert(OpMode);
const WIND_BY_VALUE = {
  0: 'SLOW',
  1: 'SLOW_LOW',
  2: 'LOW',
  3: 'LOW_MID',
  4: 'MID',
  5: 'MID_HIGH',
  6: 'HIGH',
  7: 'POWER',
  8: 'NATURE',
};

function invert(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[v] = k;
  }
  return out;
}

function num(snapshot, key) {
  const v = snapshot ? snapshot[key] : undefined;
  if (v === undefined || v === null || v === '') {
    return null;
  }
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

/**
 * Turn a raw ThinQ AC snapshot into a friendly, stable status object.
 *
 * Works whether the AC is on or off (current room temperature is still
 * reported by most units while idle).
 */
function parseSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return { online: false };
  }

  const opModeValue = num(snapshot, KEYS.OP_MODE);
  const windValue = num(snapshot, KEYS.WIND_STRENGTH);
  const powerValue = num(snapshot, KEYS.POWER);

  return {
    online: snapshot.online !== undefined ? !!snapshot.online : true,
    power: powerValue === null ? null : powerValue === 1,
    mode: opModeValue === null ? null : (OP_MODE_BY_VALUE[opModeValue] || String(opModeValue)),
    modeValue: opModeValue,
    currentTemperature: num(snapshot, KEYS.CURRENT_TEMP),
    targetTemperature: num(snapshot, KEYS.TARGET_TEMP),
    fanSpeed: windValue === null ? null : (WIND_BY_VALUE[windValue] || String(windValue)),
    fanSpeedValue: windValue,
    humidity: num(snapshot, KEYS.HUMIDITY),
    energyWatts: num(snapshot, KEYS.ENERGY),
    // Louver positions: 0 = off/stop, 1..N = fixed positions, 100 = swing.
    verticalVane: num(snapshot, KEYS.VANE_VERTICAL),
    horizontalVane: num(snapshot, KEYS.VANE_HORIZONTAL),
  };
}

/**
 * Resolve a vane/louver value. Accepts a number (0 = off, 1..N = fixed position,
 * 100 = swing) or the strings "off"/"stop" (0), "swing"/"auto"/"on" (100).
 * The valid fixed positions are model-dependent (see the device's model JSON).
 */
function resolveVane(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === 'number') {
    return value;
  }
  const v = String(value).trim().toLowerCase();
  if (['off', 'stop', 'none', 'closed'].includes(v)) {
    return 0;
  }
  if (['swing', 'auto', 'on', 'sweep'].includes(v)) {
    return 100;
  }
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

/**
 * Resolve an operation mode given as a string ("COOL") or a number (0).
 */
function resolveOpMode(mode) {
  if (mode === undefined || mode === null) {
    return null;
  }
  if (typeof mode === 'number') {
    return mode;
  }
  const key = String(mode).trim().toUpperCase();
  if (key in OpMode) {
    return OpMode[key];
  }
  const asNum = Number(mode);
  return Number.isNaN(asNum) ? null : asNum;
}

/**
 * Resolve a fan speed given as a string ("HIGH") or a number.
 */
function resolveWindStrength(fan) {
  if (fan === undefined || fan === null) {
    return null;
  }
  if (typeof fan === 'number') {
    return fan;
  }
  const key = String(fan).trim().toUpperCase();
  if (key in WindStrength) {
    return WindStrength[key];
  }
  const asNum = Number(fan);
  return Number.isNaN(asNum) ? null : asNum;
}

function resolvePower(value) {
  if (value === true || value === 1) {
    return 1;
  }
  if (value === false || value === 0) {
    return 0;
  }
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['on', 'true', '1', 'start'].includes(v)) {
      return 1;
    }
    if (['off', 'false', '0', 'stop'].includes(v)) {
      return 0;
    }
  }
  return null;
}

/**
 * Build the list of { dataKey, dataValue } control commands for a high level
 * request such as { power: true, mode: 'COOL', temperature: 22, fan: 'HIGH' }.
 *
 * Returns an array because some requests (e.g. power + temperature) need to be
 * sent as separate control-sync calls to the device.
 */
function buildCommands(request) {
  const commands = [];

  if ('power' in request && request.power !== undefined && request.power !== null) {
    const power = resolvePower(request.power);
    if (power === null) {
      throw new Error(`Invalid power value: ${request.power}`);
    }
    commands.push({ dataKey: KEYS.POWER, dataValue: power, label: `power=${power}` });
  }

  if ('mode' in request && request.mode !== undefined && request.mode !== null) {
    const mode = resolveOpMode(request.mode);
    if (mode === null) {
      throw new Error(`Invalid mode value: ${request.mode}`);
    }
    commands.push({ dataKey: KEYS.OP_MODE, dataValue: mode, label: `mode=${mode}` });
  }

  if ('temperature' in request && request.temperature !== undefined && request.temperature !== null) {
    const temp = Number(request.temperature);
    if (Number.isNaN(temp)) {
      throw new Error(`Invalid temperature value: ${request.temperature}`);
    }
    commands.push({ dataKey: KEYS.TARGET_TEMP, dataValue: temp, label: `target=${temp}` });
  }

  if ('fan' in request && request.fan !== undefined && request.fan !== null) {
    const fan = resolveWindStrength(request.fan);
    if (fan === null) {
      const hint = /auto/i.test(String(request.fan))
        ? ' There is no "AUTO" fan speed — pick a specific speed (AUTO is an operation mode, not a fan setting).'
        : '';
      throw new Error(
        `Unsupported fan value "${request.fan}". Use SLOW, SLOW_LOW, LOW, LOW_MID, MID, ` +
        `MID_HIGH, HIGH, POWER, NATURE, or a numeric value.${hint}`
      );
    }
    commands.push({ dataKey: KEYS.WIND_STRENGTH, dataValue: fan, label: `fan=${fan}` });
  }

  if ('verticalVane' in request && request.verticalVane !== undefined && request.verticalVane !== null) {
    const v = resolveVane(request.verticalVane);
    if (v === null) {
      throw new Error(`Invalid verticalVane value: ${request.verticalVane}`);
    }
    commands.push({ dataKey: KEYS.VANE_VERTICAL, dataValue: v, label: `vVane=${v}` });
  }

  if ('horizontalVane' in request && request.horizontalVane !== undefined && request.horizontalVane !== null) {
    const h = resolveVane(request.horizontalVane);
    if (h === null) {
      throw new Error(`Invalid horizontalVane value: ${request.horizontalVane}`);
    }
    commands.push({ dataKey: KEYS.VANE_HORIZONTAL, dataValue: h, label: `hVane=${h}` });
  }

  // Shorthand: { swing: "vertical" | "horizontal" | "both" | "off" }
  if ('swing' in request && request.swing !== undefined && request.swing !== null) {
    const s = String(request.swing).trim().toLowerCase();
    let v = null;
    let h = null;
    if (['off', 'false', '0', 'none', 'stop'].includes(s)) {
      v = 0;
      h = 0;
    } else if (['vertical', 'v', 'updown'].includes(s)) {
      v = 100;
    } else if (['horizontal', 'h', 'leftright'].includes(s)) {
      h = 100;
    } else if (['both', 'on', 'true', '1'].includes(s)) {
      v = 100;
      h = 100;
    } else {
      throw new Error(`Invalid swing value: ${request.swing}`);
    }
    if (v !== null) {
      commands.push({ dataKey: KEYS.VANE_VERTICAL, dataValue: v, label: `swingV=${v}` });
    }
    if (h !== null) {
      commands.push({ dataKey: KEYS.VANE_HORIZONTAL, dataValue: h, label: `swingH=${h}` });
    }
  }

  // Escape hatch: { raw: { "airState.<anything>": <value>, ... } } sends those
  // dataKey/dataValue pairs verbatim, for keys this node doesn't model.
  if (request.raw && typeof request.raw === 'object') {
    for (const [dataKey, dataValue] of Object.entries(request.raw)) {
      commands.push({ dataKey, dataValue, label: `${dataKey}=${dataValue}` });
    }
  }

  return commands;
}

/**
 * Normalise a Node-RED msg.payload into a high level request object.
 *
 * Accepts:
 *   true / false / "on" / "off"          -> power
 *   "status"                             -> { query: true }
 *   { power, mode, temperature, fan }    -> as-is
 *   { command: "...", value: ... }       -> single command
 */
function normalizeRequest(payload, topic) {
  if (payload === undefined || payload === null) {
    return { query: true };
  }

  if (typeof payload === 'boolean') {
    return { power: payload };
  }

  if (typeof payload === 'number') {
    // a bare number is interpreted as a target temperature
    return { temperature: payload };
  }

  if (typeof payload === 'string') {
    const v = payload.trim().toLowerCase();
    if (v === 'status' || v === 'query' || v === 'get') {
      return { query: true };
    }
    const power = resolvePower(v);
    if (power !== null) {
      return { power: power === 1 };
    }
    // maybe a mode name
    if (resolveOpMode(v) !== null) {
      return { mode: v };
    }
    throw new Error(`Unknown AC command string: "${payload}"`);
  }

  if (typeof payload === 'object') {
    if (payload.query || topic === 'status') {
      return { query: true, ...payload };
    }
    return payload;
  }

  throw new Error('Unsupported AC payload type');
}

module.exports = {
  parseSnapshot,
  buildCommands,
  normalizeRequest,
  resolveOpMode,
  resolveWindStrength,
  resolvePower,
  resolveVane,
};
