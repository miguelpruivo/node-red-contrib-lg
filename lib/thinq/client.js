'use strict';

const crypto = require('crypto');
const qs = require('qs');
const axios = require('axios');
const C = require('./constants');

const TOKEN_EXPIRED_CODE = '0102';

// Result codes that mean "the device couldn't apply the command right now"
// (busy / still settling). These are worth retrying after a short delay.
const TRANSIENT_RESULT_CODES = ['0103'];

// LG's two answers when the RFC-2822 timestamp we signed a request with is too
// far from *their* clock. Both measured live against the real endpoints:
//   clock behind -> "Time of request execution exceeded."
//   clock ahead  -> "Can't handle requests from the future."
// The window is tight: 30 min behind is already rejected by the OAuth authorize
// step, and 1 h behind by the token endpoint. Matching only the first message
// would leave a host whose clock runs *ahead* stuck in the same storm.
const CLOCK_SKEW_RE = /time of request execution exceeded|requests? from the future/i;

// Skew worth telling the user about (below this it is just network latency).
const CLOCK_SKEW_WARN_MS = 60 * 1000;

// A full username/password login costs five requests against LG's
// rate-limited endpoints, so it must never run once per poll.
const FALLBACK_LOGIN_MIN_INTERVAL_MS = 5 * 60 * 1000;

function rfc2822(date = new Date()) {
  // luxon's toRFC2822() produces "...+0000"; toUTCString() ends with "GMT".
  return date.toUTCString().replace(/ GMT$/, ' +0000');
}

/** Did LG reject this because of the signed timestamp, not the credentials? */
function isClockSkewError(err) {
  return CLOCK_SKEW_RE.test(String((err && err.message) || err || ''));
}

function describeSkew(offsetMs) {
  const secs = Math.round(Math.abs(offsetMs) / 1000);
  const amount = secs >= 120 ? `${Math.round(secs / 60)} min` : `${secs}s`;
  return `${amount} ${offsetMs > 0 ? 'behind' : 'ahead of'}`;
}

// Monotonic milliseconds, for rate-limiting: the wall clock is precisely what
// cannot be trusted here (see the clock handling on the client).
function monoMs() {
  return Number(process.hrtime.bigint() / 1000000n);
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

/**
 * The token store holds an opaque string. Newer versions store a JSON payload
 * `{ refreshToken, lgeapiUrl }` so the OAuth backend that issued the token —
 * account-bound and only discoverable during a full login — survives restarts
 * (a refresh sent to the wrong regional backend fails with LG's "not exist
 * refresh token"). Older versions stored the bare refresh token; still accepted.
 */
function parseTokenPayload(text) {
  if (!text) {
    return null;
  }
  const s = String(text).trim();
  if (!s) {
    return null;
  }
  if (s[0] !== '{') {
    return { refreshToken: s, lgeapiUrl: null }; // legacy plain-token file
  }
  try {
    const parsed = JSON.parse(s);
    return {
      refreshToken: parsed.refreshToken || null,
      lgeapiUrl: decodeUrlMaybe(parsed.lgeapiUrl) || null,
    };
  } catch (e) {
    return null;
  }
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
    // True once lgeapiUrl came from LG itself (login response or token store)
    // rather than being guessed from the configured country.
    this._lgeapiAuthoritative = false;

    // Offset from this host's clock to LG's, learned from their responses.
    this._clockOffsetMs = 0;
    this._clockSkewWarned = false;
    this._lastFallbackLoginAt = -Infinity;

    this.http = axios.create({ timeout: 60000 });
    this._trackLgClock();
    this._readyPromise = null;
    this._deviceLocks = {}; // deviceId -> promise chain (per-device serialization)
  }

  /**
   * Learn LG's clock from the `Date` header of every LG response.
   *
   * Every OAuth request is signed together with an RFC-2822 timestamp that LG
   * validates against their own clock, rejecting anything more than a few
   * minutes out (see CLOCK_SKEW_RE). A host whose clock is wrong therefore
   * cannot authenticate at all — and that is the normal
   * state after a power or network outage: a Pi has no RTC, and NTP cannot
   * sync while the uplink is still down. Waiting for the host clock to be
   * fixed is what made an outage last minutes to hours.
   *
   * Both handlers learn, because the response that rejects us carries LG's
   * Date as well: a poll that starts with a stale offset (the gateway lookup
   * is cached, so it issues no request that could refresh it) is corrected by
   * its own failure and recovers on the retry in _doReady().
   */
  _trackLgClock() {
    const learn = (response) => {
      const date = response && response.headers && response.headers.date;
      if (date) {
        this._noteLgDate(date);
      }
    };
    this.http.interceptors.response.use(
      (res) => {
        learn(res);
        return res;
      },
      (err) => {
        learn(err && err.response);
        return Promise.reject(err);
      }
    );
  }

  _noteLgDate(dateHeader) {
    const serverMs = Date.parse(dateHeader);
    if (!Number.isFinite(serverMs)) {
      return;
    }
    // Includes ~half a round trip of latency, which is irrelevant against a
    // tolerance measured in minutes. Deliberately unclamped: a host that boots
    // without an RTC can be years out, and that is exactly the case to fix.
    this._clockOffsetMs = serverMs - Date.now();
    if (!this._clockSkewWarned && Math.abs(this._clockOffsetMs) > CLOCK_SKEW_WARN_MS) {
      this._clockSkewWarned = true;
      this.log.warn(
        `ThinQ: this host's clock is ${describeSkew(this._clockOffsetMs)} LG's - signing requests with ` +
          "LG's time instead (worth checking NTP; a skewed clock is what LG rejects with " +
          '"Time of request execution exceeded")'
      );
    }
  }

  /** Now, on LG's clock — the only clock their signature check accepts. */
  _now() {
    return new Date(Date.now() + this._clockOffsetMs);
  }

  _nowSeconds() {
    return Math.round(this._now().getTime() / 1000);
  }

  /**
   * A full login costs five requests against LG's rate-limited endpoints, so
   * only allow the refresh-failure fallback to use one occasionally. The cheap
   * refresh is still attempted on every poll in between.
   */
  _allowFallbackLogin() {
    if (monoMs() - this._lastFallbackLoginAt < FALLBACK_LOGIN_MIN_INTERVAL_MS) {
      return false;
    }
    this._lastFallbackLoginAt = monoMs();
    return true;
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
    const timestamp = rfc2822(this._now());
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
    if (token.oauth2_backend_url) {
      this.lgeapiUrl = decodeUrlMaybe(token.oauth2_backend_url);
      this._lgeapiAuthoritative = true;
    }
    this.accessToken = token.access_token;
    this.refreshToken = token.refresh_token;
    this.expiresAt = this._nowSeconds() + parseInt(token.expires_in, 10);

    await this._persistToken();
    this.log.info('ThinQ: logged in and obtained a refresh token');
    return this.refreshToken;
  }

  // -------- refresh access token from refresh token --------

  async refreshAccessToken() {
    if (!this.refreshToken) {
      throw new Error('ThinQ: no refresh token available');
    }

    // Try to resolve the regional oauth backend (best effort) — but never
    // override a URL LG itself gave us (login response or token store): the
    // issuing backend is authoritative, this legacy lookup is only a hint.
    if (!this._lgeapiAuthoritative) {
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
    }

    const data = { grant_type: 'refresh_token', refresh_token: this.refreshToken };
    const timestamp = rfc2822(this._now());
    const requestUrl = '/oauth/1.0/oauth2/token' + qs.stringify(data, { addQueryPrefix: true });
    const signature = this.signature(`${requestUrl}\n${timestamp}`, C.OAUTH_SECRET_KEY);

    let resp;
    try {
      resp = await this.http
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
        .then((r) => r.data);
    } catch (err) {
      const reason = pickErrorMessage(err, 'refresh token may be invalid');

      // A rejected *timestamp* says nothing about the token: our clock was
      // wrong, and a full login would fail at the very same signature check —
      // which is what turned a skewed clock into a five-request password login
      // on every single poll. The Date header on this very response has just
      // corrected our clock, so _doReady() only has to try again.
      if (isClockSkewError(reason)) {
        throw new Error('ThinQ token refresh failed: ' + reason);
      }

      // LG rejects a refresh token presented to the wrong regional OAuth
      // backend ("not exist refresh token"), and tokens can be revoked
      // server-side. Both are recoverable with a fresh username/password
      // login when the account credentials are available (GitHub issue #1).
      //
      // Only when LG actually answered, though: a bare network failure
      // (ENOTFOUND/ECONNREFUSED at boot, before the host's uplink is up) says
      // nothing about the token, and treating it as a bad one burns a
      // five-request login that cannot succeed either — slowing the failure
      // down and hammering LG's rate-limited login endpoints once per poll.
      if (!err || !err.response) {
        throw new Error('ThinQ token refresh failed: ' + reason);
      }
      if (this.username && this.password) {
        if (!this._allowFallbackLogin()) {
          throw new Error(
            `ThinQ token refresh failed: ${reason} (a full login was tried recently, not retrying yet)`
          );
        }
        this.log.warn(`ThinQ: token refresh failed (${reason}), retrying with a full login`);
        // The stored token is deliberately kept: if this login fails too, the
        // next poll can retry the cheap refresh instead of logging in again.
        await this.login();
        return this.accessToken;
      }
      throw new Error('ThinQ token refresh failed: ' + reason);
    }

    this.accessToken = resp.access_token;
    this.expiresAt = this._nowSeconds() + parseInt(resp.expires_in, 10);
    this.log.debug('ThinQ: access token refreshed');
    return this.accessToken;
  }

  async getUserNumber() {
    const profileUrl = this.lgeapiUrl + 'users/profile';
    const timestamp = rfc2822(this._now());
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

  /**
   * Authenticate, retrying once when LG rejected the timestamp we signed with.
   * By then the rejecting response has taught us LG's clock, so the retry
   * succeeds — instead of leaving every poll blind until the host clock
   * happens to get fixed, which after an outage can take hours.
   */
  async _doReady() {
    try {
      return await this._readySequence();
    } catch (err) {
      if (!isClockSkewError(err)) {
        throw err;
      }
      this.log.warn("ThinQ: LG rejected our request timestamp, retrying with LG's clock");
      return this._readySequence();
    }
  }

  async _readySequence() {
    await this.getGateway();

    // Load the persisted token payload. A refresh token supplied via the node
    // credentials takes precedence, but the stored OAuth backend URL is
    // adopted either way: it identifies the regional backend that issued the
    // account's tokens, which a cold start cannot otherwise know — guessing
    // it from the configured country can send the refresh to the wrong
    // backend, which LG rejects with "not exist refresh token" (issue #1).
    if (this.tokenStore && this.tokenStore.load) {
      const stored = parseTokenPayload(await this.tokenStore.load());
      if (stored) {
        if (!this.refreshToken && stored.refreshToken) {
          this.refreshToken = stored.refreshToken;
          this.log.debug('ThinQ: loaded refresh token from store');
        }
        if (stored.lgeapiUrl) {
          this.lgeapiUrl = stored.lgeapiUrl;
          this._lgeapiAuthoritative = true;
        }
      }
    }

    if (!this.refreshToken) {
      await this.login(); // sets access + refresh tokens
    }

    if (!this.accessToken || this._nowSeconds() >= this.expiresAt - 60) {
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

    // Cache the token payload even when the refresh token came from the node
    // credentials (login() is the only other writer, and it never runs in
    // that case) — this is what makes restarts and backend routing reliable.
    await this._persistToken();
  }

  async _persistToken() {
    if (this.tokenStore && this.tokenStore.save && this.refreshToken) {
      try {
        await this.tokenStore.save(
          JSON.stringify({ refreshToken: this.refreshToken, lgeapiUrl: this.lgeapiUrl })
        );
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

function randomString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < length; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

module.exports = { ThinQClient, rfc2822, parseTokenPayload };
