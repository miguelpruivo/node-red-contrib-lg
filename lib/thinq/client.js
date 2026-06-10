'use strict';

const crypto = require('crypto');
const qs = require('qs');
const axios = require('axios');
const C = require('./constants');

const TOKEN_EXPIRED_CODE = '0102';

// Result codes that mean "the device couldn't apply the command right now"
// (busy / still settling). These are worth retrying after a short delay.
const TRANSIENT_RESULT_CODES = ['0103'];

function rfc2822(date = new Date()) {
  // luxon's toRFC2822() produces "...+0000"; toUTCString() ends with "GMT".
  return date.toUTCString().replace(/ GMT$/, ' +0000');
}

// Best-effort, human-readable explanations for the LG ThinQ result codes we
// are most likely to hit when controlling a device.
const LG_RESULT_CODES = {
  '0000': 'success',
  '0001': 'invalid request (bad value, or the AC is off and cannot accept this setting)',
  '0002': 'invalid parameter',
  '0004': 'partial failure',
  '0103': 'device busy / could not apply right now (e.g. fan speed while in an auto-managed mode, or too soon after a power/mode change) — retried automatically',
  '0102': 'access token expired',
  '0106': 'device not connected',
  '0110': 'new terms must be accepted in the LG app',
  '0111': 'device not connected',
  '8001': 'operation not supported by this device',
};

function describeLgError(code, body, status) {
  const known = code && LG_RESULT_CODES[code];
  if (code) {
    return `resultCode ${code}${known ? ' - ' + known : ''}`;
  }
  const msg = body && (body.message || (body.error && body.error.message));
  if (msg) {
    return msg;
  }
  return `HTTP ${status || 'error'}`;
}

function decodeUrlMaybe(value) {
  if (!value || typeof value !== 'string') {
    return value;
  }
  return value.indexOf('%') !== -1 ? decodeURIComponent(value) : value;
}

function noopLogger() {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}

function pickErrorMessage(err, fallback) {
  const data = err && err.response && err.response.data;
  return (
    (data && data.error && data.error.message) ||
    (data && data.message) ||
    (data && data.error_description) ||
    (data && data.returnMsg) ||
    (err && err.message) ||
    fallback
  );
}

/**
 * Minimal, dependency-light client for the (unofficial) LG ThinQ v2 API.
 *
 * Responsibilities:
 *   - gateway discovery
 *   - login with username/password to obtain a refresh token
 *   - refresh the access token from a refresh token
 *   - list devices + read their snapshots
 *   - send control commands to a device
 *
 * The refresh token is the long-lived credential. Once obtained it is handed
 * back through the optional `tokenStore` so it can be persisted and reused on
 * the next start without logging in again.
 */
class ThinQClient {
  constructor(opts = {}) {
    this.country = (opts.country || 'US').toUpperCase();
    this.language = opts.language || 'en-US';
    this.username = opts.username || null;
    this.password = opts.password || null;
    this.refreshToken = opts.refreshToken || null;
    this.tokenStore = opts.tokenStore || null;
    this.log = opts.logger || noopLogger();

    this.accessToken = null;
    this.expiresAt = 0; // epoch seconds
    this.userNumber = null;
    this.clientId = null;
    this._gateway = null;
    this.lgeapiUrl = `https://${this.country.toLowerCase()}.lgeapi.com/`;

    this.http = axios.create({ timeout: 60000 });
    this._readyPromise = null;
    this._deviceLocks = {}; // deviceId -> promise chain (per-device serialization)
  }

  /**
   * Run `fn` exclusively for a device: operations for the same deviceId are
   * queued and executed strictly one-at-a-time, in call order. This prevents
   * concurrent Node-RED messages from sending overlapping control commands to
   * the same AC, which the unit can reject with 0103 (or react to by powering
   * off). Different devices run in parallel.
   */
  withDeviceLock(deviceId, fn) {
    const prev = this._deviceLocks[deviceId] || Promise.resolve();
    const run = prev.then(fn, fn);
    // Keep the chain alive regardless of whether fn resolves or rejects.
    this._deviceLocks[deviceId] = run.then(() => undefined, () => undefined);
    return run;
  }

  signature(message, secret) {
    return crypto.createHmac('sha1', Buffer.from(secret)).update(message).digest('base64');
  }

  get defaultEmpHeaders() {
    return {
      Accept: 'application/json',
      'X-Application-Key': C.APPLICATION_KEY,
      'X-Client-App-Key': C.CLIENT_ID,
      'X-Lge-Svccode': 'SVC709',
      'X-Device-Type': 'M01',
      'X-Device-Platform': 'ADR',
      'X-Device-Language-Type': 'IETF',
      'X-Device-Publish-Flag': 'Y',
      'X-Device-Country': this.country,
      'X-Device-Language': this.language,
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'Access-Control-Allow-Origin': '*',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept-Language': 'en-US,en;q=0.9',
    };
  }

  get defaultHeaders() {
    const headers = {
      'x-api-key': C.API_KEY,
      'x-thinq-app-ver': '3.6.1200',
      'x-thinq-app-type': 'NUTS',
      'x-thinq-app-level': 'PRD',
      'x-thinq-app-os': 'ANDROID',
      'x-thinq-app-logintype': 'LGE',
      'x-service-code': 'SVC202',
      'x-country-code': this.country,
      'x-language-code': this.language,
      'x-service-phase': 'OP',
      'x-origin': 'app-native',
      'x-model-name': 'samsung/SM-G930L',
      'x-os-version': 'AOS/7.1.2',
      'x-app-version': 'LG ThinQ/3.6.12110',
      'x-message-id': randomString(22),
      'user-agent': 'okhttp/3.14.9',
      'x-client-id': this.clientId || C.API_CLIENT_ID,
    };
    if (this.accessToken) {
      headers['x-emp-token'] = this.accessToken;
    }
    if (this.userNumber) {
      headers['x-user-no'] = this.userNumber;
    }
    return headers;
  }

  // -------- gateway --------

  async getGateway() {
    if (this._gateway) {
      return this._gateway;
    }
    const res = await this.http.get(C.GATEWAY_URL, { headers: this.defaultHeaders });
    this._gateway = res.data.result;
    return this._gateway;
  }

  // -------- login (username/password -> refresh token) --------

  async login() {
    if (!this.username || !this.password) {
      throw new Error('ThinQ: username and password are required to obtain a refresh token');
    }
    const gateway = await this.getGateway();
    const loginBase = gateway.empSpxUri + '/';
    const empBase = gateway.empTermsUri + '/';

    const hashedPassword = crypto.createHash('sha512').update(this.password).digest('hex');
    const headers = { ...this.defaultEmpHeaders };

    // 1) pre-login: get a fresh signature/timestamp and re-encrypted password
    const preLoginData = {
      user_auth2: hashedPassword,
      log_param:
        'login request / user_id : ' + this.username +
        ' / third_party : null / svc_list : SVC202,SVC710 / 3rd_service : ',
    };
    const preLogin = await this.http
      .post(loginBase + 'preLogin', qs.stringify(preLoginData), { headers })
      .then((r) => r.data)
      .catch((err) => {
        throw new Error('ThinQ pre-login failed: ' + pickErrorMessage(err, 'request failed'));
      });

    headers['X-Signature'] = preLogin.signature;
    headers['X-Timestamp'] = preLogin.tStamp;

    // 2) account session login
    const sessionData = {
      user_auth2: preLogin.encrypted_pw,
      password_hash_prameter_flag: 'Y',
      svc_list: 'SVC202,SVC710',
    };
    const loginUrl = empBase + 'emp/v2.0/account/session/' + encodeURIComponent(this.username);
    const account = await this.http
      .post(loginUrl, qs.stringify(sessionData), { headers })
      .then((r) => r.data.account)
      .catch((err) => {
        throw new Error('ThinQ account login failed: ' + pickErrorMessage(err, 'check username/password & country'));
      });

    // 3) dynamic OAuth secret key
    const secretKey = await this.http
      .get(loginBase + 'searchKey?key_name=OAUTH_SECRETKEY&sever_type=OP')
      .then((r) => r.data.returnData)
      .catch((err) => {
        throw new Error('ThinQ OAuth key lookup failed: ' + pickErrorMessage(err, 'request failed'));
      });

    // 4) authorize -> redirect uri containing the auth code
    const timestamp = rfc2822();
    const empData = {
      account_type: account.userIDType,
      client_id: C.CLIENT_ID,
      country_code: account.country,
      redirect_uri: 'lgaccount.lgsmartthinq:/',
      response_type: 'code',
      state: '12345',
      username: account.userID,
    };
    const empUrl = new URL('https://emp-oauth.lgecloud.com/emp/oauth2/authorize/empsession?' + qs.stringify(empData));
    const empSignature = this.signature(`${empUrl.pathname}${empUrl.search}\n${timestamp}`, secretKey);
    const empHeaders = {
      'lgemp-x-app-key': C.OAUTH_CLIENT_KEY,
      'lgemp-x-date': timestamp,
      'lgemp-x-session-key': account.loginSessionID,
      'lgemp-x-signature': empSignature,
      Accept: 'application/json',
      'X-Device-Type': 'M01',
      'X-Device-Platform': 'ADR',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Access-Control-Allow-Origin': '*',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/93.0.4577.63 Safari/537.36 Edg/93.0.961.44',
    };
    const authorize = await this.http
      .get(empUrl.href, { headers: empHeaders })
      .then((r) => r.data)
      .catch((err) => {
        throw new Error('ThinQ OAuth authorize failed: ' + pickErrorMessage(err, 'request failed'));
      });
    if (authorize.status !== 1) {
      throw new Error('ThinQ OAuth authorize rejected: ' + (authorize.message || JSON.stringify(authorize)));
    }

    // 5) exchange the code for access + refresh tokens
    const redirectUri = new URL(authorize.redirect_uri);
    const tokenData = {
      code: redirectUri.searchParams.get('code'),
      grant_type: 'authorization_code',
      redirect_uri: empData.redirect_uri,
    };
    const backendUrl = redirectUri.searchParams.get('oauth2_backend_url');
    const tokenPath = '/oauth/1.0/oauth2/token?' + qs.stringify(tokenData);
    const tokenSignature = this.signature(`${tokenPath}\n${timestamp}`, C.OAUTH_SECRET_KEY);

    const token = await this.http
      .post(backendUrl + 'oauth/1.0/oauth2/token', qs.stringify(tokenData), {
        headers: {
          'x-lge-app-os': 'ADR',
          'x-lge-appkey': C.CLIENT_ID,
          'x-lge-oauth-signature': tokenSignature,
          'x-lge-oauth-date': timestamp,
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      })
      .then((r) => r.data)
      .catch((err) => {
        throw new Error('ThinQ token exchange failed: ' + pickErrorMessage(err, 'request failed'));
      });

    // The token response often returns oauth2_backend_url percent-encoded.
    this.lgeapiUrl = decodeUrlMaybe(token.oauth2_backend_url) || this.lgeapiUrl;
    this.accessToken = token.access_token;
    this.refreshToken = token.refresh_token;
    this.expiresAt = nowSeconds() + parseInt(token.expires_in, 10);

    await this._persistToken();
    this.log.info('ThinQ: logged in and obtained a refresh token');
    return this.refreshToken;
  }

  // -------- refresh access token from refresh token --------

  async refreshAccessToken() {
    if (!this.refreshToken) {
      throw new Error('ThinQ: no refresh token available');
    }

    // try to resolve the regional oauth backend (best effort)
    try {
      const g = await this.http
        .post(
          'https://kic.lgthinq.com:46030/api/common/gatewayUriList',
          { lgedmRoot: { countryCode: this.country, langCode: this.language } },
          {
            headers: {
              Accept: 'application/json',
              'x-thinq-application-key': 'wideq',
              'x-thinq-security-key': 'nuts_securitykey',
            },
          }
        )
        .then((r) => r.data.lgedmRoot);
      if (g && g.oauthUri) {
        this.lgeapiUrl = decodeUrlMaybe(g.oauthUri) + '/';
      }
    } catch (err) {
      // non-fatal, fall back to current lgeapiUrl
    }

    const data = { grant_type: 'refresh_token', refresh_token: this.refreshToken };
    const timestamp = rfc2822();
    const requestUrl = '/oauth/1.0/oauth2/token' + qs.stringify(data, { addQueryPrefix: true });
    const signature = this.signature(`${requestUrl}\n${timestamp}`, C.OAUTH_SECRET_KEY);

    const resp = await this.http
      .post(this.lgeapiUrl + 'oauth/1.0/oauth2/token', qs.stringify(data), {
        headers: {
          'x-lge-app-os': 'ADR',
          'x-lge-appkey': C.CLIENT_ID,
          'x-lge-oauth-signature': signature,
          'x-lge-oauth-date': timestamp,
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      })
      .then((r) => r.data)
      .catch((err) => {
        throw new Error('ThinQ token refresh failed: ' + pickErrorMessage(err, 'refresh token may be invalid'));
      });

    this.accessToken = resp.access_token;
    this.expiresAt = nowSeconds() + parseInt(resp.expires_in, 10);
    this.log.debug('ThinQ: access token refreshed');
    return this.accessToken;
  }

  async getUserNumber() {
    const profileUrl = this.lgeapiUrl + 'users/profile';
    const timestamp = rfc2822();
    const signature = this.signature(`/users/profile\n${timestamp}`, C.OAUTH_SECRET_KEY);
    const resp = await this.http
      .get(profileUrl, {
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer ' + this.accessToken,
          'X-Lge-Svccode': 'SVC202',
          'X-Application-Key': C.APPLICATION_KEY,
          'lgemp-x-app-key': C.CLIENT_ID,
          'X-Device-Type': 'M01',
          'X-Device-Platform': 'ADR',
          'x-lge-oauth-date': timestamp,
          'x-lge-oauth-signature': signature,
        },
      })
      .then((r) => r.data);
    if (resp.status === 2) {
      throw new Error('ThinQ profile lookup failed: ' + resp.message);
    }
    this.userNumber = resp.account.userNo;
    return this.userNumber;
  }

  // -------- readiness --------

  async ready() {
    if (!this._readyPromise) {
      this._readyPromise = this._doReady().catch((err) => {
        this._readyPromise = null; // allow retry on next call
        throw err;
      });
    }
    return this._readyPromise;
  }

  async _doReady() {
    await this.getGateway();

    // Prefer a stored refresh token; otherwise log in.
    if (!this.refreshToken && this.tokenStore && this.tokenStore.load) {
      const stored = await this.tokenStore.load();
      if (stored) {
        this.refreshToken = stored;
        this.log.debug('ThinQ: loaded refresh token from store');
      }
    }

    if (!this.refreshToken) {
      await this.login(); // sets access + refresh tokens
    }

    if (!this.accessToken || nowSeconds() >= this.expiresAt - 60) {
      await this.refreshAccessToken();
    }

    if (!this.userNumber) {
      await this.getUserNumber();
    }

    if (!this.clientId) {
      this.clientId = crypto
        .createHash('sha256')
        .update(this.userNumber + Date.now())
        .digest('hex');
    }
  }

  async _persistToken() {
    if (this.tokenStore && this.tokenStore.save && this.refreshToken) {
      try {
        await this.tokenStore.save(this.refreshToken);
      } catch (err) {
        this.log.warn('ThinQ: could not persist refresh token: ' + err.message);
      }
    }
  }

  // -------- authenticated requests --------

  async _request(method, uri, data, retry = false) {
    const gateway = await this.getGateway();
    const base = gateway.thinq2Uri + '/';
    const url = /^https?:\/\//.test(uri) ? uri : base + uri;

    try {
      const res = await this.http.request({ method, url, data, headers: this.defaultHeaders });
      const body = res.data;
      if (body && typeof body === 'object' && body.resultCode && body.resultCode !== '0000') {
        if (body.resultCode === TOKEN_EXPIRED_CODE && !retry) {
          await this.refreshAccessToken();
          return this._request(method, uri, data, true);
        }
        const err = new Error(`ThinQ API error ${body.resultCode}`);
        err.resultCode = body.resultCode;
        err.body = body;
        throw err;
      }
      return body;
    } catch (err) {
      const resp = err.response;
      const status = resp && resp.status;
      const lgBody = resp && resp.data;
      const code = lgBody && (lgBody.resultCode || (lgBody.result && lgBody.result.resultCode));
      if ((status === 401 || code === TOKEN_EXPIRED_CODE) && !retry) {
        await this.refreshAccessToken();
        return this._request(method, uri, data, true);
      }
      // Surface the reason LG actually returned (the bare axios message only
      // says "status code 400"); the resultCode tells us what was wrong.
      if (resp) {
        const reason = describeLgError(code, lgBody, status);
        const e = new Error(`ThinQ ${method.toUpperCase()} ${uri} failed: ${reason}`);
        e.resultCode = code;
        e.status = status;
        e.body = lgBody;
        e.sent = data;
        throw e;
      }
      throw err;
    }
  }

  async listHomes() {
    const data = await this._request('get', 'service/homes');
    return (data && data.result && data.result.item) || [];
  }

  async listDevices() {
    const homes = await this.listHomes();
    const devices = [];
    const seen = new Set();
    for (const home of homes) {
      const resp = await this._request('get', 'service/homes/' + home.homeId);
      const list = (resp && resp.result && resp.result.devices) || [];
      for (const d of list) {
        if (d && d.deviceId && !seen.has(d.deviceId)) {
          seen.add(d.deviceId);
          devices.push(d);
        }
      }
    }
    return devices;
  }

  async getDevice(deviceId) {
    const data = await this._request('get', 'service/devices/' + deviceId);
    return data && data.result;
  }

  /**
   * Send a single control command to a device.
   * For ThinQ2 ACs this is a control-sync "Set" with a dataKey/dataValue pair.
   */
  async sendCommand(deviceId, dataKey, dataValue, opts = {}) {
    const command = opts.command || 'Set';
    const ctrlKey = opts.ctrlKey || 'basicCtrl';
    const ctrlPath = opts.ctrlPath || 'control-sync';
    const body = { ctrlKey, command, dataKey, dataValue };

    // A device can transiently reject a control (resultCode 0103) when it is
    // busy or still settling after a power/mode change. Retry a few times.
    const maxAttempts = (opts.retries != null ? opts.retries : 2) + 1;
    const retryDelayMs = opts.retryDelayMs != null ? opts.retryDelayMs : 1200;

    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        return await this._request('post', `service/devices/${deviceId}/${ctrlPath}`, body);
      } catch (err) {
        if (attempt < maxAttempts && TRANSIENT_RESULT_CODES.includes(err && err.resultCode)) {
          this.log.debug(`ThinQ ${dataKey}=${dataValue} got ${err.resultCode}, retrying (${attempt}/${maxAttempts - 1})`);
          await sleep(retryDelayMs);
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Send several { dataKey, dataValue } commands sequentially. An optional
   * opts.delayMs spaces them out (the AC can reject a setting sent immediately
   * after a power-on, while it is still starting up).
   */
  async sendCommands(deviceId, commands, opts = {}) {
    const results = [];
    for (let i = 0; i < commands.length; i++) {
      if (i > 0 && opts.delayMs) {
        await sleep(opts.delayMs);
      }
      const cmd = commands[i];
      results.push(await this.sendCommand(deviceId, cmd.dataKey, cmd.dataValue, opts));
    }
    return results;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowSeconds() {
  return Math.round(Date.now() / 1000);
}

function randomString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < length; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

module.exports = { ThinQClient, rfc2822 };
