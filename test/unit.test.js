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
