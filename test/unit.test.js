'use strict';

const test = require('node:test');
const assert = require('node:assert');

const ac = require('../lib/thinq/ac');
const wol = require('../lib/webos/wol');
const { interpretPowerState, WebosTv } = require('../lib/webos/tv');
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
  assert.strictEqual(interpretPowerState(null), 'Off');
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
