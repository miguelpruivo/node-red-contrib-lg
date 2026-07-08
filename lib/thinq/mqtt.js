'use strict';

const crypto = require('crypto');
const { URL } = require('url');
const mqtt = require('mqtt');
const forge = require('node-forge');
const axios = require('axios');

const ROUTE_URL = 'https://common.lgthinq.com/route';
const CLIENT_PATH = 'service/users/client';
const CERT_PATH = 'service/users/client/certificate';
const AMAZON_ROOT_CA_URL = 'https://www.amazontrust.com/repository/AmazonRootCA1.pem';

function noopLogger() {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}

/**
 * Generate an RSA key pair using Node's native (fast, non-blocking) crypto.
 * Returns the private key as a PKCS#1 PEM ("RSA PRIVATE KEY") which node-forge
 * can parse for signing the CSR.
 */
function generatePrivateKey() {
  return new Promise((resolve, reject) => {
    crypto.generateKeyPair(
      'rsa',
      {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      },
      (err, _publicKey, privateKey) => (err ? reject(err) : resolve(privateKey))
    );
  });
}

/**
 * Build a PKCS#10 CSR for the given private key, matching what AWS IoT expects
 * for LG ThinQ (CN "AWS IoT Certificate", O "Amazon").
 */
function createCsr(privateKeyPem) {
  const priv = forge.pki.privateKeyFromPem(privateKeyPem);
  const pub = forge.pki.setRsaPublicKey(priv.n, priv.e);
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = pub;
  csr.setSubject([
    { shortName: 'CN', value: 'AWS IoT Certificate' },
    { shortName: 'O', value: 'Amazon' },
  ]);
  csr.sign(priv, forge.md.sha256.create());
  return forge.pki.certificationRequestToPem(csr);
}

function csrBody(pem) {
  return pem.replace(/-----(BEGIN|END) CERTIFICATE REQUEST-----/g, '').replace(/(\r\n|\r|\n)/g, '');
}

/**
 * Parse an incoming MQTT payload into { deviceId, reported } or null.
 * ThinQ pushes: { deviceId, data: { state: { reported: { <airState deltas> } } } }
 */
function parseMessage(payload) {
  let body;
  try {
    body = JSON.parse(payload.toString());
  } catch (e) {
    return null;
  }
  if (!body || typeof body !== 'object') {
    return null;
  }
  const deviceId = body.deviceId;
  const reported = body.data && body.data.state && body.data.state.reported;
  if (!deviceId || !reported || typeof reported !== 'object') {
    return null;
  }
  return { deviceId, reported };
}

/**
 * Real-time ThinQ device updates over AWS IoT (MQTT). Best-effort: if anything
 * fails, the caller should keep polling.
 */
class ThinQMqtt {
  constructor(opts = {}) {
    this.client = opts.client; // ThinQClient (uses _request + clientId)
    this.keyStore = opts.keyStore || null;
    this.log = opts.logger || noopLogger();
    this.onUpdate = opts.onUpdate || (() => {});
    this.conn = null;
    this.stopped = false;
  }

  async start() {
    this.stopped = false;
    await this._connect();
  }

  async _loadOrCreateKeys() {
    let keys = this.keyStore && this.keyStore.load ? await this.keyStore.load() : null;
    if (keys && keys.privateKey && keys.csr) {
      return keys;
    }
    const privateKey = await generatePrivateKey();
    keys = { privateKey, csr: createCsr(privateKey) };
    if (this.keyStore && this.keyStore.save) {
      await this.keyStore.save(keys);
    }
    return keys;
  }

  async _connect() {
    if (this.stopped) {
      return;
    }

    const route = await this.client._request('get', ROUTE_URL).then((r) => r && r.result);
    if (!route || !route.mqttServer) {
      throw new Error('no MQTT route returned by LG');
    }

    const keys = await this._loadOrCreateKeys();

    // Register this client and request a signed certificate.
    await this.client._request('post', CLIENT_PATH, {});
    const cert = await this.client
      ._request('post', CERT_PATH, { csr: csrBody(keys.csr) })
      .then((r) => r && r.result);
    if (!cert || !cert.certificatePem) {
      throw new Error('no certificate returned by LG');
    }
    const subscriptions = Array.isArray(cert.subscriptions) ? cert.subscriptions : [];

    const u = new URL(route.mqttServer);
    const url = 'mqtts://' + u.hostname + ':' + (u.port || 8883);

    const tls = { key: keys.privateKey, cert: cert.certificatePem };
    if (/amazonaws\.com$/i.test(u.hostname)) {
      // AWS IoT (the normal case): pin the Amazon root CA.
      tls.ca = await axios.get(AMAZON_ROOT_CA_URL, { responseType: 'text' }).then((r) => r.data);
    }
    // For any other broker host we deliberately do NOT pin a CA and do NOT
    // disable verification — Node falls back to its default system CA trust
    // store. Never silently accept an unverified TLS server: server identity
    // must always be checked (mTLS only proves *our* identity to the broker).
    // MQTT is best-effort, so a genuinely untrusted host fails loudly here while
    // polling keeps working.

    const conn = mqtt.connect(url, {
      ...tls,
      clientId: this.client.clientId,
      protocolVersion: 4,
      reconnectPeriod: 5000,
      keepalive: 60,
      clean: true,
    });
    this.conn = conn;

    conn.on('connect', () => {
      this.log.info('ThinQ MQTT connected (real-time updates enabled)');
      for (const topic of subscriptions) {
        conn.subscribe(topic, (err) => {
          if (err) {
            this.log.debug('ThinQ MQTT subscribe error: ' + err.message);
          }
        });
      }
    });

    conn.on('message', (_topic, payload) => {
      const msg = parseMessage(payload);
      if (msg) {
        try {
          this.onUpdate(msg.deviceId, msg.reported);
        } catch (e) {
          this.log.debug('ThinQ MQTT onUpdate error: ' + e.message);
        }
      }
    });

    conn.on('error', (err) => {
      this.log.debug('ThinQ MQTT error: ' + (err && err.message ? err.message : err));
    });
    conn.on('close', () => this.log.debug('ThinQ MQTT connection closed'));
  }

  stop() {
    this.stopped = true;
    if (this.conn) {
      try {
        this.conn.end(true);
      } catch (e) {
        /* ignore */
      }
      this.conn = null;
    }
  }
}

module.exports = { ThinQMqtt, parseMessage, createCsr, csrBody, generatePrivateKey };
