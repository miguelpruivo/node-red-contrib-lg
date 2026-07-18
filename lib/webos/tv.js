'use strict';

const EventEmitter = require('events');
const lgtv2 = require('lgtv2');
const wol = require('./wol');

const URI_POWER_STATE = 'ssap://com.webos.service.tvpower/power/getPowerState';
const URI_TURN_OFF = 'ssap://system/turnOff';

const TURN_ON_TIMEOUT_MS = 30000;
const TURN_OFF_TIMEOUT_MS = 15000;
// Extra slack on top of the reconnect interval before a bare websocket close
// is reported as power-off (covers one reconnect attempt + register/subscribe).
const OFF_GRACE_EXTRA_MS = 5000;

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
 * Power-state labels that mean the TV is genuinely OFF. Everything else
 * (Active/On, Screen Saver, Screen Off, Screen On, Unknown, ...) keeps the TV
 * reported as ON.
 *
 * The screensaver and a blanked screen are *panel* states while the TV is still
 * powered — not a power-off — so they must not flip the reported power (this is
 * what other webOS integrations do, and what HomeKit/automations expect). A real
 * power-off shows up as 'Off' (Suspend), the 'Pixel Refresher' (Active Standby)
 * overnight maintenance mode, or — most reliably — a dropped websocket connection
 * (the 'close' handler, which forces OFF regardless).
 */
const OFF_POWER_STATES = new Set(['Off', 'Pixel Refresher']);

function isPoweredOn(label) {
  return !OFF_POWER_STATES.has(label);
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

    this.offGraceMs = Number.isFinite(opts.offGraceMs)
      ? opts.offGraceMs
      : this.reconnect + OFF_GRACE_EXTRA_MS;

    this.connected = false;
    this.powerOn = null; // null = unknown
    this.powerState = null; // last label
    this.powerStateRaw = null;
    this._powerStateSupported = true;
    this._started = false;
    this._lgtv = null;
    this._lastError = null;
    this._offGraceTimer = null;
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

    this._lgtv.on('close', () => this._handleDisconnect());

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
        this._emitError(err);
      }
    });
  }

  /**
   * Emit an 'error' event only if someone is listening. Node throws when an
   * EventEmitter emits 'error' with no listeners, which (for a TV that is off
   * and constantly failing to connect) would crash the whole Node-RED process.
   */
  _emitError(err) {
    if (this.listenerCount('error') > 0) {
      this.emit('error', err);
    }
  }

  /**
   * Tear down the current lgtv2 client safely. After removing our listeners we
   * leave a no-op 'error' listener on the old client so that any connection
   * attempt still in flight (very likely while the TV is off) fails quietly
   * instead of throwing an uncaught exception.
   */
  _teardownClient() {
    const client = this._lgtv;
    this._lgtv = null;
    if (!client) {
      return;
    }
    try {
      client.removeAllListeners();
      client.on('error', () => {});
      client.disconnect();
    } catch (e) {
      /* ignore */
    }
  }

  _restart() {
    this._teardownClient();
    this.connected = false;
    this._setup();
  }

  /**
   * The websocket closed. This does NOT immediately mean the TV is off: a
   * Wi-Fi hiccup, a busy TV missing a keepalive pong, or a webOS-side reset
   * drops the connection too, and lgtv2 reconnects a few seconds later —
   * reporting off here used to flap the power off->on on every such drop.
   *
   * A *real* power-off is announced by the power-state subscription (Suspend)
   * before the socket dies, so it is reported instantly by that path and this
   * handler sees powerOn already false. Only when the TV was still believed ON
   * do we wait offGraceMs (reconnect interval + slack) for the connection to
   * come back; any power-state update meanwhile cancels the pending off.
   */
  _handleDisconnect() {
    if (this.connected) {
      this.log.info(`webOS TV "${this.name}": disconnected`);
    }
    this.connected = false;
    this.emit('close');

    if (this.powerOn !== true) {
      // Already off/unknown: keep the previous instant behaviour.
      this._setPower(false, 'Off', null);
      return;
    }
    if (this._offGraceTimer) {
      return; // a grace window is already running
    }
    this.log.debug(`webOS TV "${this.name}": connection lost while on, waiting ${this.offGraceMs}ms before reporting off`);
    this._offGraceTimer = setTimeout(() => {
      this._offGraceTimer = null;
      if (!this.connected) {
        this._setPower(false, 'Off', null);
      }
    }, this.offGraceMs);
  }

  _clearOffGrace() {
    if (this._offGraceTimer) {
      clearTimeout(this._offGraceTimer);
      this._offGraceTimer = null;
    }
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
      this._setPower(isPoweredOn(label), label, res);
    });
  }

  _setPower(power, state, raw) {
    this._clearOffGrace();
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
    this._clearOffGrace();
    this._teardownClient();
    this.connected = false;
  }
}

module.exports = { WebosTv, interpretPowerState, isPoweredOn };
