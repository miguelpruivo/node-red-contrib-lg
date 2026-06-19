'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');

// ---- Minimal Node-RED runtime mock ----------------------------------------

function makeRED() {
  const registered = {};
  const nodeRegistry = {};
  const adminRoutes = { get: [], post: [] };

  const RED = {
    settings: { userDir: fs.mkdtempSync(path.join(os.tmpdir(), 'nr-lg-')) },
    nodes: {
      createNode(node, config) {
        EventEmitter.call(node);
        Object.assign(node, EventEmitter.prototype);
        EventEmitter.call(node);
        node.id = config.id || 'n' + Math.random().toString(16).slice(2);
        node.name = config.name;
        node.credentials = config.credentials || {};
        node.status = () => {};
        node.send = (m) => { node._sent = node._sent || []; node._sent.push(m); };
        node.log = () => {};
        node.warn = () => {};
        node.error = () => {};
        node.debug = () => {};
        node.trace = () => {};
      },
      registerType(name, ctor, opts) {
        registered[name] = { ctor, opts };
      },
      getNode(id) {
        return nodeRegistry[id] || null;
      },
      _register(id, node) {
        nodeRegistry[id] = node;
      },
    },
    httpAdmin: {
      get(route) { adminRoutes.get.push(route); },
      post(route) { adminRoutes.post.push(route); },
    },
    auth: {
      needsPermission() {
        return (req, res, next) => next && next();
      },
    },
    util: {},
    validators: { number: () => () => true },
  };

  function instantiate(name, config) {
    const entry = registered[name];
    assert.ok(entry, `type ${name} is registered`);
    const node = new entry.ctor(config);
    return node;
  }

  return { RED, registered, adminRoutes, instantiate };
}

// ---- Load every node module ------------------------------------------------

const NODE_FILES = [
  ['../nodes/lg-account.js', 'lg-account'],
  ['../nodes/lg-ac.js', 'lg-ac'],
  ['../nodes/lg-tv.js', 'lg-tv'],
];

// A stub lg-account config node that the merged lg-ac node can subscribe to.
function stubAccount(opts = {}) {
  const client = opts.client || {};
  // The real client serializes per device; the stub just runs the fn inline.
  if (!client.withDeviceLock) {
    client.withDeviceLock = (deviceId, fn) => fn();
  }
  return {
    devices: opts.devices || {},
    ensureReady: async () => {},
    subscribe: () => () => {}, // returns an unsubscribe fn
    getClient: () => client,
  };
}

test('all node modules register their type', () => {
  const { RED, registered, adminRoutes } = makeRED();
  for (const [file] of NODE_FILES) {
    const mod = require(file);
    assert.strictEqual(typeof mod, 'function', `${file} exports a function`);
    mod(RED);
  }
  for (const [, type] of NODE_FILES) {
    assert.ok(registered[type], `${type} registered`);
  }
  // account node should expose its admin endpoints
  assert.ok(adminRoutes.get.some((r) => r.includes('/lg-account/')), 'device-list endpoint registered');
  assert.ok(adminRoutes.post.some((r) => r.includes('/lg-account/token')), 'token endpoint registered');
});

test('lg-account node constructs and caches a client', () => {
  const { RED, instantiate } = makeRED();
  require('../nodes/lg-account.js')(RED);
  const node = instantiate('lg-account', {
    id: 'acc1',
    country: 'PT',
    language: 'en-US',
    pollInterval: 30,
    credentials: { username: 'u', password: 'p' },
  });
  assert.ok(node.getClient(), 'client created');
  assert.strictEqual(typeof node.subscribe, 'function');
  // close cleanly
  node.emit('close', () => {});
});

test('lg-ac control node sends a query through a stub account', async () => {
  const { RED, instantiate } = makeRED();
  require('../nodes/lg-ac.js')(RED);

  const fakeSnapshot = { 'airState.operation': 1, 'airState.tempState.current': 23 };
  RED.nodes._register('acc1', stubAccount({
    client: { getDevice: async () => ({ snapshot: fakeSnapshot }) },
  }));

  const node = instantiate('lg-ac', { id: 'ac1', account: 'acc1', deviceId: 'dev1' });

  await new Promise((resolve, reject) => {
    node.emit('input', { payload: 'status' }, (m) => { node._sent = (node._sent || []).concat(m); }, (err) => {
      if (err) { reject(err); } else { resolve(); }
    });
  });

  assert.ok(node._sent && node._sent.length, 'a message was sent');
  const out = node._sent[node._sent.length - 1];
  assert.strictEqual(out.payload.power, true);
  assert.strictEqual(out.payload.currentTemperature, 23);
});

function runAcControl(payload, getDeviceSnapshot) {
  const { RED, instantiate } = makeRED();
  require('../nodes/lg-ac.js')(RED);
  const sent = [];
  RED.nodes._register('accx', stubAccount({
    client: {
      getDevice: async () => ({ snapshot: getDeviceSnapshot }),
      sendCommands: async (id, cmds) => { sent.push(cmds); return []; },
    },
  }));
  const node = instantiate('lg-ac', { id: 'acx', account: 'accx', deviceId: 'dev1', coalesceMs: 0 });
  return new Promise((resolve, reject) => {
    node.emit('input', { payload }, () => {}, (err) => {
      if (err) { reject(err); } else { resolve(sent[0] || []); }
    });
  });
}

test('lg-ac discards a settings change sent while the AC is off (no auto power-on)', async () => {
  const cmds = await runAcControl({ temperature: 23 }, { 'airState.operation': 0, 'airState.tempState.target': 22 });
  assert.strictEqual(cmds.length, 0, 'settings only apply while on — the AC is not switched on for them');
});

test('lg-ac applies settings sent together with an explicit power-on (while off)', async () => {
  const cmds = await runAcControl({ power: true, temperature: 23 }, { 'airState.operation': 0, 'airState.tempState.target': 22 });
  assert.strictEqual(cmds[0].dataKey, 'airState.operation');
  assert.strictEqual(cmds[0].dataValue, 1);
  assert.ok(cmds.some((c) => c.dataKey === 'airState.tempState.target' && c.dataValue === 23));
});

test('lg-ac does NOT prepend power-on when AC is already on', async () => {
  const cmds = await runAcControl({ temperature: 22 }, { 'airState.operation': 1 });
  assert.ok(!cmds.some((c) => c.dataKey === 'airState.operation'));
  assert.strictEqual(cmds[0].dataKey, 'airState.tempState.target');
});

test('lg-ac powering off ignores other settings in the same request', async () => {
  const cmds = await runAcControl({ power: false, temperature: 22 }, { 'airState.operation': 1 });
  assert.strictEqual(cmds.length, 1);
  assert.strictEqual(cmds[0].dataKey, 'airState.operation');
  assert.strictEqual(cmds[0].dataValue, 0);
});

test('lg-ac forces fan to AUTO when powering on', async () => {
  const cmds = await runAcControl({ power: true }, { 'airState.operation': 0 });
  assert.strictEqual(cmds[0].dataKey, 'airState.operation');
  assert.strictEqual(cmds[0].dataValue, 1);
  // fan=AUTO (windStrength 8) appended after the power-on.
  const fan = cmds[cmds.length - 1];
  assert.strictEqual(fan.dataKey, 'airState.windStrength');
  assert.strictEqual(fan.dataValue, 8);
});

test('lg-ac power-on overrides an explicit fan with AUTO', async () => {
  const cmds = await runAcControl({ power: true, fan: 'HIGH' }, { 'airState.operation': 0 });
  const fans = cmds.filter((c) => c.dataKey === 'airState.windStrength');
  assert.strictEqual(fans.length, 1, 'only one fan command');
  assert.strictEqual(fans[0].dataValue, 8, 'forced to AUTO, not HIGH');
});

test('lg-ac does NOT touch the fan when already on (no power-on)', async () => {
  const cmds = await runAcControl({ temperature: 22 }, { 'airState.operation': 1 });
  assert.ok(!cmds.some((c) => c.dataKey === 'airState.windStrength'), 'no forced fan command');
});

test('lg-ac powering off does not add a fan command', async () => {
  const cmds = await runAcControl({ power: false }, { 'airState.operation': 1 });
  assert.ok(!cmds.some((c) => c.dataKey === 'airState.windStrength'), 'no fan on power-off');
});

test('lg-ac skips a setting already at the requested value (no command, no beep)', async () => {
  const cmds = await runAcControl({ temperature: 22 },
    { 'airState.operation': 1, 'airState.tempState.target': 22 });
  assert.strictEqual(cmds.length, 0, 'nothing sent when temp already 22');
});

test('lg-ac still sends a setting that actually changes', async () => {
  const cmds = await runAcControl({ temperature: 23 },
    { 'airState.operation': 1, 'airState.tempState.target': 22 });
  assert.strictEqual(cmds.length, 1);
  assert.strictEqual(cmds[0].dataKey, 'airState.tempState.target');
  assert.strictEqual(cmds[0].dataValue, 23);
});

test('lg-ac only sends the fields that changed in a mixed request', async () => {
  const cmds = await runAcControl({ temperature: 22, mode: 'COOL', fan: 'HIGH' },
    { 'airState.operation': 1, 'airState.tempState.target': 22, 'airState.opMode': 0, 'airState.windStrength': 2 });
  // temp (22) and mode (COOL=0) already match → dropped; only fan HIGH (6) sent.
  assert.deepStrictEqual(cmds.map((c) => [c.dataKey, c.dataValue]), [['airState.windStrength', 6]]);
});

test('lg-ac redundant power-on while already on does nothing', async () => {
  const cmds = await runAcControl({ power: true }, { 'airState.operation': 1 });
  assert.strictEqual(cmds.length, 0, 'no power-on, no forced fan, no beep');
});

test('lg-ac power-off while already off does nothing', async () => {
  const cmds = await runAcControl({ power: false }, { 'airState.operation': 0 });
  assert.strictEqual(cmds.length, 0);
});

test('lg-ac no-op setting while off does NOT power the unit on', async () => {
  const cmds = await runAcControl({ temperature: 22 },
    { 'airState.operation': 0, 'airState.tempState.target': 22 });
  assert.strictEqual(cmds.length, 0, 'already at 22 → no spurious power-on');
});

test('lg-ac turns the panel display off while the AC is on', async () => {
  const cmds = await runAcControl({ display: false },
    { 'airState.operation': 1, 'airState.lightingState.displayControl': 0 });
  assert.deepStrictEqual(cmds.map((c) => [c.dataKey, c.dataValue]),
    [['airState.lightingState.displayControl', 1]]);
});

test('lg-ac discards a display change while the AC is off (display only applies while on)', async () => {
  const cmds = await runAcControl({ display: false },
    { 'airState.operation': 0, 'airState.lightingState.displayControl': 0 });
  assert.strictEqual(cmds.length, 0, 'display is on-only; the AC is not switched on for it');
});

test('lg-ac applies display together with an explicit power-on', async () => {
  const cmds = await runAcControl({ power: true, display: false },
    { 'airState.operation': 0, 'airState.lightingState.displayControl': 0 });
  assert.strictEqual(cmds[0].dataValue, 1, 'power-on first');
  assert.ok(cmds.some((c) => c.dataKey === 'airState.lightingState.displayControl' && c.dataValue === 1),
    'display=off applied after the power-on');
});

test('lg-ac skips a display change already at the requested value (no beep)', async () => {
  const cmds = await runAcControl({ display: false },
    { 'airState.operation': 1, 'airState.lightingState.displayControl': 1 });
  assert.strictEqual(cmds.length, 0, 'display already off → nothing sent');
});

// Send several messages to one node in the same tick; they coalesce into a single
// flush. Resolves once every message's done() has fired.
function runAcBurst(payloads, getDeviceSnapshot) {
  const { RED, instantiate } = makeRED();
  require('../nodes/lg-ac.js')(RED);
  const sent = [];
  RED.nodes._register('accx', stubAccount({
    client: {
      getDevice: async () => ({ snapshot: getDeviceSnapshot }),
      sendCommands: async (id, cmds) => { sent.push(cmds); return []; },
    },
  }));
  const node = instantiate('lg-ac', { id: 'acx', account: 'accx', deviceId: 'dev1', coalesceMs: 0 });
  return new Promise((resolve, reject) => {
    let remaining = payloads.length;
    for (const payload of payloads) {
      node.emit('input', { payload }, () => {}, (err) => {
        if (err) { return reject(err); }
        if (--remaining === 0) { resolve({ sent, commands: sent[0] || [] }); }
      });
    }
  });
}

test('lg-ac coalesces a burst into a single control sequence', async () => {
  const { sent, commands } = await runAcBurst(
    [{ temperature: 22 }, { fan: 'HIGH' }], { 'airState.operation': 1 });
  assert.strictEqual(sent.length, 1, 'one sequence for the whole burst');
  assert.ok(commands.some((c) => c.dataKey === 'airState.tempState.target' && c.dataValue === 22));
  assert.ok(commands.some((c) => c.dataKey === 'airState.windStrength' && c.dataValue === 6));
});

test('lg-ac power-off wins over a coincident vane change (no re-power)', async () => {
  const { sent, commands } = await runAcBurst(
    [{ verticalVane: 2 }, { power: false }], { 'airState.operation': 1 });
  assert.strictEqual(sent.length, 1, 'one sequence');
  assert.strictEqual(commands.length, 1, 'power-off only — no vane, no power-on');
  assert.strictEqual(commands[0].dataKey, 'airState.operation');
  assert.strictEqual(commands[0].dataValue, 0);
});

test('lg-ac last power value wins within a burst (on then off => off)', async () => {
  const { commands } = await runAcBurst(
    [{ power: true }, { power: false }], { 'airState.operation': 1 });
  assert.strictEqual(commands.length, 1);
  assert.strictEqual(commands[0].dataValue, 0, 'ends up off');
});

test('lg-ac coalesced power-on + setting still forces fan AUTO', async () => {
  const { commands } = await runAcBurst(
    [{ power: true }, { temperature: 22 }], { 'airState.operation': 0 });
  assert.strictEqual(commands[0].dataKey, 'airState.operation');
  assert.strictEqual(commands[0].dataValue, 1, 'powers on first');
  assert.ok(commands.some((c) => c.dataKey === 'airState.tempState.target' && c.dataValue === 22));
  assert.ok(commands.some((c) => c.dataKey === 'airState.windStrength' && c.dataValue === 8), 'fan AUTO');
});

// Leading-edge driver: a stateful stub whose getDevice reflects commands already
// sent (so power state changes as the real device would), and an emit() that
// resolves when that message's done() fires.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function statefulNode(initialSnapshot) {
  const { RED, instantiate } = makeRED();
  require('../nodes/lg-ac.js')(RED);
  const snapshot = Object.assign({}, initialSnapshot);
  const sent = [];
  RED.nodes._register('accs', stubAccount({
    client: {
      getDevice: async () => ({ snapshot: Object.assign({}, snapshot) }),
      sendCommands: async (id, cmds) => {
        sent.push(cmds);
        for (const c of cmds) { snapshot[c.dataKey] = c.dataValue; }
        return [];
      },
    },
  }));
  const node = instantiate('lg-ac', { id: 'acs', account: 'accs', deviceId: 'dev1', coalesceMs: 5 });
  const emit = (payload) => new Promise((resolve, reject) => {
    node.emit('input', { payload }, () => {}, (err) => (err ? reject(err) : resolve()));
  });
  return { node, sent, snapshot, emit };
}

test('lg-ac leading-edge: separate (gapped) commands each fire their own sequence', async () => {
  const h = statefulNode({ 'airState.operation': 1 });
  await h.emit({ temperature: 23 });
  await sleep(15);
  await h.emit({ temperature: 24 });
  await sleep(15);
  assert.deepStrictEqual(h.sent.map((s) => s.map((c) => [c.dataKey, c.dataValue])), [
    [['airState.tempState.target', 23]],
    [['airState.tempState.target', 24]],
  ]);
});

test('lg-ac leading-edge: a setting arriving after a power-off is dropped (stays off)', async () => {
  const h = statefulNode({ 'airState.operation': 1, 'airState.tempState.target': 22 });
  await h.emit(false);          // power off
  await sleep(15);              // window elapses; device is now off
  await h.emit({ verticalVane: 2 }); // setting while off → discarded, no re-power
  await sleep(15);
  assert.strictEqual(h.sent.length, 1, 'only the power-off was sent');
  assert.strictEqual(h.sent[0][0].dataKey, 'airState.operation');
  assert.strictEqual(h.sent[0][0].dataValue, 0);
  assert.strictEqual(Number(h.snapshot['airState.operation']), 0, 'still off');
});

test('lg-ac always forwards real-time mqtt pushes (account-controlled, even with Poll off)', () => {
  const { RED, instantiate } = makeRED();
  require('../nodes/lg-ac.js')(RED);

  let handler = null;
  const acct = stubAccount();
  acct.subscribe = (h) => { handler = h; return () => {}; };
  RED.nodes._register('acc1', acct);

  const node = instantiate('lg-ac', { id: 'ac1', account: 'acc1', deviceId: 'dev1', emitPoll: false });

  // A real-time push (source 'mqtt') is emitted regardless of the Poll setting.
  handler({
    deviceId: 'dev1', name: 'AC', source: 'mqtt', changed: true, changedKeys: ['power'],
    first: false, parsed: { power: true, currentTemperature: 24 },
  });
  assert.strictEqual((node._sent || []).length, 1, 'real-time push emitted');
  assert.strictEqual(node._sent[0].event, 'change');

  // With Poll off, poll ticks are suppressed.
  node._sent = [];
  handler({ deviceId: 'dev1', source: 'poll', changed: false, first: false, parsed: { power: true } });
  assert.strictEqual(node._sent.length, 0, 'no poll emit when Poll disabled');
});

test('lg-ac poll emits every tick when Poll enabled', () => {
  const { RED, instantiate } = makeRED();
  require('../nodes/lg-ac.js')(RED);

  let handler = null;
  const acct = stubAccount();
  acct.subscribe = (h) => { handler = h; return () => {}; };
  RED.nodes._register('acc1', acct);

  const node = instantiate('lg-ac', { id: 'ac1', account: 'acc1', deviceId: 'dev1', emitPoll: true });

  // Poll tick with no change still emits (as 'periodic').
  handler({ deviceId: 'dev1', source: 'poll', changed: false, first: false, parsed: { power: true } });
  assert.strictEqual((node._sent || []).length, 1, 'poll tick emitted');
  assert.strictEqual(node._sent[0].event, 'periodic');
});

test('lg-tv deriveAction maps payloads to on/off/toggle', () => {
  const mod = require('../nodes/lg-tv.js');
  assert.strictEqual(mod._deriveAction('on'), 'on');
  assert.strictEqual(mod._deriveAction(true), 'on');
  assert.strictEqual(mod._deriveAction('off'), 'off');
  assert.strictEqual(mod._deriveAction(false), 'off');
  assert.strictEqual(mod._deriveAction('toggle'), 'toggle');
  assert.strictEqual(mod._deriveAction({ power: true }), 'on');
  assert.throws(() => mod._deriveAction('nonsense'));
});

// Note: instantiating the lg-tv runtime node opens a live websocket connection
// to the TV, so it is not unit-tested here (it would leave open handles). The
// module load/registration is covered above, deriveAction is covered here, and
// the underlying WebosTv behaviour is covered in unit.test.js.

// ---- Optional live (read-only) end-to-end through the account node ----------

test('lg-account poller emits AC snapshots (live)', { skip: !process.env.LG_USERNAME }, async () => {
  const { RED, instantiate } = makeRED();
  require('../nodes/lg-account.js')(RED);

  const node = instantiate('lg-account', {
    id: 'acclive',
    country: process.env.LG_COUNTRY || 'US',
    language: process.env.LG_LANGUAGE || 'en-US',
    pollInterval: 30,
    credentials: { username: process.env.LG_USERNAME, password: process.env.LG_PASSWORD },
  });

  const got = await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('no snapshot within 30s')), 30000);
    const unsub = node.subscribe((evt) => {
      if (evt.deviceType === 401) {
        clearTimeout(to);
        unsub();
        resolve(evt);
      }
    });
  });

  assert.ok(got.parsed, 'has parsed state');
  assert.ok('currentTemperature' in got.parsed, 'reports current temperature');
  node.emit('close', () => {});
});
