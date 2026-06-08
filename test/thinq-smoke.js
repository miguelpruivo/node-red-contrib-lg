'use strict';

/*
 * Read-only smoke test for the LG ThinQ client.
 *
 * It logs in, lists devices and prints the parsed state of any air
 * conditioner. It NEVER sends a control command, so it will not turn any
 * device on or off.
 *
 * Credentials are read from (in order):
 *   1. environment variables LG_USERNAME / LG_PASSWORD / LG_COUNTRY / LG_LANGUAGE
 *   2. test/.secrets.json  (gitignored)  { "username", "password", "country", "language" }
 *
 * Usage:
 *   LG_USERNAME=... LG_PASSWORD=... LG_COUNTRY=PT LG_LANGUAGE=en-US node test/thinq-smoke.js
 */

const fs = require('fs');
const path = require('path');
const { ThinQClient } = require('../lib/thinq/client');
const { parseSnapshot } = require('../lib/thinq/ac');
const C = require('../lib/thinq/constants');

function loadConfig() {
  let fileCfg = {};
  const secretsPath = path.join(__dirname, '.secrets.json');
  if (fs.existsSync(secretsPath)) {
    fileCfg = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
  }
  return {
    username: process.env.LG_USERNAME || fileCfg.username,
    password: process.env.LG_PASSWORD || fileCfg.password,
    country: process.env.LG_COUNTRY || fileCfg.country || 'US',
    language: process.env.LG_LANGUAGE || fileCfg.language || 'en-US',
  };
}

async function main() {
  const cfg = loadConfig();
  if (!cfg.username || !cfg.password) {
    console.error('Missing credentials. Set LG_USERNAME/LG_PASSWORD or create test/.secrets.json');
    process.exit(1);
  }

  console.log(`> country=${cfg.country} language=${cfg.language} user=${cfg.username}`);

  const client = new ThinQClient({
    country: cfg.country,
    language: cfg.language,
    username: cfg.username,
    password: cfg.password,
    logger: console,
  });

  console.log('> authenticating...');
  await client.ready();
  console.log('> OK. userNumber =', client.userNumber);
  console.log('> refresh token (first 12 chars):', String(client.refreshToken).slice(0, 12) + '...');

  console.log('> listing devices...');
  const devices = await client.listDevices();
  console.log(`> found ${devices.length} device(s)`);

  for (const d of devices) {
    console.log('\n----------------------------------------');
    console.log(`name:     ${d.alias}`);
    console.log(`id:       ${d.deviceId}`);
    console.log(`type:     ${d.deviceType} ${d.deviceType === C.DeviceType.AC ? '(AC)' : ''}`);
    console.log(`platform: ${d.platformType}`);
    console.log(`online:   ${d.online}`);
    if (d.deviceType === C.DeviceType.AC) {
      console.log('parsed AC state:', JSON.stringify(parseSnapshot(d.snapshot), null, 2));
      console.log('raw airState keys:', Object.keys(d.snapshot || {}).filter((k) => k.startsWith('airState')).join(', '));
    }
  }

  console.log('\n> done (no control commands were sent).');
}

main().catch((err) => {
  console.error('SMOKE TEST FAILED:', err.message);
  if (process.env.LG_DEBUG) {
    console.error(err.stack);
  }
  if (err.response && err.response.data) {
    console.error('response body:', JSON.stringify(err.response.data).slice(0, 500));
  }
  process.exit(1);
});
