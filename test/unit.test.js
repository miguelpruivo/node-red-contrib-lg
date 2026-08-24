'use strict';

const test = require('node:test');
const assert = require('node:assert');

const ac = require('../lib/thinq/ac');
const wol = require('../lib/webos/wol');
const { interpretPowerState, isPoweredOn, WebosTv } = require('../lib/webos/tv');
const { ThinQClient, parseTokenPayload, rfc2822 } = require('../lib/thinq/client');
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

// Captured live from a real TV powered off with the remote. webOS announces the
// power-off immediately but keeps state:'Active' for ~3.2s afterwards, so
// reading `state` alone reported ON for that whole window — the power-off lag.
test('interpretPowerState reports off the moment the remote announces it', () => {
  const seq = [
    { returnValue: true, state: 'Active', processing: 'Request Power Off', onOff: 'off', reason: 'remoteKey' },
    { returnValue: true, state: 'Active', processing: 'Request Power Off Logo', onOff: 'off', reason: 'remoteKey' },
    { returnValue: true, state: 'Active', processing: 'Request Active Standby', onOff: 'off', reason: 'remoteKey' },
    { returnValue: true, state: 'Active', processing: 'Prepare Active Standby', onOff: 'off', reason: 'remoteKey' },
  ];
  for (const res of seq) {
    const label = interpretPowerState(res);
    assert.strictEqual(label, 'Off', `${res.processing} must read as Off`);
    assert.strictEqual(isPoweredOn(label), false);
  }
  // ...and the state that used to be the first OFF signal still is one.
  assert.strictEqual(isPoweredOn(interpretPowerState({ state: 'Active Standby' })), false);
});

test('interpretPowerState does not read a waking TV as powering down', () => {
  // 'Request Active' must NOT match the 'active standby' power-down phrase.
  assert.strictEqual(isPoweredOn(interpretPowerState({ state: 'Suspend', processing: 'Request Active', onOff: 'on' })), true);
  assert.strictEqual(interpretPowerState({ state: 'Active', processing: 'Request Screen Saver' }), 'Unknown');
  // Steady-state ON, exactly as the live subscription delivers it.
  assert.strictEqual(interpretPowerState({ state: 'Active', subscribed: true, returnValue: true }), 'On');
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

// A boot-time network failure says nothing about the refresh token: falling
// back to a full username/password login there burns five requests that cannot
// succeed either, slowing the failed poll down and hammering LG's rate-limited
// login endpoints once per poll interval until the uplink is up.
test('refreshAccessToken does NOT full-login on a bare network error', async () => {
  const { ThinQClient } = require('../lib/thinq/client');
  const c = new ThinQClient({ username: 'u', password: 'p', refreshToken: 'rt' });
  c._lgeapiAuthoritative = true; // skip the legacy region lookup
  let logins = 0;
  c.login = async () => { logins += 1; };
  c.http = { post: async () => { const e = new Error('getaddrinfo ENOTFOUND'); e.code = 'ENOTFOUND'; throw e; } };

  await assert.rejects(() => c.refreshAccessToken(), /token refresh failed/);
  assert.strictEqual(logins, 0, 'no doomed login attempt without a response from LG');
});

test('refreshAccessToken still full-logins when LG actually rejects the token', async () => {
  const { ThinQClient } = require('../lib/thinq/client');
  const c = new ThinQClient({ username: 'u', password: 'p', refreshToken: 'rt' });
  c._lgeapiAuthoritative = true;
  let logins = 0;
  c.login = async () => { logins += 1; c.accessToken = 'fresh'; };
  c.http = {
    post: async () => {
      const e = new Error('Request failed with status code 400');
      e.response = { status: 400, data: { error: { message: 'not exist refresh token' } } };
      throw e;
    },
  };

  assert.strictEqual(await c.refreshAccessToken(), 'fresh');
  assert.strictEqual(logins, 1, 'an LG rejection is still self-healed by a fresh login');
});

// ---------------------------------------------------------------------------
// Clock skew. Every LG OAuth request is signed together with an RFC-2822
// timestamp that LG validates against THEIR clock; anything outside a few
// minutes is rejected with "Time of request execution exceeded." (reproduced
// live against the real API with a 30-minute skew). A host that reboots after
// a power/network outage signs with a wrong clock — a Pi has no RTC, and NTP
// cannot sync while the uplink is still down — so every poll fails until the
// host clock is fixed, which is the reported "minutes or hours" of downtime.
// The signing clock therefore has to come from LG, not from the host.
// ---------------------------------------------------------------------------

// A client whose HTTP layer answers every request with the given LG clock.
function clientWithLgClock(lgNow, { fail = false } = {}) {
  const c = new ThinQClient({});
  c.http.defaults.adapter = async (config) => {
    const response = { status: fail ? 400 : 200, data: {}, headers: { date: lgNow.toUTCString() }, config };
    if (!fail) {
      return response;
    }
    const err = new Error('Request failed with status code 400');
    err.response = response;
    throw err;
  };
  return c;
}

test('the signing clock is learned from LG response headers, not taken from the host', async () => {
  const lgNow = new Date(Date.now() + 42 * 60 * 1000); // host clock 42 min behind
  const c = clientWithLgClock(lgNow);

  await c.http.get('https://example.invalid/');

  const signed = Date.parse(rfc2822(c._now()));
  assert.ok(
    Math.abs(signed - lgNow.getTime()) < 5000,
    `expected to sign with LG's clock (${lgNow.toUTCString()}), signed ${rfc2822(c._now())}`
  );
});

// The response that rejects us carries LG's Date too, so a poll that starts
// with a stale offset (the gateway lookup is cached, so it makes no request
// that could refresh it) still learns the truth from its own failure.
test('a rejected request also teaches the client LG clock', async () => {
  const lgNow = new Date(Date.now() - 90 * 60 * 1000); // host clock 90 min ahead
  const c = clientWithLgClock(lgNow, { fail: true });

  await assert.rejects(() => c.http.get('https://example.invalid/'));

  const signed = Date.parse(rfc2822(c._now()));
  assert.ok(Math.abs(signed - lgNow.getTime()) < 5000, `signed ${rfc2822(c._now())}`);
});

// This is what turned a wrong clock into a request storm: the timestamp
// rejection was read as "the refresh token might be bad", so every poll threw
// the token away and burned a five-request username/password login that failed
// at the same signature check — against LG's rate-limited login endpoints.
test('refreshAccessToken does NOT full-login when LG rejects the signed timestamp', async () => {
  const c = new ThinQClient({ username: 'u', password: 'p', refreshToken: 'rt' });
  c._lgeapiAuthoritative = true; // skip the legacy region lookup
  let logins = 0;
  c.login = async () => { logins += 1; };
  c.http = {
    post: async () => {
      const e = new Error('Request failed with status code 400');
      e.response = { status: 400, data: { error: { message: 'Time of request execution exceeded.' } } };
      throw e;
    },
  };

  await assert.rejects(() => c.refreshAccessToken(), /Time of request execution exceeded/);
  assert.strictEqual(logins, 0, 'a clock error is not a bad token: a full login fails identically');
  assert.strictEqual(c.refreshToken, 'rt', 'a usable refresh token must not be discarded');
});

// A clock running *ahead* is rejected with a different message (measured live);
// missing it would leave that host in the very storm this fix removes.
test('a clock running ahead is recognised as skew too, not as a bad token', async () => {
  const c = new ThinQClient({ username: 'u', password: 'p', refreshToken: 'rt' });
  c._lgeapiAuthoritative = true;
  let logins = 0;
  c.login = async () => { logins += 1; };
  c.http = {
    post: async () => {
      const e = new Error('Request failed with status code 400');
      e.response = { status: 400, data: { error: { message: "Can't handle requests from the future." } } };
      throw e;
    },
  };

  await assert.rejects(() => c.refreshAccessToken(), /requests from the future/);
  assert.strictEqual(logins, 0, 'still a clock problem, not a credentials problem');
});

test('ready() retries once with the corrected clock after LG rejects the timestamp', async () => {
  const c = new ThinQClient({ username: 'u', password: 'p' });
  c.getGateway = async () => ({}); // cached gateway: no request, so no fresh Date header
  let attempts = 0;
  c.login = async () => {
    attempts += 1;
    if (attempts === 1) {
      // The rejecting response is what teaches us LG's clock.
      c._clockOffsetMs = 42 * 60 * 1000;
      throw new Error('ThinQ OAuth authorize rejected: Time of request execution exceeded.');
    }
    c.refreshToken = 'rt';
    c.accessToken = 'at';
    c.expiresAt = Math.round(Date.now() / 1000) + 3600;
  };
  c.getUserNumber = async () => { c.userNumber = '42'; };

  await c.ready();
  assert.strictEqual(attempts, 2, 'recovered inside the same poll instead of waiting for the clock');
});

test('ready() gives up after one clock retry instead of looping', async () => {
  const c = new ThinQClient({ username: 'u', password: 'p' });
  c.getGateway = async () => ({});
  let attempts = 0;
  c.login = async () => {
    attempts += 1;
    c._clockOffsetMs = 42 * 60 * 1000;
    throw new Error('ThinQ OAuth authorize rejected: Time of request execution exceeded.');
  };

  await assert.rejects(() => c.ready(), /Time of request execution exceeded/);
  assert.strictEqual(attempts, 2, 'one retry, then report the failure to the poller');
});

// Defence in depth: whatever LG rejects a refresh with, the recovery attempt
// must not become a per-poll password login against a rate-limited endpoint.
test('the full-login fallback is throttled so it cannot storm LG', async () => {
  const c = new ThinQClient({ username: 'u', password: 'p', refreshToken: 'rt' });
  c._lgeapiAuthoritative = true;
  let logins = 0;
  c.login = async () => { logins += 1; throw new Error('ThinQ account login failed: nope'); };
  c.http = {
    post: async () => {
      const e = new Error('Request failed with status code 400');
      e.response = { status: 400, data: { error: { message: 'not exist refresh token' } } };
      throw e;
    },
  };

  for (let i = 0; i < 3; i++) {
    c.refreshToken = 'rt'; // _doReady reloads it from the token store every poll
    await assert.rejects(() => c.refreshAccessToken());
  }
  assert.strictEqual(logins, 1, 'one login attempt, not one per poll');
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

// ---------------------------------------------------------------------------
// Connection watchdog. lgtv2 only reconnects from its 'connectFailed'/'close'
// handlers, so an attempt that gets stuck (TV accepts the socket but never
// answers the pairing 'register' — which has no timeout in lgtv2 — or a dark
// NIC black-holing the connect) emits nothing at all and never recovers. The
// watchdog notices the silence and rebuilds the client.
// ---------------------------------------------------------------------------

test('WebosTv: a stuck connection attempt is detected and the client rebuilt', async () => {
  const tv = new WebosTv({ host: '127.0.0.1', name: 'wedged', watchdogMs: 40 });
  let restarts = 0;
  tv._restart = () => { restarts += 1; tv._noteActivity(); };

  tv._noteActivity();
  tv._checkStalled();
  assert.strictEqual(restarts, 0, 'fresh activity is not stale');

  await sleep(60); // silence past watchdogMs
  tv._checkStalled();
  assert.strictEqual(restarts, 1, 'silence past the window rebuilds the client');
  tv.stop();
});

test('WebosTv: a connected TV is never restarted by the watchdog', () => {
  const tv = new WebosTv({ host: '127.0.0.1', name: 'healthy', watchdogMs: 30 });
  let restarts = 0;
  tv._restart = () => { restarts += 1; };
  tv.connected = true;
  tv._lastActivityAt = Date.now() - 10000; // stale timestamp, but connected

  tv._checkStalled();
  assert.strictEqual(restarts, 0);
  tv.stop();
});

test('WebosTv: watchdog reports off when the TV was never reachable', () => {
  const tv = new WebosTv({ host: '127.0.0.1', name: 'dark', watchdogMs: 30 });
  tv._restart = () => {}; // don't open sockets in tests
  const events = [];
  tv.on('powerStateChanged', (e) => events.push(e));

  assert.strictEqual(tv.powerOn, null, 'starts unknown');
  tv._startedAt = Date.now() - 100; // a full window of failed attempts
  tv._lastActivityAt = Date.now();  // ...but still cycling, so no restart
  tv._checkStalled();

  assert.strictEqual(events.length, 1, 'a dark TV still publishes an initial state');
  assert.strictEqual(events[0].power, false);
  tv.stop();
});

// Transport is auto-detected: `secure` is only a starting point. Old TVs serve
// only ws://:3000, newer ones can refuse it and require wss://:3001, and a port
// probe cannot tell them apart (a standby TV holds BOTH ports open yet refuses
// the upgrade on one). The handshake outcome is the only usable signal.
function unprovenTv(secure) {
  const tv = new WebosTv({ host: '127.0.0.1', name: 'transport', secure, watchdogMs: 30 });
  tv._teardownClient = () => {};
  tv._setup = () => {};
  tv._startedAt = Date.now();
  tv._lastActivityAt = Date.now();       // cycling normally, so not "silent"
  tv._transportSince = Date.now() - 100; // ...but never handshook on this one
  return tv;
}

test('WebosTv: an unproven transport is alternated by the watchdog', () => {
  // The wss->ws direction has no fast path (ECONNRESET only fires while
  // insecure), so a wrongly-ticked Secure box used to strand the node forever.
  const tv = unprovenTv(true);
  tv._checkStalled();
  assert.strictEqual(tv.secure, false, 'wss that never handshakes falls back to ws');

  tv._transportSince = Date.now() - 100;
  tv._checkStalled();
  assert.strictEqual(tv.secure, true, 'and keeps alternating until one works');
  tv.stop();
});

test('WebosTv: a proven transport is never alternated', () => {
  const tv = unprovenTv(true);
  tv._provenSecure = true; // a pairing handshake completed here
  tv._checkStalled();
  assert.strictEqual(tv.secure, true, 'a working transport is locked in for good');
  tv.stop();
});

test('WebosTv: a stuck-but-proven client is rebuilt without changing transport', () => {
  const tv = unprovenTv(true);
  tv._provenSecure = true;
  tv._lastActivityAt = Date.now() - 1000; // silent => stuck
  let restarts = 0;
  tv._restart = () => { restarts += 1; };

  tv._checkStalled();
  assert.strictEqual(restarts, 1, 'still rebuilds when wedged');
  assert.strictEqual(tv.secure, true, 'but keeps the transport that works');
  tv.stop();
});

// Regression: the ws->wss fallback restarts the client to apply the flip. When
// _restart() unconditionally reverted an unproven transport it undid that flip
// immediately, looping forever on a port the TV refuses (caught live against a
// real TV, which always RSTs plain ws and only serves wss).
test('WebosTv: _restart never changes transport on its own', () => {
  const tv = new WebosTv({ host: '127.0.0.1', name: 'fallback', secure: false });
  tv._teardownClient = () => {};
  tv._setup = () => {};

  tv._setTransport(true, 'connection reset'); // what the ECONNRESET handler does
  tv._restart();                              // ...and how it applies it
  assert.strictEqual(tv.secure, true, 'the fallback flip survives its own restart');
  tv.stop();
});

test('WebosTv: stop() cancels the watchdog', () => {
  const tv = new WebosTv({ host: '127.0.0.1', name: 'watchdog-stop', watchdogMs: 30 });
  tv._startWatchdog();
  assert.ok(tv._watchdogTimer, 'watchdog armed');
  tv.stop();
  assert.strictEqual(tv._watchdogTimer, null, 'watchdog cleared on stop');
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

// ---- Picture settings via the luna-over-alert route -------------------------

test('WebosTv.lunaSend smuggles a luna:// call through a system alert, then closes it', async () => {
  const tv = new WebosTv({ host: '127.0.0.1', name: 'luna' });
  const calls = [];
  tv.connected = true;
  tv.request = async (uri, payload) => {
    calls.push({ uri, payload });
    return uri === 'ssap://system.notifications/createAlert'
      ? { returnValue: true, alertId: 'ALERT_7' }
      : { returnValue: true };
  };

  const params = { category: 'picture', settings: { backlight: 40 } };
  const res = await tv.lunaSend('luna://com.webos.settingsservice/setSystemSettings', params);

  assert.strictEqual(calls.length, 2, 'createAlert then closeAlert');
  assert.strictEqual(calls[0].uri, 'ssap://system.notifications/createAlert');

  const alert = calls[0].payload;
  assert.strictEqual(alert.isSysReq, true, 'must be a system request to run privileged');
  assert.strictEqual(alert.modal, false);
  assert.strictEqual(alert.type, 'confirm');
  assert.strictEqual(alert.buttons[0].onClick, 'luna://com.webos.settingsservice/setSystemSettings');
  assert.deepStrictEqual(alert.buttons[0].params, params);
  // Closing the alert is what actually fires the call, so onclose must carry it too.
  assert.deepStrictEqual(alert.onclose, {
    uri: 'luna://com.webos.settingsservice/setSystemSettings',
    params,
  });

  assert.strictEqual(calls[1].uri, 'ssap://system.notifications/closeAlert');
  assert.deepStrictEqual(calls[1].payload, { alertId: 'ALERT_7' });
  assert.strictEqual(res.alertId, 'ALERT_7');
});

test('WebosTv.lunaSend fails loudly when the TV refuses the alert', async () => {
  const tv = new WebosTv({ host: '127.0.0.1', name: 'luna' });
  tv.connected = true;
  tv.request = async () => ({ returnValue: false });
  await assert.rejects(() => tv.lunaSend('luna://x/y', {}), /alertId/);
});

test('WebosTv.setPictureSettings targets the settings service picture category', async () => {
  const tv = new WebosTv({ host: '127.0.0.1', name: 'pic' });
  const sent = [];
  tv.lunaSend = async (uri, params) => { sent.push({ uri, params }); return { alertId: 'A' }; };

  await tv.setPictureSettings({ backlight: 55, pictureMode: 'cinema' });

  assert.deepStrictEqual(sent, [{
    uri: 'luna://com.webos.settingsservice/setSystemSettings',
    params: { category: 'picture', settings: { backlight: 55, pictureMode: 'cinema' } },
  }]);
});

test('WebosTv.getSystemSettings reads directly (no alert needed)', async () => {
  const tv = new WebosTv({ host: '127.0.0.1', name: 'read' });
  const calls = [];
  tv.connected = true;
  tv.request = async (uri, payload) => { calls.push({ uri, payload }); return { settings: { backlight: 80 } }; };

  const res = await tv.getSystemSettings('picture', ['backlight']);

  assert.deepStrictEqual(calls, [{
    uri: 'ssap://settings/getSystemSettings',
    payload: { category: 'picture', keys: ['backlight'] },
  }]);
  assert.deepStrictEqual(res.settings, { backlight: 80 });
});
