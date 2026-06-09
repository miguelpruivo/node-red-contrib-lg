'use strict';

/*
 * Read-only smoke test for the ThinQ real-time (MQTT) push.
 *
 * It authenticates, opens the AWS IoT MQTT connection and prints any pushes.
 * It NEVER sends a control command. Change something on an AC (e.g. with its
 * remote) within the listen window to see a push arrive.
 *
 * Credentials come from env (LG_USERNAME/LG_PASSWORD/LG_COUNTRY/LG_LANGUAGE) or
 * test/.secrets.json. Usage:
 *   LG_USERNAME=... LG_PASSWORD=... LG_COUNTRY=PT node test/thinq-mqtt-smoke.js
 */

const fs = require('fs');
const path = require('path');
const { ThinQClient } = require('../lib/thinq/client');
const { ThinQMqtt } = require('../lib/thinq/mqtt');

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

  const client = new ThinQClient({
    country: cfg.country,
    language: cfg.language,
    username: cfg.username,
    password: cfg.password,
    logger: console,
  });

  console.log('> authenticating...');
  await client.ready();

  const keyFile = path.join(__dirname, '.mqtt-keys.json');
  const keyStore = {
    load: () => { try { return JSON.parse(fs.readFileSync(keyFile, 'utf8')); } catch (e) { return null; } },
    save: (k) => fs.writeFileSync(keyFile, JSON.stringify(k)),
  };

  const mqtt = new ThinQMqtt({
    client,
    keyStore,
    logger: console,
    onUpdate: (deviceId, reported) => {
      console.log('PUSH', deviceId, JSON.stringify(reported));
    },
  });

  console.log('> connecting to ThinQ MQTT...');
  await mqtt.start();

  const seconds = Number(process.env.LISTEN_SECONDS || 30);
  console.log(`> listening ${seconds}s (change an AC by remote/app to see a push). No commands are sent.`);
  setTimeout(() => {
    mqtt.stop();
    console.log('> done.');
    process.exit(0);
  }, seconds * 1000);
}

main().catch((err) => {
  console.error('MQTT SMOKE FAILED:', err.message);
  if (process.env.LG_DEBUG) {
    console.error(err.stack);
  }
  process.exit(1);
});
