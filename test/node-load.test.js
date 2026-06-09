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
  ['../nodes/lg-ac-status.js', 'lg-ac-status'],
  ['../nodes/lg-tv.js', 'lg-tv'],
  ['../nodes/lg-tv-control.js', 'lg-tv-control'],
  ['../nodes/lg-tv-status.js', 'lg-tv-status'],
];

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
  const stubAccount = {
    getClient: () => ({
      getDevice: async () => ({ snapshot: fakeSnapshot }),
    }),
    ensureReady: async () => {},
  };
  RED.nodes._register('acc1', stubAccount);

  const node = instantiate('lg-ac', { id: 'ac1', account: 'acc1', deviceId: 'dev1' });

  await new Promise((resolve, reject) => {
    node.on('input', () => {}); // ensure handler exists
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
  const stubAccount = {
    devices: {},
    ensureReady: async () => {},
    getClient: () => ({
      getDevice: async () => ({ snapshot: getDeviceSnapshot }),
      sendCommands: async (id, cmds) => { sent.push(cmds); return []; },
    }),
  };
  RED.nodes._register('accx', stubAccount);
  const node = instantiate('lg-ac', { id: 'acx', account: 'accx', deviceId: 'dev1' });
  return new Promise((resolve, reject) => {
    node.emit('input', { payload }, () => {}, (err) => {
      if (err) { reject(err); } else { resolve(sent[0] || []); }
    });
  });
}

test('lg-ac prepends power-on when changing temperature while AC is off', async () => {
  const cmds = await runAcControl({ temperature: 22 }, { 'airState.operation': 0 });
  assert.strictEqual(cmds[0].dataKey, 'airState.operation');
  assert.strictEqual(cmds[0].dataValue, 1);
  assert.ok(cmds.some((c) => c.dataKey === 'airState.tempState.target' && c.dataValue === 22));
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

test('lg-tv-control node turns a stub TV on', async () => {
  const { RED, instantiate } = makeRED();
  require('../nodes/lg-tv-control.js')(RED);

  let turnedOn = false;
  const stubTv = {
    turnOn: async () => { turnedOn = true; return { power: true, state: 'On', connected: true }; },
    turnOff: async () => ({ power: false, state: 'Off', connected: true }),
    toggle: async () => ({ power: true, state: 'On', connected: true }),
  };
  RED.nodes._register('tv1', { getTv: () => stubTv });

  const node = instantiate('lg-tv-control', { id: 'c1', tv: 'tv1', action: 'msg' });

  await new Promise((resolve, reject) => {
    node.emit('input', { payload: 'on' }, (m) => { node._sent = (node._sent || []).concat(m); }, (err) => {
      if (err) { reject(err); } else { resolve(); }
    });
  });

  assert.ok(turnedOn, 'turnOn was called');
  assert.strictEqual(node._sent[node._sent.length - 1].payload.power, true);
});

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
