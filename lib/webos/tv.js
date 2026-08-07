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
// A healthy *disconnected* client cycles connecting -> close/error every
// `reconnect` ms. Staying silent longer than this means it is stuck rather than
// retrying, and only a fresh client recovers it (see _checkStalled).
// Headroom matters: a dark TV cycles roughly every (OS connect timeout +
// reconnect) — measured ~12s on a LAN that answers ENETUNREACH — and that is
// healthy retrying, not a stall. Only rebuild when it goes quiet well past that.
const WATCHDOG_MS = 30000;

function noopLogger() {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}

/**
 * `processing` values that mean the TV is on its way down. webOS names this
 * transition several different ways in a single power-off ("Request Power Off",
 * "Request Power Off Logo", "Request Active Standby", "Prepare Active Standby",
 * "Request Suspend"), so match the phrase rather than enumerate exact strings.
 *
 * Deliberately does NOT match a bare "Request Active" (that is the TV waking).
 */
const POWERING_DOWN_RE = /power off|active standby|suspend/i;

function isPoweringDown(res) {
  const processing = res.processing;
  if (processing && POWERING_DOWN_RE.test(processing)) {
    return true;
  }
  // Explicit intent with no transition name attached.
  return res.onOff === 'off' && !processing;
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

  // A remote power-off is announced the instant the key is pressed, but `state`
  // lags ~3s behind it. Measured on a real TV:
  //   t+0.00  {state:'Active', processing:'Request Power Off',     onOff:'off', reason:'remoteKey'}
  //   t+0.04  {state:'Active', processing:'Request Power Off Logo', onOff:'off', ...}
  //   t+3.12  {state:'Active', processing:'Request Active Standby', onOff:'off', ...}
  //   t+3.20  {state:'Active Standby'}
  // Keying off `state` alone made every one of those read as 'Unknown' (=> ON)
  // and only caught up on the last message — the few-second power-off lag. The
  // announcement is the TV stating its own intent, so trust it immediately.
  // This is a positive signal, not an inference from a dropped socket, so it
  // cannot reintroduce the off/on flapping the off-grace timer exists to stop.
  if (isPoweringDown(res)) {
    return 'Off';
  }

  if (state === 'Suspend' && !processing) {
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
  if (res.onOff === 'on') {
    return 'On'; // symmetric: the TV announcing it is coming up
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
    this.watchdogMs = Number.isFinite(opts.watchdogMs)
      ? opts.watchdogMs
      : Math.max(WATCHDOG_MS, this.reconnect * 6);

    // Transport auto-detection. `secure` is only a starting point: whichever
    // transport actually completes a pairing handshake wins and is locked in
    // (`_provenSecure`). Until one does, the watchdog alternates ws <-> wss, so
    // a wrong Secure setting self-corrects instead of stranding the node on a
    // port the TV does not serve. `_transportSince` times the current attempt.
    this._provenSecure = null;
    this._transportSince = Date.now(); // never 0: an unset clock reads as "expired"
    this._lastActivityAt = 0;
    this._startedAt = 0;
    this._watchdogTimer = null;

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
    this._startWatchdog();
  }

  /**
   * Supervise the connection. `lgtv2` only schedules a reconnect from its
   * 'connectFailed' and 'close' handlers, and neither fires when an attempt
   * gets stuck — which happens for real:
   *
   *   - the TV accepts the websocket but never answers the pairing 'register'
   *     message (common while webOS is still booting). lgtv2 arms a response
   *     timeout for 'request' messages only, never for 'register', so the
   *     callback never fires, no 'connect' is emitted, and the socket stays
   *     open forever — ws keepalive cannot save it either, because the TV's
   *     framing layer keeps answering pings while its app layer is wedged.
   *   - the TV's NIC is dark, so the connect black-holes until the OS gives up.
   *
   * Both look identical from here: no client events at all. A client that is
   * healthy-but-disconnected emits 'connecting' (and a close/error) every
   * `reconnect` ms, so silence past watchdogMs means stuck — rebuild the client.
   * Restarting while the TV is genuinely off is harmless: it just retries.
   */
  _startWatchdog() {
    if (this._watchdogTimer || !this.watchdogMs) {
      return;
    }
    this._noteActivity();
    this._startedAt = Date.now();
    this._transportSince = Date.now();
    const period = Math.max(1000, Math.round(this.watchdogMs / 4));
    this._watchdogTimer = setInterval(() => this._checkStalled(), period);
    if (this._watchdogTimer.unref) {
      this._watchdogTimer.unref(); // never hold Node-RED (or the test runner) open
    }
  }

  _noteActivity() {
    this._lastActivityAt = Date.now();
  }

  _checkStalled() {
    if (this.connected) {
      this._noteActivity();
      return;
    }
    // Still no state at all after a full window of failed attempts: publish
    // off. A TV whose NIC is dark never produces a 'close' (only connect
    // failures), so without this a restart while the TV is off leaves
    // downstream flows with no state until someone turns it on.
    if (this.powerOn === null && Date.now() - this._startedAt >= this.watchdogMs) {
      this._setPower(false, 'Off', null);
    }

    // Still cycling connecting -> failure means it is retrying normally, not stuck.
    const silent = Date.now() - this._lastActivityAt >= this.watchdogMs;
    // A transport that has never completed a pairing handshake despite a full
    // window of attempts may simply be the wrong one for this TV (old models
    // serve only ws://:3000, newer ones can refuse it and require wss://:3001).
    // The ECONNRESET fast path catches the common case; this catches the rest,
    // including a Secure setting that is wrong in the wss->ws direction.
    const transportUnproven =
      this._provenSecure === null && Date.now() - this._transportSince >= this.watchdogMs;

    if (!silent && !transportUnproven) {
      return;
    }
    if (transportUnproven) {
      this._setTransport(!this.secure, `no handshake over ${this.secure ? 'wss' : 'ws'}`);
    } else {
      this.log.debug(`webOS TV "${this.name}": no connection activity for ${this.watchdogMs}ms, rebuilding the client`);
    }
    this._restart();
  }

  _stopWatchdog() {
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
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

    // Emitted on every (re)connect attempt, and — unlike 'error' — never
    // deduplicated by lgtv2, so it is the heartbeat the watchdog relies on.
    this._lgtv.on('connecting', () => this._noteActivity());

    this._lgtv.on('connect', () => {
      this._noteActivity();
      if (!this.connected) {
        this.connected = true;
        this._provenSecure = this.secure; // this transport completes a handshake
        this.log.info(`webOS TV "${this.name}": connected`);
        this.emit('connect');
        this._subscribePowerState();
      }
    });

    this._lgtv.on('close', () => {
      this._noteActivity();
      this._handleDisconnect();
    });

    this._lgtv.on('prompt', () => {
      this.log.warn(`webOS TV "${this.name}": please accept the pairing request on the TV screen`);
      this.emit('prompt');
    });

    this._lgtv.on('error', (err) => {
      this._noteActivity();
      // ws -> wss fallback for TVs that require a secure socket. Note a TV in
      // standby can also reset the ws upgrade, so this fallback fires on
      // healthy hardware too — hence _provenSecure gating the revert below.
      if (err && err.code === 'ECONNRESET' && !this.secure) {
        this._setTransport(true, 'connection reset');
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

  /**
   * Switch transport and restart the attempt window. Callers decide the policy;
   * this only records it. Never called once `_provenSecure` is set.
   */
  _setTransport(secure, why) {
    this.secure = secure;
    this._transportSince = Date.now();
    this.log.debug(`webOS TV "${this.name}": ${why}, trying ${secure ? 'wss://…:3001' : 'ws://…:3000'}`);
  }

  /**
   * Rebuild the lgtv2 client on the *current* transport. Deliberately does not
   * touch `secure`: the ws->wss fallback applies its flip by restarting, so
   * changing the transport here would undo that flip and spin in a tight loop
   * against any TV that refuses plain ws.
   */
  _restart() {
    this._teardownClient();
    this.connected = false;
    this._noteActivity();
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
    this._stopWatchdog();
    this._teardownClient();
    this.connected = false;
  }
}

module.exports = { WebosTv, interpretPowerState, isPoweredOn };
