'use strict';

const EventEmitter = require('events');
const lgtv2 = require('lgtv2');
const wol = require('./wol');

const URI_POWER_STATE = 'ssap://com.webos.service.tvpower/power/getPowerState';
const URI_TURN_OFF = 'ssap://system/turnOff';

const TURN_ON_TIMEOUT_MS = 30000;
const TURN_OFF_TIMEOUT_MS = 15000;

function noopLogger() {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}

/**
 * Interpret an LG webOS power-state response into a simple label.
 * Ported from the well-known homebridge-webos-tv logic.
 */
function interpretPowerState(res) {
  if (!res) {
    return 'Off';
  }
  const state = res.state;
  const processing = res.processing;

  if (state === 'Suspend' && !processing) {
    return 'Off';
  }
  if (processing === 'Request Suspend') {
    return 'Off';
  }
  if (state === 'Active Standby' && !processing) {
    return 'Pixel Refresher';
  }
  if (state === 'Screen Saver' && !processing) {
    return 'Screen Saver';
  }
  if (state === 'Screen Off' && processing === 'Screen On') {
    return 'Screen On';
  }
  if (state === 'Screen Off' && !processing) {
    return 'Screen Off';
  }
  if (state === 'Active' && !processing) {
    return 'On';
  }
  return 'Unknown';
}

/**
 * Persistent connection to a single LG webOS TV.
 *
 * - Control: turnOn() (Wake-on-LAN), turnOff() (ssap://system/turnOff).
 * - Monitoring: emits 'powerStateChanged' with { power, state, raw } whenever
 *   the TV goes on/off. Uses the power-state subscription when available and
 *   falls back to the websocket connection state otherwise.
 *
 * Events:
 *   'powerStateChanged' ({ power:boolean, state:string, raw })
 *   'connect'           (paired & connected)
 *   'close'             (disconnected)
 *   'prompt'            (TV is asking the user to accept pairing)
 *   'error'            (err)
 */
class WebosTv extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.host = opts.host;
    this.mac = opts.mac || null;
    this.broadcast = opts.broadcast || '255.255.255.255';
    this.name = opts.name || opts.host;
    this.keyFile = opts.keyFile;
    this.reconnect = opts.reconnect || 5000;
    this.secure = !!opts.secure;
    this.wolPort = opts.wolPort || 9;
    this.log = opts.logger || noopLogger();

    this.connected = false;
    this.powerOn = null; // null = unknown
    this.powerState = null; // last label
    this.powerStateRaw = null;
    this._powerStateSupported = true;
    this._started = false;
    this._lgtv = null;
    this._lastError = null;
  }

  url() {
    return this.secure ? `wss://${this.host}:3001` : `ws://${this.host}:3000`;
  }

  getState() {
    return {
      power: this.powerOn,
      state: this.powerState || (this.powerOn ? 'On' : 'Off'),
      connected: this.connected,
      raw: this.powerStateRaw,
    };
  }

  start() {
    if (this._started) {
      return;
    }
    this._started = true;
    this._setup();
  }

  _setup() {
    const wsconfig = {
      keepalive: true,
      keepaliveInterval: 10000,
      dropConnectionOnKeepaliveTimeout: true,
      keepaliveGracePeriod: 5000,
    };
    if (this.secure) {
      wsconfig.tlsOptions = { rejectUnauthorized: false };
    }

    this._lgtv = lgtv2({
      url: this.url(),
      timeout: 5000,
      reconnect: this.reconnect,
      keyFile: this.keyFile,
      wsconfig,
    });

    this._lgtv.on('connect', () => {
      if (!this.connected) {
        this.connected = true;
        this.log.info(`webOS TV "${this.name}": connected`);
        this.emit('connect');
        this._subscribePowerState();
      }
    });

    this._lgtv.on('close', () => {
      if (this.connected) {
        this.log.info(`webOS TV "${this.name}": disconnected`);
      }
      this.connected = false;
      this.emit('close');
      // A closed connection means the TV is unreachable -> treat as off.
      this._setPower(false, 'Off', null);
    });

    this._lgtv.on('prompt', () => {
      this.log.warn(`webOS TV "${this.name}": please accept the pairing request on the TV screen`);
      this.emit('prompt');
    });

    this._lgtv.on('error', (err) => {
      // ws -> wss fallback for TVs that require a secure socket.
      if (err && err.code === 'ECONNRESET' && !this.secure) {
        this.log.debug(`webOS TV "${this.name}": connection reset, retrying with secure websocket`);
        this.secure = true;
        this._restart();
        return;
      }
      const msg = err && err.toString();
      if (msg !== this._lastError) {
        this._lastError = msg;
        this.log.debug(`webOS TV "${this.name}" error: ${msg}`);
        this.emit('error', err);
      }
    });
  }

  _restart() {
    try {
      if (this._lgtv) {
        this._lgtv.removeAllListeners();
        this._lgtv.disconnect();
      }
    } catch (e) {
      /* ignore */
    }
    this.connected = false;
    this._setup();
  }

  _subscribePowerState() {
    this._lgtv.subscribe(URI_POWER_STATE, {}, (err, res) => {
      if (err) {
        // Older TVs don't support this service: fall back to connection state.
        this._powerStateSupported = false;
        this.log.debug(`webOS TV "${this.name}": power-state service unavailable, using connection state`);
        this._setPower(true, 'On', null);
        return;
      }
      this.powerStateRaw = res;
      const label = interpretPowerState(res);
      this._setPower(label === 'On', label, res);
    });
  }

  _setPower(power, state, raw) {
    const changed = this.powerOn !== power;
    this.powerOn = power;
    this.powerState = state;
    if (raw !== undefined) {
      this.powerStateRaw = raw;
    }
    if (changed) {
      this.log.debug(`webOS TV "${this.name}": power -> ${power ? 'ON' : 'OFF'} (${state})`);
      this.emit('powerStateChanged', { power, state, raw: this.powerStateRaw });
    }
  }

  /**
   * Promisified request to the TV.
   */
  request(uri, payload = {}) {
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        reject(new Error('TV is not connected'));
        return;
      }
      this._lgtv.request(uri, payload, (err, res) => {
        if (err) {
          reject(err);
        } else {
          resolve(res);
        }
      });
    });
  }

  /**
   * Turn the TV on via Wake-on-LAN, then wait until it reports as on.
   */
  async turnOn() {
    if (!this.mac) {
      throw new Error('Cannot turn on TV: no MAC address configured (required for Wake-on-LAN)');
    }
    await wol.wake(this.mac, { address: this.broadcast, port: this.wolPort });
    this.log.debug(`webOS TV "${this.name}": sent Wake-on-LAN to ${this.mac}`);

    // Nudge a connection attempt.
    if (this._lgtv && !this.connected) {
      try {
        this._lgtv.connect(this.url());
      } catch (e) {
        /* lgtv2 reconnects on its own */
      }
    }

    if (this.powerOn === true) {
      return this.getState();
    }
    return this._waitForPower(true, TURN_ON_TIMEOUT_MS);
  }

  /**
   * Turn the TV off (standby) via the webOS API.
   */
  async turnOff() {
    if (this.powerOn === false) {
      return this.getState();
    }
    if (!this.connected) {
      throw new Error('Cannot turn off TV: not connected (TV may already be off)');
    }
    await this.request(URI_TURN_OFF, {});
    this.log.debug(`webOS TV "${this.name}": sent turn off`);
    return this._waitForPower(false, TURN_OFF_TIMEOUT_MS);
  }

  async toggle() {
    if (this.powerOn) {
      return this.turnOff();
    }
    return this.turnOn();
  }

  _waitForPower(target, timeoutMs) {
    return new Promise((resolve) => {
      let timer = null;
      const onChange = ({ power }) => {
        if (power === target) {
          cleanup();
          resolve(this.getState());
        }
      };
      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
        }
        this.removeListener('powerStateChanged', onChange);
      };
      this.on('powerStateChanged', onChange);
      timer = setTimeout(() => {
        cleanup();
        resolve(this.getState());
      }, timeoutMs);
    });
  }

  stop() {
    this._started = false;
    try {
      if (this._lgtv) {
        this._lgtv.removeAllListeners();
        this._lgtv.disconnect();
      }
    } catch (e) {
      /* ignore */
    }
    this._lgtv = null;
    this.connected = false;
  }
}

module.exports = { WebosTv, interpretPowerState };
