'use strict';

const test = require('node:test');
const assert = require('node:assert');

const ac = require('../lib/thinq/ac');
const wol = require('../lib/webos/wol');
const { interpretPowerState, isPoweredOn, WebosTv } = require('../lib/webos/tv');
const { ThinQClient, parseTokenPayload } = require('../lib/thinq/client');
const { parseMessage, createCsr, generatePrivateKey } = require('../lib/thinq/mqtt');

test('parseSnapshot reads temperature even when AC is off', () => {
  const snapshot = {
    online: true,
    'airState.operation': 0,
    'airState.opMode': 0,
    'airState.tempState.current': 26,
    'airState.tempState.target': 21,
    'airState.windStrength': 2,
  };
  const s = ac.parseSnapshot(snapshot);
  assert.strictEqual(s.power, false);
  assert.strictEqual(s.mode, 'COOL');
  assert.strictEqual(s.currentTemperature, 26);
  assert.strictEqual(s.targetTemperature, 21);
  assert.strictEqual(s.fanSpeed, 'LOW');
});

test('parseSnapshot handles missing snapshot', () => {
  assert.deepStrictEqual(ac.parseSnapshot(null), { online: false });
});

test('normalizeRequest maps simple payloads', () => {
  assert.deepStrictEqual(ac.normalizeRequest(true), { power: true });
  assert.deepStrictEqual(ac.normalizeRequest('off'), { power: false });
  assert.deepStrictEqual(ac.normalizeRequest('status'), { query: true });
  assert.deepStrictEqual(ac.normalizeRequest(22), { temperature: 22 });
  assert.deepStrictEqual(ac.normalizeRequest('cool'), { mode: 'cool' });
});

test('buildCommands creates dataKey/dataValue pairs', () => {
  const cmds = ac.buildCommands({ power: true, mode: 'HEAT', temperature: 24, fan: 'HIGH' });
  assert.deepStrictEqual(cmds.map((c) => [c.dataKey, c.dataValue]), [
    ['airState.operation', 1],
    ['airState.opMode', 4],
    ['airState.tempState.target', 24],
    ['airState.windStrength', 6],
  ]);
});

test('buildCommands rejects invalid mode', () => {
  assert.throws(() => ac.buildCommands({ mode: 'NONSENSE_MODE' }), /Invalid mode/);
});

test('buildCommands maps fan AUTO to windStrength 8', () => {
  assert.deepStrictEqual(ac.buildCommands({ fan: 'AUTO' }), [
    { dataKey: 'airState.windStrength', dataValue: 8, label: 'fan=8' },
  ]);
  assert.strictEqual(ac.buildCommands({ fan: 'auto' })[0].dataValue, 8);
});

test('parseSnapshot reports windStrength 8 as AUTO', () => {
  assert.strictEqual(ac.parseSnapshot({ 'airState.windStrength': 8 }).fanSpeed, 'AUTO');
});

test('buildCommands rejects a truly unknown fan value', () => {
  assert.throws(() => ac.buildCommands({ fan: 'TURBOZ' }), /Unsupported fan value/);
});

test('buildCommands sets vane positions', () => {
  const cmds = ac.buildCommands({ verticalVane: 1, horizontalVane: 1 });
  assert.deepStrictEqual(cmds.map((c) => [c.dataKey, c.dataValue]), [
    ['airState.wDir.vStep', 1],
    ['airState.wDir.hStep', 1],
  ]);
});

test('buildCommands swing shorthand and "off"/"swing" words', () => {
  assert.deepStrictEqual(
    ac.buildCommands({ swing: 'both' }).map((c) => [c.dataKey, c.dataValue]),
    [['airState.wDir.vStep', 100], ['airState.wDir.hStep', 100]]
  );
  assert.deepStrictEqual(
    ac.buildCommands({ swing: 'off' }).map((c) => [c.dataKey, c.dataValue]),
    [['airState.wDir.vStep', 0], ['airState.wDir.hStep', 0]]
  );
  assert.deepStrictEqual(ac.buildCommands({ verticalVane: 'swing' })[0].dataValue, 100);
  assert.deepStrictEqual(ac.buildCommands({ verticalVane: 'off' })[0].dataValue, 0);
});

test('buildCommands maps display on/off to the inverted displayControl key', () => {
  assert.deepStrictEqual(ac.buildCommands({ display: false }), [
    { dataKey: 'airState.lightingState.displayControl', dataValue: 1, label: 'display=off' },
  ]);
  assert.strictEqual(ac.buildCommands({ display: true })[0].dataValue, 0);
  assert.strictEqual(ac.buildCommands({ display: 'off' })[0].dataValue, 1);
  assert.strictEqual(ac.buildCommands({ display: 'on' })[0].dataValue, 0);
});

test('parseSnapshot reports display state (inverted: 0 = lit)', () => {
  assert.strictEqual(ac.parseSnapshot({ 'airState.lightingState.displayControl': 0 }).display, true);
  assert.strictEqual(ac.parseSnapshot({ 'airState.lightingState.displayControl': 1 }).display, false);
  assert.strictEqual(ac.parseSnapshot({}).display, null);
});

test('buildCommands raw escape hatch passes keys verbatim', () => {
  const cmds = ac.buildCommands({ raw: { 'airState.wDir.vStep': 1 } });
  assert.deepStrictEqual(cmds, [{ dataKey: 'airState.wDir.vStep', dataValue: 1, label: 'airState.wDir.vStep=1' }]);
});

test('parseSnapshot exposes vane positions', () => {
  const s = ac.parseSnapshot({ 'airState.wDir.vStep': 1, 'airState.wDir.hStep': 100 });
  assert.strictEqual(s.verticalVane, 1);
  assert.strictEqual(s.horizontalVane, 100);
});

test('wol.parseMac accepts common formats', () => {
  const expected = Buffer.from('aabbccddeeff', 'hex');
  assert.deepStrictEqual(wol.parseMac('AA:BB:CC:DD:EE:FF'), expected);
  assert.deepStrictEqual(wol.parseMac('aa-bb-cc-dd-ee-ff'), expected);
  assert.deepStrictEqual(wol.parseMac('AABBCCDDEEFF'), expected);
});

test('wol.parseMac rejects invalid MAC', () => {
  assert.throws(() => wol.parseMac('zz:zz'), /invalid MAC/);
});

test('interpretPowerState maps webOS responses', () => {
  assert.strictEqual(interpretPowerState({ state: 'Active' }), 'On');
  assert.strictEqual(interpretPowerState({ state: 'Suspend' }), 'Off');
  assert.strictEqual(interpretPowerState({ state: 'Active Standby' }), 'Pixel Refresher');
  assert.strictEqual(interpretPowerState({ state: 'Screen Saver' }), 'Screen Saver');
  assert.strictEqual(interpretPowerState({ state: 'Screen Off' }), 'Screen Off');
  assert.strictEqual(interpretPowerState(null), 'Off');
});

test('isPoweredOn treats screensaver/screen-off as ON, only Suspend/Pixel Refresher as OFF', () => {
  // Panel states while the TV is still powered -> ON (no spurious off event).
  assert.strictEqual(isPoweredOn('On'), true);
  assert.strictEqual(isPoweredOn('Screen Saver'), true);
  assert.strictEqual(isPoweredOn('Screen Off'), true);
  assert.strictEqual(isPoweredOn('Screen On'), true);
  // Genuine off / standby maintenance -> OFF.
  assert.strictEqual(isPoweredOn('Off'), false);
  assert.strictEqual(isPoweredOn('Pixel Refresher'), false);
  // Unrecognised state stays ON; a real power-off is caught by the connection close.
  assert.strictEqual(isPoweredOn('Unknown'), true);
});

test('withDeviceLock serializes operations for the same device', async () => {
  const { ThinQClient } = require('../lib/thinq/client');
  const c = new ThinQClient({});
  const order = [];
  const op = (label, ms) => () => new Promise((res) => {
    order.push('start:' + label);
    setTimeout(() => { order.push('end:' + label); res(label); }, ms);
  });
  const p1 = c.withDeviceLock('dev', op('a', 30));
  const p2 = c.withDeviceLock('dev', op('b', 1));
  await Promise.all([p1, p2]);
  assert.deepStrictEqual(order, ['start:a', 'end:a', 'start:b', 'end:b']);
});

test('withDeviceLock runs different devices in parallel', async () => {
  const { ThinQClient } = require('../lib/thinq/client');
  const c = new ThinQClient({});
  const order = [];
  const op = (label, ms) => () => new Promise((res) => {
    order.push('start:' + label);
    setTimeout(() => { order.push('end:' + label); res(); }, ms);
  });
  await Promise.all([c.withDeviceLock('d1', op('a', 25)), c.withDeviceLock('d2', op('b', 1))]);
  assert.ok(order.indexOf('start:b') < order.indexOf('end:a'), 'd2 did not wait for d1');
});

test('withDeviceLock keeps the queue alive after a failing op', async () => {
  const { ThinQClient } = require('../lib/thinq/client');
  const c = new ThinQClient({});
  await assert.rejects(c.withDeviceLock('dev', async () => { throw new Error('boom'); }));
  assert.strictEqual(await c.withDeviceLock('dev', async () => 'ok'), 'ok');
});

test('sendCommand retries a transient 0103 and then succeeds', async () => {
  const { ThinQClient } = require('../lib/thinq/client');
  const c = new ThinQClient({});
  let calls = 0;
  c._request = async () => {
    calls += 1;
    if (calls < 3) {
      const e = new Error('busy');
      e.resultCode = '0103';
      throw e;
    }
    return { resultCode: '0000' };
  };
  const res = await c.sendCommand('dev', 'airState.windStrength', 2, { retryDelayMs: 1 });
  assert.strictEqual(res.resultCode, '0000');
  assert.strictEqual(calls, 3); // 1 try + 2 retries
});

test('sendCommand gives up after retries and rethrows 0103', async () => {
  const { ThinQClient } = require('../lib/thinq/client');
  const c = new ThinQClient({});
  let calls = 0;
  c._request = async () => {
    calls += 1;
    const e = new Error('busy');
    e.resultCode = '0103';
    throw e;
  };
  await assert.rejects(() => c.sendCommand('dev', 'k', 1, { retryDelayMs: 1 }), /busy/);
  assert.strictEqual(calls, 3);
});

test('sendCommand does NOT retry a non-transient error', async () => {
  const { ThinQClient } = require('../lib/thinq/client');
  const c = new ThinQClient({});
  let calls = 0;
  c._request = async () => {
    calls += 1;
    const e = new Error('bad value');
    e.resultCode = '0001';
    throw e;
  };
  await assert.rejects(() => c.sendCommand('dev', 'k', 1, { retryDelayMs: 1 }), /bad value/);
  assert.strictEqual(calls, 1);
});

test('mqtt parseMessage extracts deviceId + reported delta', () => {
  const buf = Buffer.from(JSON.stringify({
    deviceId: 'dev-1',
    data: { state: { reported: { 'airState.operation': 1 } } },
  }));
  assert.deepStrictEqual(parseMessage(buf), { deviceId: 'dev-1', reported: { 'airState.operation': 1 } });
  assert.strictEqual(parseMessage(Buffer.from('not json')), null);
  assert.strictEqual(parseMessage(Buffer.from(JSON.stringify({ deviceId: 'x' }))), null);
});

test('mqtt CSR is generated from a native key and verifies', async () => {
  const forge = require('node-forge');
  const pk = await generatePrivateKey();
  const csrPem = createCsr(pk);
  const csr = forge.pki.certificationRequestFromPem(csrPem);
  assert.ok(csr.verify(), 'CSR signature is valid');
  assert.strictEqual(csr.subject.getField('CN').value, 'AWS IoT Certificate');
});

test('WebosTv._emitError never throws when nobody listens (offline TV cannot crash NR)', () => {
  const tv = new WebosTv({ host: '127.0.0.1', name: 'offline' });
  // No 'error' listener attached: must NOT throw (Node would otherwise crash).
  assert.doesNotThrow(() => tv._emitError(new Error('connect EHOSTUNREACH')));
  // With a listener it should still deliver the error.
  let received = null;
  tv.on('error', (e) => { received = e; });
  tv._emitError(new Error('boom'));
  assert.strictEqual(received.message, 'boom');
});

// ---------------------------------------------------------------------------
// Off-grace on websocket close: a transient connection drop while the TV is ON
// must not flap the reported power off->on. A real power-off is announced by
// the power-state subscription (Suspend) before the socket dies, so that path
// stays instant. Simulated via _handleDisconnect() (the lgtv2 'close' handler)
// without opening any real socket.
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function onlineTv(name, offGraceMs) {
  const tv = new WebosTv({ host: '127.0.0.1', name, offGraceMs });
  tv.connected = true;
  tv._setPower(true, 'On', { state: 'Active' });
  return tv;
}

test('WebosTv: transient websocket drop + reconnect does not flap power off/on', async () => {
  const tv = onlineTv('flappy', 40);
  const events = [];
  tv.on('powerStateChanged', (e) => events.push(e));

  // Websocket drops (Wi-Fi hiccup / keepalive timeout), no Suspend announced.
  tv._handleDisconnect();
  assert.deepStrictEqual(events, [], 'no immediate OFF on a bare socket close');
  assert.strictEqual(tv.powerOn, true);

  // lgtv2 reconnects and the power-state subscription confirms ON in time.
  tv.connected = true;
  tv._setPower(true, 'On', { state: 'Active' });

  await sleep(90); // well past offGraceMs
  assert.deepStrictEqual(events, [], 'no OFF/ON flap after a successful reconnect');
  assert.strictEqual(tv.powerOn, true);
  tv.stop();
});

test('WebosTv: TV unreachable past the grace window is reported off', async () => {
  const tv = onlineTv('gone', 30);
  const events = [];
  tv.on('powerStateChanged', (e) => events.push(e));

  tv._handleDisconnect();
  assert.deepStrictEqual(events, [], 'off is deferred, not immediate');
  await sleep(70);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].power, false);
  assert.strictEqual(tv.powerOn, false);
  tv.stop();
});

test('WebosTv: subscription-announced power-off stays instant', () => {
  const tv = onlineTv('real-off', 5000);
  const events = [];
  tv.on('powerStateChanged', (e) => events.push(e));

  // The TV announces Suspend on the subscription BEFORE the socket dies.
  tv._setPower(false, 'Off', { state: 'Suspend' });
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].power, false);

  // The socket close that follows must not schedule a grace timer.
  tv._handleDisconnect();
  assert.strictEqual(events.length, 1);
  assert.strictEqual(tv._offGraceTimer, null);
  tv.stop();
});

test('WebosTv: repeated closes while the grace timer runs do not stack timers or events', async () => {
  const tv = onlineTv('churn', 40);
  const events = [];
  tv.on('powerStateChanged', (e) => events.push(e));

  tv._handleDisconnect();
  tv._handleDisconnect();
  tv._handleDisconnect();
  await sleep(90);
  assert.strictEqual(events.length, 1, 'exactly one OFF event');
  assert.strictEqual(events[0].power, false);
  tv.stop();
});

test('WebosTv: stop() cancels a pending off-grace timer', async () => {
  const tv = onlineTv('stopped', 30);
  const events = [];
  tv.on('powerStateChanged', (e) => events.push(e));

  tv._handleDisconnect();
  tv.stop();
  await sleep(60);
  assert.deepStrictEqual(events, [], 'no OFF after the node was stopped');
});

// ---------------------------------------------------------------------------
// GitHub issue #1: token not cached on disk + "not exist refresh token".
// The OAuth backend that issued the refresh token is account-bound and only
// discoverable during a full login, so it must be persisted with the token,
// and a rejected refresh must fall back to a fresh username/password login.
// ---------------------------------------------------------------------------

test('parseTokenPayload accepts the JSON payload and legacy plain-string token files', () => {
  assert.deepStrictEqual(
    parseTokenPayload(JSON.stringify({ refreshToken: 'rt-1', lgeapiUrl: 'https://eu.lgeapi.com/' })),
    { refreshToken: 'rt-1', lgeapiUrl: 'https://eu.lgeapi.com/' }
  );
  assert.deepStrictEqual(parseTokenPayload('legacy-token\n'), {
    refreshToken: 'legacy-token',
    lgeapiUrl: null,
  });
  assert.strictEqual(parseTokenPayload(''), null);
  assert.strictEqual(parseTokenPayload(null), null);
  assert.strictEqual(parseTokenPayload('{not json'), null);
});

test('ThinQClient adopts the stored OAuth backend URL and caches the token payload to disk', async () => {
  const saved = [];
  const store = {
    load: async () => JSON.stringify({ refreshToken: 'stored-rt', lgeapiUrl: 'https://eu.lgeapi.com/' }),
    save: async (t) => saved.push(t),
  };
  const client = new ThinQClient({ country: 'US', refreshToken: 'cred-rt', tokenStore: store });
  client.getGateway = async () => ({});
  client.refreshAccessToken = async () => {
    client.accessToken = 'at';
    client.expiresAt = Math.round(Date.now() / 1000) + 3600;
  };
  client.getUserNumber = async () => {
    client.userNumber = 'U1';
  };

  await client.ready();

  assert.strictEqual(client.refreshToken, 'cred-rt', 'credential token takes precedence over the stored one');
  assert.strictEqual(client.lgeapiUrl, 'https://eu.lgeapi.com/', 'stored issuing backend is adopted');
  assert.strictEqual(saved.length, 1, 'token payload cached to disk even without a fresh login');
  assert.deepStrictEqual(JSON.parse(saved[0]), {
    refreshToken: 'cred-rt',
    lgeapiUrl: 'https://eu.lgeapi.com/',
  });
});

test('ThinQClient falls back to a full login when the refresh token is rejected', async () => {
  const client = new ThinQClient({
    country: 'US',
    username: 'user@example.com',
    password: 'pw',
    refreshToken: 'rejected-rt',
  });
  // LG rejects the refresh (e.g. "not exist refresh token" from the wrong
  // regional backend). The stub covers both the best-effort regional lookup
  // and the token request itself.
  client.http = {
    post: async () => {
      const err = new Error('Request failed with status code 400');
      err.response = { status: 400, data: { error: { message: 'not exist refresh token' } } };
      throw err;
    },
  };
  let loginCalls = 0;
  client.login = async () => {
    loginCalls += 1;
    client.accessToken = 'fresh-at';
    client.refreshToken = 'fresh-rt';
    client.expiresAt = Math.round(Date.now() / 1000) + 3600;
    return client.refreshToken;
  };

  const accessToken = await client.refreshAccessToken();
  assert.strictEqual(loginCalls, 1, 'fell back to a full login');
  assert.strictEqual(accessToken, 'fresh-at');
  assert.strictEqual(client.refreshToken, 'fresh-rt');
});

test('ThinQClient refresh failure without stored credentials still surfaces the LG error', async () => {
  const client = new ThinQClient({ country: 'US', refreshToken: 'rejected-rt' });
  client.http = {
    post: async () => {
      const err = new Error('Request failed with status code 400');
      err.response = { status: 400, data: { error: { message: 'not exist refresh token' } } };
      throw err;
    },
  };
  await assert.rejects(() => client.refreshAccessToken(), /not exist refresh token/);
});
