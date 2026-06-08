'use strict';

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const { ThinQClient } = require('../lib/thinq/client');
const acLib = require('../lib/thinq/ac');
const { storageDir, makeLogger, diffParsed } = require('../lib/red-helpers');

module.exports = function (RED) {
  function LgAccountNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.country = (config.country || 'US').toUpperCase();
    node.language = config.language || 'en-US';
    node.pollInterval = Math.max(parseInt(config.pollInterval, 10) || 60, 10); // seconds, min 10

    const creds = node.credentials || {};
    const tokenFile = path.join(storageDir(RED), `thinq-${node.id}.token`);

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
        fs.writeFileSync(tokenFile, t, { mode: 0o600 });
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

    node.emitter = new EventEmitter();
    node.emitter.setMaxListeners(0);
    node.devices = {}; // deviceId -> { device, parsed, raw }

    node.getClient = () => node.client;
    node.ensureReady = () => node.client.ready();
    node.listDevices = () => node.client.listDevices();

    let pollTimer = null;
    let polling = false;
    let subscribers = 0;

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
          });
        }
        node.status({ fill: 'green', shape: 'dot', text: `${devices.length} device(s)` });
      } catch (err) {
        node.warn('ThinQ poll error: ' + err.message);
        node.status({ fill: 'red', shape: 'ring', text: 'auth/poll error' });
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

    /**
     * Subscribe to per-device snapshot events. Returns an unsubscribe fn.
     * Polling starts on the first subscriber.
     */
    node.subscribe = (handler) => {
      node.emitter.on('snapshot', handler);
      subscribers += 1;
      node.startPolling();
      // Replay the most recent snapshots so a freshly deployed status node
      // immediately gets current values.
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
