'use strict';

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const { ThinQClient } = require('../lib/thinq/client');
const { ThinQMqtt } = require('../lib/thinq/mqtt');
const acLib = require('../lib/thinq/ac');
const { storageDir, makeLogger, diffParsed } = require('../lib/red-helpers');

module.exports = function (RED) {
  // Log the running version once at load, so it's easy to confirm an update took
  // effect (visible in the Node-RED startup log).
  try {
    RED.log.info('node-red-contrib-lg v' + require('../package.json').version + ' loaded');
  } catch (e) {
    /* ignore */
  }

  function LgAccountNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.country = (config.country || 'US').toUpperCase();
    node.language = config.language || 'en-US';
    node.pollInterval = Math.max(parseInt(config.pollInterval, 10) || 60, 10); // seconds, min 10
    node.realtime = config.realtime !== false; // MQTT push, default on

    const creds = node.credentials || {};
    const tokenFile = path.join(storageDir(RED), `thinq-${node.id}.token`);
    const mqttKeyFile = path.join(storageDir(RED), `thinq-mqtt-${node.id}.json`);

    // Persist the refresh token to disk so a restart does not require a fresh
    // username/password login. This is the "extract automatically and save for
    // further use" behaviour.
    const tokenStore = {
      load: async () => {
        try {
          const t = fs.readFileSync(tokenFile, 'utf8').trim();
          return t || null;
        } catch (e) {
          return null;
        }
      },
      save: async (t) => {
        // 0o600 on create; chmod enforces it even when overwriting a file an
        // older version may have left world-readable. The refresh token is the
        // long-lived credential for the whole account, so keep it owner-only.
        fs.writeFileSync(tokenFile, t, { mode: 0o600 });
        try { fs.chmodSync(tokenFile, 0o600); } catch (e) { /* best effort */ }
        node.debug('ThinQ refresh token cached to disk');
      },
    };

    node.client = new ThinQClient({
      country: node.country,
      language: node.language,
      username: creds.username || null,
      password: creds.password || null,
      refreshToken: creds.refreshToken || null,
      tokenStore,
      logger: makeLogger(node),
    });

    // Persisted RSA key + CSR for the AWS IoT (MQTT) client certificate, so we
    // don't regenerate them on every restart.
    const mqttKeyStore = {
      load: async () => {
        try {
          return JSON.parse(fs.readFileSync(mqttKeyFile, 'utf8'));
        } catch (e) {
          return null;
        }
      },
      save: async (keys) => {
        // Contains the MQTT client's RSA private key — owner-only, enforced on
        // overwrite too (see the token store above for the rationale).
        fs.writeFileSync(mqttKeyFile, JSON.stringify(keys), { mode: 0o600 });
        try { fs.chmodSync(mqttKeyFile, 0o600); } catch (e) { /* best effort */ }
      },
    };

    node.emitter = new EventEmitter();
    node.emitter.setMaxListeners(0);
    node.devices = {}; // deviceId -> { device, parsed, raw }

    node.getClient = () => node.client;
    node.ensureReady = () => node.client.ready();
    node.listDevices = () => node.client.listDevices();

    let pollTimer = null;
    let polling = false;
    let subscribers = 0;
    let pollFailures = 0;
    let retryTimer = null;

    // A failed poll used to wait a whole pollInterval (60s by default) before
    // trying again, which is exactly the wrong behaviour right after a restart:
    // the host's network/DNS is often not up yet, so the immediate first poll
    // fails and the ACs stay blank for a minute or more even though the network
    // recovered seconds later. Retry quickly at first, then back off to the
    // normal interval so a genuine outage does not hammer LG.
    const RETRY_BACKOFF_MS = [5000, 10000, 20000, 40000];

    function scheduleRetry() {
      if (retryTimer || !pollTimer) {
        return; // a retry is already armed, or polling has been stopped
      }
      const step = RETRY_BACKOFF_MS[Math.min(pollFailures - 1, RETRY_BACKOFF_MS.length - 1)];
      const delay = Math.min(step, node.pollInterval * 1000);
      node.debug(`ThinQ: poll failed (${pollFailures}), retrying in ${delay}ms`);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        poll();
      }, delay);
      if (retryTimer.unref) {
        retryTimer.unref();
      }
    }

    async function poll() {
      if (polling) {
        return;
      }
      polling = true;
      try {
        await node.client.ready();
        const devices = await node.client.listDevices();
        for (const d of devices) {
          const parsed = acLib.parseSnapshot(d.snapshot);
          const prev = node.devices[d.deviceId];
          const changedKeys = diffParsed(prev && prev.parsed, parsed);
          const first = !prev;
          node.devices[d.deviceId] = { device: d, parsed, raw: d.snapshot };
          node.emitter.emit('snapshot', {
            deviceId: d.deviceId,
            name: d.alias,
            deviceType: d.deviceType,
            parsed,
            raw: d.snapshot,
            changed: changedKeys.length > 0 && !first,
            changedKeys,
            first,
            source: 'poll',
          });
        }
        pollFailures = 0;
        node.status({ fill: 'green', shape: 'dot', text: `${devices.length} device(s)` });
      } catch (err) {
        pollFailures += 1;
        node.warn('ThinQ poll error: ' + err.message);
        node.status({ fill: 'red', shape: 'ring', text: 'auth/poll error' });
        scheduleRetry();
      } finally {
        polling = false;
      }
    }

    node.startPolling = () => {
      if (!pollTimer) {
        poll();
        pollTimer = setInterval(poll, node.pollInterval * 1000);
      }
    };

    node.forcePoll = poll;

    // -------- real-time updates (MQTT push) --------
    let mqtt = null;
    let mqttStarting = false;
    let mqttRetryTimer = null;

    // Apply a pushed delta to the cached snapshot and emit a change event, so
    // lg-ac nodes react instantly to changes made from the remote / LG app.
    function applyMqttUpdate(deviceId, reported) {
      const prev = node.devices[deviceId];
      const raw = Object.assign({}, prev ? prev.raw : {}, reported);
      const parsed = acLib.parseSnapshot(raw);
      const changedKeys = diffParsed(prev ? prev.parsed : null, parsed);
      node.devices[deviceId] = {
        device: prev ? prev.device : { deviceId, alias: deviceId },
        parsed,
        raw,
      };
      node.emitter.emit('snapshot', {
        deviceId,
        name: prev ? prev.device.alias : deviceId,
        deviceType: prev ? prev.device.deviceType : undefined,
        parsed,
        raw,
        changed: changedKeys.length > 0,
        changedKeys,
        first: false,
        source: 'mqtt',
      });
    }

    node.startMqtt = async () => {
      if (!node.realtime || mqtt || mqttStarting) {
        return;
      }
      mqttStarting = true;
      try {
        await node.client.ready();
        mqtt = new ThinQMqtt({
          client: node.client,
          keyStore: mqttKeyStore,
          logger: makeLogger(node),
          onUpdate: applyMqttUpdate,
        });
        await mqtt.start();
      } catch (err) {
        node.warn('ThinQ real-time (MQTT) unavailable, using polling only: ' + err.message);
        if (mqtt) {
          mqtt.stop();
          mqtt = null;
        }
        // Retry later; polling keeps working in the meantime.
        if (!mqttRetryTimer) {
          mqttRetryTimer = setTimeout(() => {
            mqttRetryTimer = null;
            node.startMqtt();
          }, 60000);
        }
      } finally {
        mqttStarting = false;
      }
    };

    /**
     * Subscribe to per-device snapshot events. Returns an unsubscribe fn.
     * Polling (and MQTT push) start on the first subscriber.
     */
    node.subscribe = (handler) => {
      node.emitter.on('snapshot', handler);
      subscribers += 1;
      node.startPolling();
      node.startMqtt();
      // Replay the most recent snapshots so a freshly deployed node immediately
      // gets current values.
      for (const id of Object.keys(node.devices)) {
        const entry = node.devices[id];
        handler({
          deviceId: id,
          name: entry.device.alias,
          deviceType: entry.device.deviceType,
          parsed: entry.parsed,
          raw: entry.raw,
          changed: false,
          changedKeys: [],
          first: true,
          source: 'poll',
        });
      }
      return () => {
        node.emitter.removeListener('snapshot', handler);
        subscribers = Math.max(0, subscribers - 1);
      };
    };

    node.on('close', (done) => {
      if (pollTimer) {
        clearInterval(pollTimer);
      }
      pollTimer = null;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      if (mqttRetryTimer) {
        clearTimeout(mqttRetryTimer);
        mqttRetryTimer = null;
      }
      if (mqtt) {
        mqtt.stop();
        mqtt = null;
      }
      node.emitter.removeAllListeners();
      done();
    });
  }

  RED.nodes.registerType('lg-account', LgAccountNode, {
    credentials: {
      username: { type: 'text' },
      password: { type: 'password' },
      refreshToken: { type: 'password' },
    },
  });

  // ---- Admin endpoints used by the editor ----

  // List devices for an already-deployed account config node.
  RED.httpAdmin.get(
    '/lg-account/:id/devices',
    RED.auth.needsPermission('lg-account.read'),
    async (req, res) => {
      const node = RED.nodes.getNode(req.params.id);
      if (!node || !node.getClient) {
        res.status(404).json({ error: 'Account not deployed yet. Deploy first, then list devices.' });
        return;
      }
      try {
        await node.ensureReady();
        const devices = await node.listDevices();
        res.json(
          devices.map((d) => ({
            id: d.deviceId,
            name: d.alias,
            type: d.deviceType,
            online: d.online,
          }))
        );
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    }
  );

  // Log in with posted credentials to extract a refresh token (+ device list).
  // Used by the "Extract refresh token / Test" button before the node is saved.
  RED.httpAdmin.post(
    '/lg-account/token',
    RED.auth.needsPermission('lg-account.write'),
    async (req, res) => {
      const body = req.body || {};
      if (!body.username || !body.password) {
        res.status(400).json({ error: 'username and password are required' });
        return;
      }
      try {
        const client = new ThinQClient({
          country: body.country,
          language: body.language,
          username: body.username,
          password: body.password,
        });
        await client.login();
        let devices = [];
        try {
          await client.ready();
          devices = await client.listDevices();
        } catch (e) {
          // login worked; device listing is best-effort here
        }
        res.json({
          refreshToken: client.refreshToken,
          userNumber: client.userNumber,
          devices: devices.map((d) => ({ id: d.deviceId, name: d.alias, type: d.deviceType })),
        });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    }
  );
};
