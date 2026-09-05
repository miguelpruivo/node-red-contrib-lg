# CLAUDE.md — project context for agents

Context for anyone (human or AI agent) editing, fixing, or extending this project.
Read this first. Keep it up to date when you change behaviour or learn something non-obvious.

## What this is

`node-red-contrib-lg` — Node-RED nodes to **control and monitor LG ThinQ air
conditioners** and **LG webOS TVs**. Unofficial; not affiliated with LG.

Design priorities, in order: **reliability > simplicity > features**. The user
repeatedly asked to "keep it simple, don't overengineer". Prefer a small, robust
feature set over a large fragile one. All user-facing copy is in **English**.

## Node set (current)

Three node types — one config node and one node per device kind (each device node
has **one input and one output**: commands in, state out).

| Type | Kind | File | Role |
|------|------|------|------|
| `lg-account` | config | `nodes/lg-account.js` | ThinQ account: auth + shared device poller + MQTT push. Exposes admin HTTP endpoints used by the editor. |
| `lg-ac` | in + out | `nodes/lg-ac.js` | Control an AC and emit its state (after commands, on poll, and on real-time push). |
| `lg-tv` | in + out | `nodes/lg-tv.js` | Self-contained webOS TV node (holds its own connection). Control + on/off events. |

History: there used to be separate `lg-ac-status`, `lg-tv-control`, `lg-tv-status`
nodes and an `lg-tv` *config* node. They were **merged** into the three above
(breaking change). Do not reintroduce the split without a good reason.

`msg.event` tags every output message so consumers know the source:
- AC: `initial` | `change` | `periodic` (poll) · `command` (after a control) · `query` (after `"status"`) · `change` again for MQTT pushes.
- TV: `on` | `off` (status) · `command` (after a control).

## Repository layout

```
nodes/            Node-RED nodes (.js runtime + .html editor) — thin wrappers over lib/
lib/thinq/        ThinQ cloud client (auth, polling, control, MQTT)
  client.js       Auth (gateway/OAuth/refresh-token), device list, control commands
  ac.js           AC snapshot parsing + command building (pure, well unit-tested)
  mqtt.js         AWS IoT MQTT push (client cert flow + connection)
  constants.js    LG app keys, device types, opMode/windStrength maps, snapshot keys
lib/webos/        webOS TV
  tv.js           WebosTv: lgtv2 connection wrapper, power-state events, control
  wol.js          Native Wake-on-LAN (dgram, no dependency)
lib/red-helpers.js  storageDir(), makeLogger(), diffParsed() shared by nodes
examples/         Importable example flows (Node-RED auto-discovers this dir)
test/             node:test unit + node-load tests; env-gated live smoke scripts
```

Keep nodes thin: protocol/logic lives in `lib/`, so it stays unit-testable without
a running Node-RED. Nodes wire `lib/` into the Node-RED runtime.

## Conventions

- **CommonJS** everywhere (`require`/`module.exports`), Node `>=18`. Runs on Node 26.
- Dependencies are deliberately lean: `axios`, `qs`, `lgtv2`, `mqtt`, `node-forge`.
  Think hard before adding more. Wake-on-LAN is hand-rolled with `dgram` on purpose.
- Logging via `makeLogger(node)` → maps to `node.debug/log/warn/error`. Routine/expected
  failures (TV offline, MQTT retry) log at **debug**, not error.
- Editor `.html` for each node: defaults, an optional `oneditprepare`, and a help panel.
- Persistent state lives in `<userDir>/node-red-contrib-lg/`:
  `thinq-<id>.token` (refresh token cache), `thinq-mqtt-<id>.json` (MQTT key+CSR),
  `webos-<id>.key` (TV pairing key).

## How ThinQ works (and its gotchas)

Unofficial LG ThinQ v2 cloud API. Flow lives in `lib/thinq/client.js`, learned from
`homebridge-lg-thinq`.

1. **Gateway** lookup (`GATEWAY_URL`) with country/language headers → region endpoints.
2. **Login** (username/password) → SHA512 password hash → `preLogin` → account session →
   EMP OAuth `authorize` → token exchange → **access token + refresh token**.
3. **Refresh** the access token from the refresh token as needed.
4. **Poll** `service/homes` → device snapshots (`airState.*` keys).
5. **Control** = `POST service/devices/{id}/control-sync` with `{ ctrlKey:'basicCtrl',
   command:'Set', dataKey, dataValue }`.

Gotchas (do not regress these):
- The token response's `oauth2_backend_url` comes back **percent-encoded**
  (`https%3A%2F%2F...`). Must `decodeURIComponent` it, else `Invalid URL`. See
  `decodeUrlMaybe` in `client.js`. (The test account resolved to the **GB** region.)
- The OAuth signature timestamp must be **RFC 2822 with `+0000`**, not `GMT`. We build
  it from `Date.toUTCString().replace(' GMT', ' +0000')` (`rfc2822`).
- **Refresh tokens are bound to the regional OAuth backend that issued them** (the
  `oauth2_backend_url` learned during login). Refreshing against another backend fails with
  LG's "not exist refresh token" (GitHub issue #1: worked at "Extract refresh token", then
  every poll failed and the token file never appeared, because `_persistToken` only ran in
  `login()` and there was no fallback). So: the token store payload is JSON
  `{ refreshToken, lgeapiUrl }` (legacy bare-string files still parse — `parseTokenPayload`);
  a stored `lgeapiUrl` is authoritative (`_lgeapiAuthoritative`) and suppresses the flaky
  legacy `kic.lgthinq.com` region lookup; `_doReady` persists the payload even when the
  token came from node credentials; and a rejected refresh **falls back to a full
  username/password login** when credentials exist (self-heals wrong-backend and revoked
  tokens). Regression tests in `unit.test.js`.
- An AC **rejects mode/temperature/fan changes while it is off** (HTTP 400, resultCode
  `0001`). `lg-ac` therefore treats settings as **on-only**: a setting takes effect only when
  the unit *ends up on*. Decision in `flush()`: power-off → send `power=0` only (drop settings);
  explicit `power:true` → power-on (if needed) + settings; no power command & unit on → settings;
  no power command & unit **off → discard the settings** (do **not** auto-power-on). To turn on
  *with* settings, send them together with `power:true` (e.g. `{power:true, mode:'cool',
  temperature:22}`). **History:** an earlier version *power-gated* (sent power-on first for a bare
  setting while off). That was removed at the user's request because it let a setting arriving just
  after a power-off switch the unit back on — making "settings only apply while on" the invariant
  is what makes a power-off final regardless of message timing (so the short coalesce window below
  is a latency choice, not a safety one).
- **No-op skipping:** `flush()` drops any setting already at the device's current value (`isNoOp`
  vs the cached/`currentSnapshot` snapshot, `DEDUPE_KEYS` = mode/temp/fan/both vanes). Every
  `control-sync` makes the unit **beep**, so this cuts the beeping and the cloud calls down to
  genuine changes; a redundant `power:true`/`power:false` likewise becomes a no-op. Conservative:
  only modelled scalar keys, a missing snapshot key is always sent, `raw` is never deduped, and a
  cached "off" is re-confirmed with a fresh read before deciding. The shared cache is refreshed
  from the post-command read-back so a rapid follow-up burst dedupes against truth.
- **Fan forced to AUTO on power-on:** whenever a control op actually emits a power-on
  (`{power:true}` while off), `forceAutoFanOnPowerOn` drops any requested fan and appends
  `fan=AUTO` (windStrength 8) **after** the power-on. This is intentional product behaviour (the
  user wants every power-on to run the fan at AUTO) — an explicit `fan` in the same message is
  overridden, not honoured. A redundant `power:true` while already on is a no-op (no power-on, so
  no forced fan). Power-off never adds a fan command. Regression tests in `node-load.test.js`.
- **Per-device serialization + leading-edge coalescing:** `lg-ac` wraps each device operation in
  `client.withDeviceLock(deviceId, fn)`. Node-RED runs the node's async `input` handler
  concurrently, so without this, a rapid sequence (LOW→…→HIGH→AUTO) sends overlapping
  `control-sync` calls to the same AC — which the unit rejects (`0103`) or reacts to by powering
  off. The lock makes a sequence behave like the LG app (one change at a time).
  On top of the lock, control messages are coalesced **leading-edge** (`enqueue`/`flush`,
  `node._busy` gate): the first message of an idle device flushes on the **next tick** (`setTimeout
  0` — a lone command reacts in ~0 ms, no debounce wait), with messages that land in the **same
  tick** merged into it (`mergeRequest`, last value wins per field — so a `{power:false}` next to a
  setting still drops the setting). Anything that arrives while that flush is in flight, or within
  the **trailing** `node.coalesceMs` window after it (**default 150 ms**, `COALESCE_MS`), is merged
  and sent once more. So a lone command is immediate, a same-tick HomeKit burst is one sequence, and
  a spread-out burst is the first command + one coalesced follow-up. This is **not** the safety
  mechanism — power-off is final because of the "settings only apply while on" rule (a setting in a
  *separate, later* flush after a power-off is dropped because the unit is off), not because we wait
  to see the whole burst. `coalesceMs` is overridable via `config.coalesceMs` — tests set `0` (not
  surfaced in the editor HTML on purpose; keep it simple). History: this replaced a 600 ms
  *trailing* debounce (every command, even a lone one, waited the full window — the user reported
  the lag). The query/`"status"` path is not queued. Different devices run in parallel. Regression
  tests in `node-load.test.js` cover same-tick merge, leading-edge (gapped commands → separate
  sequences), power-off-then-setting drop, power-last, last-write-wins, the discard rule, and no-op
  skipping.
- **A failed poll retries with backoff, not a full interval later.** The account node already
  polls immediately on the first subscriber (`subscribe` → `startPolling` → `poll()` before the
  `setInterval`), so "no data after a restart" was never a missing initial poll — it was the
  *failure* path: right after a host reboot the network/DNS often isn't up, that first poll
  failed, and the next attempt was a whole `pollInterval` (60 s default) away, with `lg-ac` nodes
  sitting on a grey "waiting…" and the error status landing on the invisible config node. Poll
  failures now schedule a one-shot retry at 5 s → 10 s → 20 s → 40 s (capped at `pollInterval`),
  reset on the first success.
- **A refresh-token failure only falls back to a full login when LG actually answered.**
  `refreshAccessToken`'s catch used to treat *any* error as a possibly-bad token, so a bare
  `ENOTFOUND`/`ECONNREFUSED` at boot burned a five-request login that couldn't succeed either —
  slowing each failed poll down and hammering LG's rate-limited login endpoints once per
  interval. It now rethrows when `err.response` is absent; the issue-#1 self-heal still runs for
  a genuine LG rejection.
- **A wrong host clock breaks auth completely — so we sign with LG's clock, not the host's.**
  Every OAuth request is signed with an RFC-2822 timestamp LG validates against *their* clock.
  Measured live: **30 min behind is already rejected** by the authorize step and **1 h behind** by
  the token endpoint, with two different messages — `Time of request execution exceeded.` (clock
  behind) and `Can't handle requests from the future.` (clock ahead); `CLOCK_SKEW_RE` matches both,
  and matching only the first would leave an ahead-running host broken. This is the user-reported
  "after an outage the ACs take minutes or hours to come back": a host that reboots after a power
  or network cut has a wrong clock (a Pi has no RTC, and NTP can't sync while the uplink is down),
  so **every** poll failed until the clock happened to get fixed. `_trackLgClock` learns the offset
  from the `Date` header of every LG response — success *and* error, because the rejecting response
  carries it too — and `_now()`/`rfc2822(this._now())` sign with that. Deliberately **unclamped**
  (a host booting without an RTC can be years out, which is exactly the case to fix) and applied
  with no threshold; a skew > 60 s is warned about once. `expiresAt` uses `_nowSeconds()` so token
  expiry math rides the same clock. Verified live: 3 days behind, 3 days ahead and 1 year behind
  all authenticate and list devices. **Trap:** don't "simulate a wrong clock" in a test by patching
  `Date.now` and expecting the *old* code to fail — `new Date()` doesn't go through `Date.now`, so
  that patch is invisible to a bare `rfc2822()`. Patch `Date.prototype.toUTCString` to break the
  old path, `Date.now` to exercise the new one. Both nodes and the MQTT path get this for free
  (everything LG-facing goes through `client.http`; the Amazon CA fetch uses bare `axios`).
- **A clock rejection is NOT a bad refresh token.** Treating it as one is what turned a skewed
  clock into a storm: `refreshAccessToken` discarded the (good) token and burned a five-request
  password login every poll, all failing at the same signature check. It now rethrows clock errors
  (`isClockSkewError`), **keeps** the refresh token on a failed fallback login (so the next poll
  retries the cheap refresh), and throttles the fallback login to one attempt per 5 min
  (`FALLBACK_LOGIN_MIN_INTERVAL_MS`, timed on `monoMs()` — the wall clock is the very thing we
  can't trust here). `_doReady` wraps `_readySequence` and retries **once** on a clock error, since
  the rejecting response has just corrected the offset; recovery then lands in the same poll. The
  no-token-at-all path (`_readySequence` → `login()`) is deliberately *not* throttled — it's only
  reachable on first setup, where a login is the only option and speed matters.
- LG errors must be surfaced with their `resultCode` (`describeLgError`), not the bare
  axios "status code 400". `resultCode 0103` is **transient** ("device busy / can't apply now",
  common for fan speed after a power/mode change or in auto-managed modes) — `sendCommand` retries
  these (`TRANSIENT_RESULT_CODES`); `0001` is a hard "bad value/state" and is not retried.
- **Fan (windStrength) numeric values are model-specific.** The static map in `constants.js` is LG's
  standard RAC enum (LOW=2/MID=4/HIGH=6 reliable; SLOW=0, POWER=7) but some models differ —
  authoritative source is the model JSON `Value['airState.windStrength'].value_mapping`. **AUTO fan =
  windStrength 8** (the model JSON labels value 8 "NATURE", but it IS the app's auto fan, matching the
  reference's `FAN_SPEED_AUTO = 8`; verified against the live device). Don't be misled by the NATURE
  label. Same model-specificity applies to vanes. There IS a separate AC opMode AUTO (=6) — distinct
  from fan auto.
- AC reports current room temperature **even while off** — important: polling delivers
  temperature regardless of power state. Don't "optimize" that away.
- **Vane/louver control**: `airState.wDir.vStep` (vertical) and `airState.wDir.hStep`
  (horizontal); `0` = stop, `1..N` = fixed position, `100` = swing. `lg-ac` accepts
  `verticalVane` / `horizontalVane` / `swing` plus a `raw` escape hatch (`{ raw: { "airState.x": n } }`).
  Valid fixed positions are **model-specific** — the authoritative source is the device's
  `modelJsonUri` (`Value['airState.wDir.vStep'].value_mapping`), where `@`-prefixed entries are
  the user-facing values and bare numbers are internal bitmasks. `buildCommands` does not
  validate against the model (it trusts the value), so document the per-model range instead.
- **Panel display LED IS cloud-controllable — but only while the unit is on.** Key
  `airState.lightingState.displayControl` via the plain `basicCtrl`/`Set` `control-sync`, **inverted**:
  `0 = LED on`, `1 = LED off` (the `_W` values `11/12` are other models). `lg-ac` exposes it as
  `{ display: true|false }` (built in `buildCommands`, key in `constants.KEYS.DISPLAY`), gated by the
  same **on-only** rule as mode/temp/fan: a `display` sent while off is **discarded**; send it with
  `power:true` to apply on power-on. It's in `DEDUPE_KEYS` (no-op skipped) and reported in
  `parseSnapshot` as `display` (boolean, true = lit). Verified live on Suite (`RAC_056905_WW`,
  productCode `AI01`, `modelJsonVer 14.86`): the LG app's display toggle wrote `displayControl=1`,
  and our own `control-sync` then drove it `0`↔`1` with the panel following each time.
  **Gotcha that misled an earlier version:** `displayControl` is **NOT** in the model's
  `ControlDevice`/`ControlWifi` table, yet the firmware honours it anyway — so "no `ControlDevice`
  route" does **not** mean "not settable." The earlier "monitor-only / silently ignored" verdict was a
  **test artifact**: the command was sent while the unit was **off** (display, like every setting, only
  applies while on), so it looked ignored. Lesson: don't trust the `ControlDevice` enumeration alone —
  test live with the unit **on**.
- **Beep/buzzer (`airState.bellSound.control`/`.appControl`) — still UNCONFIRMED, not exposed.** An
  earlier live attempt (value `1`) didn't silence the command beep, but that test likely shared the
  off-state flaw above, and `bellSound` isn't reported in the snapshot either. Re-test with the unit
  **on** before asserting it's uncontrollable; if it turns out settable, expose it the same on-only way
  as `display`.

### Real-time push (MQTT)

`lib/thinq/mqtt.js` connects to LG's **AWS IoT** broker so external changes (the AC's
remote, the LG app) emit instantly instead of waiting for a poll.

- Cert flow: generate RSA key with **native `crypto`** (fast, async — do NOT use
  forge's blocking keygen on a Pi), build the CSR with **node-forge**, `POST
  service/users/client` then `.../client/certificate` → certificate + subscription topics,
  fetch Amazon root CA, connect `mqtts://host:8883` with mutual TLS.
- Message shape: `{ deviceId, data: { state: { reported: { <delta> } } } }`. The delta is
  merged into the cached snapshot, then emitted with `source: 'mqtt'` (always a `change`,
  never `periodic`).
- **Best-effort**: if MQTT setup fails it retries and polling keeps working. Never let MQTT
  failures break polling or crash the node.
- Toggle via the account's **Real-time** option (default on). Poll still runs in parallel.

## How webOS works (and its gotchas)

`lib/webos/tv.js` wraps the `lgtv2` library (local WebSocket) + native WoL.

- On = **Wake-on-LAN** magic packet (needs MAC + "Mobile TV On" enabled on the TV).
  Off = `ssap://system/turnOff`.
- Power state via `ssap://com.webos.service.tvpower/power/getPowerState` subscription, with
  the websocket connection state as a fallback. Off detection ≈ instant for a normal
  power-off (the subscription announces `Suspend` before the socket dies); on detection ≈
  within the `reconnect` interval (default 5 s) because we retry-connect while off.
- **A remote power-off is announced ~3.2 s before `state` catches up (gotcha).** Captured live
  from a real TV powered off with the remote:
  ```
  t+0.00  {state:'Active', processing:'Request Power Off',      onOff:'off', reason:'remoteKey'}
  t+0.04  {state:'Active', processing:'Request Power Off Logo', onOff:'off', reason:'remoteKey'}
  t+3.12  {state:'Active', processing:'Request Active Standby', onOff:'off', reason:'remoteKey'}
  t+3.18  {state:'Active', processing:'Prepare Active Standby', onOff:'off', reason:'remoteKey'}
  t+3.20  {state:'Active Standby'}
  ```
  `interpretPowerState` only matched `processing === 'Request Suspend'`, so all four announcement
  messages fell through to `'Unknown'` → **reported ON**, and off was only detected on the last
  line. That 3.2 s — *not* the off-grace timer — was the user-reported "power-off takes a few
  seconds". `isPoweringDown` now matches the phrase (`/power off|active standby|suspend/i`) plus a
  bare `onOff:'off'`, so off is reported on the **first** message, instantly. Deliberately does not
  match a bare `Request Active` (that is the TV *waking*). This is a positive announcement from the
  TV, not an inference from a dropped socket, so it cannot reintroduce the off/on flapping the
  off-grace timer exists to prevent. Regression tests use the captured payloads verbatim.
- **Screensaver is NOT off (gotcha).** `interpretPowerState` returns a descriptive *label*
  (Active→`On`, `Screen Saver`, `Screen Off`, `Screen On`, Suspend→`Off`, Active Standby→
  `Pixel Refresher`, …) but `isPoweredOn(label)` decides the boolean: only `Off` and
  `Pixel Refresher` count as off — **everything else (incl. `Screen Saver`/`Screen Off`) is
  reported as ON**. The screensaver and a blanked panel are panel states while the unit is
  still powered; mapping only `Active` to on (the old bug) flipped to `off` when the
  screensaver started and back to `on` on the next remote press. A genuine power-off is the
  `Off`/`Pixel Refresher` state; a dropped websocket also means off, but only after the
  off-grace below. There IS a regression test (`isPoweredOn …`).
- **A dropped websocket is NOT instantly off (off-grace, gotcha).** Transient drops happen
  while the TV is on — Wi-Fi hiccups, a busy TV missing a keepalive pong (the ws config
  drops the link when a ping isn't answered within 5 s), webOS-side resets — and `lgtv2`
  auto-reconnects a few seconds later. An earlier version reported off on every `close`,
  which flapped the state off→on a few seconds apart (sometimes repeatedly, until the TV —
  whose degraded network stack was causing the drops — was restarted). `_handleDisconnect`
  therefore starts a grace timer (`offGraceMs`, default `reconnect + 5 s`) only when the TV
  was believed ON; any power-state update cancels it (`_setPower` clears the timer) and off
  is reported only if still disconnected when it fires. A real power-off is unaffected
  (`Suspend` arrives via the subscription before the socket dies → still instant); only a
  hard cut (unplug/power failure) is detected ~`offGraceMs` later. `offGraceMs` is a
  constructor option (tests pass tiny values; not surfaced in the editor on purpose).
  Regression tests in `unit.test.js`.
- **A stuck connection attempt used to be permanent (watchdog, gotcha).** `lgtv2` only
  schedules a reconnect from its `connectFailed` and `close` handlers, and it arms a response
  timeout for `'request'` messages **only** — never for the pairing `'register'` message
  (`lgtv2/index.js`, `case 'register'` just stores the callback). So a TV that accepts the
  websocket but never answers `register` (webOS still booting, or a wedged ssap service) left
  the client **open, silent and unrecoverable**: no `connect`, no `close`, no reconnect, ever,
  until a redeploy. ws keepalive can't save it either — `handleSocketData` resets both the
  keepalive and grace timers on *any* inbound bytes, and the TV's framing layer keeps answering
  pings while its app layer is wedged. This is the "TV sometimes never reports on" report.
  `_startWatchdog`/`_checkStalled` fix it: a healthy *disconnected* client emits `'connecting'`
  (never deduped by lgtv2, unlike `'error'`) plus a close/error every `reconnect` ms, so silence
  past `watchdogMs` means stuck → `_restart()` builds a fresh client. Default `watchdogMs` =
  `max(30 s, reconnect × 6)`; the headroom matters because a **dark** TV legitimately cycles at
  ~12 s (measured: `ENETUNREACH` after ~7.1 s + 5 s reconnect) and must not be mistaken for a
  stall. Verified live against a server that accepts and never handshakes: one connection before,
  recycling every ~8 s after. `watchdogMs` is a constructor option (not surfaced in the editor).
- **A TV in standby also resets the ws upgrade (gotcha).** Measured on a real TV in standby:
  ports 3000 *and* 3001 stay open and answer in ~1 ms, `ws://:3000` returns **ECONNRESET** on the
  upgrade, and `wss://:3001` completes the upgrade then closes with **1008**. So the `ECONNRESET
  → this.secure = true` fallback fires on perfectly healthy hardware, and it used to be permanent
  for the node's lifetime — one stray reset could strand a TV that only serves 3000. `_restart()`
  Corollary: **a TCP port probe cannot tell on from off** on this hardware — the ports are open in
  standby. Don't build off-detection on one.
- **Transport is auto-detected; `secure` is only a starting point.** Old TVs serve only
  `ws://:3000`, newer ones can refuse it and require `wss://:3001`, and (per the probe result
  above) nothing but the handshake outcome distinguishes them. Two mechanisms: the **fast path**
  flips ws→wss on `ECONNRESET` (~10 ms, measured), and the **watchdog** alternates ws↔wss whenever
  the current transport has gone a full `watchdogMs` without ever completing a pairing handshake
  (`_transportSince`). The ECONNRESET path only fires while insecure, so the watchdog is what
  rescues a wrongly-ticked Secure box (wss→ws), which previously stranded the node forever.
  Whichever transport pairs sets `_provenSecure` and is **locked in for the node's lifetime** —
  alternation is a bootstrap mechanism, never a steady state. Verified live: 3 clean flips in 70 s
  against a dark TV, with no extra connection volume (it only changes which port the existing
  retry loop uses). `_transportSince` is seeded to `Date.now()` in the constructor — an unset
  clock reads as "expired" and would alternate on the first tick.
  **Trap (hit once, caught live):** the ws→wss fallback *applies* its flip by calling `_restart()`,
  so `_restart()` must never touch `secure` itself. An earlier version reverted an unproven
  transport there, which made the fallback undo its own flip and spin in a **tight CPU-pegging
  loop** (flip → restart → revert → ECONNRESET → flip …) against any TV that refuses plain ws —
  which is every TV tested. All unit tests passed; only real hardware caught it. Transport policy
  now lives in the `_setTransport` callers (the error handler and `_checkStalled`) and nowhere
  else. There is a regression test.
- **A TV in standby eventually drops its NIC entirely.** Measured on the same TV within one
  session: shortly after power-off both ports answered in ~1 ms; later every connect returned
  `ENETUNREACH`. So "reachable in standby" is not a stable property — don't assume a TV that
  answered a moment ago still will, and don't treat unreachability as a fault.
- **A dark TV publishes no state at all without help.** A TV whose NIC is off produces only
  connect failures — never a `close` — so `powerOn` stayed `null` forever and the node emitted
  nothing after a restart. `_checkStalled` now publishes an initial `off` once a full watchdog
  window of failed attempts has elapsed with no state yet.
- First connection needs a one-time **pairing prompt** accepted on the TV; the key is saved
  to `webos-<id>.key`.
- **Settings writes need the luna-over-alert route; plain SSAP is refused.** lgtv2's pairing
  payload already asks for `WRITE_SETTINGS` (and `WRITE_NOTIFICATION_ALERT`, `READ_SETTINGS`),
  and `ssap://settings/getSystemSettings` reads fine — but LG refuses
  `ssap://settings/setSystemSettings` from third-party clients ("no such service or method").
  Every project that does this (homebridge-webos-tv, bscpylgtv, the HA scripts) uses the same
  workaround, now in `WebosTv.lunaSend`: open a **system** alert
  (`ssap://system.notifications/createAlert`, **`isSysReq: true`** — without it nothing happens)
  whose button `onClick` *and* `onclose`/`onfail` carry the `luna://` URI + params, then
  `ssap://system.notifications/closeAlert` with the returned `alertId`. **Closing** the alert is
  what fires the call, which is why the action is repeated in `onclose` rather than only on the
  button. webOS < 4 doesn't run it from closeAlert (needs the alert opened twice plus an `ENTER`
  on the remote-input socket) — deliberately unsupported.
- **The alert IS visible, so it carries a real message — and its duration costs write latency.**
  `message: ' '` was a hide-it attempt that doesn't work on every model; the user reported a blank
  1–2 s toast on webOS 7.0 (that 1–2 s was never a configured duration — `closeAlert` was called as
  soon as `createAlert` returned, so what showed was just the TV's render-and-fade outliving it).
  `lunaSend(uri, params, { message, holdMs })` now takes both, defaulting to `' '`/`0` so the raw
  `{ luna: … }` escape hatch is unchanged. **Because closing fires the write, `holdMs` delays the
  write by exactly that long** — readability is bought with latency, which is why only the picture
  path opts in (`node.toastMs`, default **2000**, not surfaced in the editor like `offGraceMs`/
  `watchdogMs`; tests pass `0`). Labels live in `lib/webos/picture.js` (`describePictureWrite`,
  `pickLanguage`, `STRINGS`, and the `KEYS` moved out of `nodes/lg-tv.js` so both files share the
  key strings). Wording is **LG's own menu name, never our invention** — `eyeComfortMode` is
  "Reduce Blue Light"/"Reduzir a luz azul", *not* "night mode", so the viewer can find the same
  toggle in the TV's menus (the user rejected "Night mode" explicitly, and confirmed the sets are
  **OLED** — so `backlight` is "OLED Pixel Brightness"/"Brilho dos píxeis OLED"; on an LED set the
  menu name would be "Backlight" instead, one line per language). Settings in one message are
  **piped**, blue light first: `{reduceBlueLight:true, brightness:70}` → `Reduzir a luz azul ligado
  | Brilho dos píxeis OLED 70%`. (An earlier version showed only the most relevant one; the user
  asked for both.) Only the two sugar settings are named — a `pictureMode` or raw key would make
  the line unreadable, so a write with none of the named settings falls back to the generic line.
  Lines are capped at `MAX_LENGTH` 80 with an ellipsis, but that is **headroom, not a clipper**:
  the longest line any language can produce is 65 (French, both settings, 3-digit brightness), and
  the TV takes a long message happily. The cap only fires for the unvalidated raw `picture` hatch
  (it takes `backlight: Number.MAX_VALUE` to reach it). A test asserts every language's worst case
  stays under it, so adding longer copy fails loudly instead of silently truncating.
  Language comes from `uiLanguage()` → `getSystemSettings('option', ['localeInfo'])`
  → `locales.UI`, cached and cleared in `_handleDisconnect` so a language change self-heals on
  reconnect; **best-effort — null falls back to English**, because a locale read must never turn a
  working write into a failed one. 14 languages ship; anything else is English. **Not verified
  live yet:** whether `option`/`localeInfo` is readable by a paired client on webOS 7.0, whether a
  2 s hold renders as a steady toast or the TV fades it early anyway, and whether non-ASCII copy
  renders. Two concurrent picture messages still show two toasts — the user explicitly declined
  coalescing here (unlike `lg-ac`), so the documented shape is one message carrying both keys.
  OLED Pixel Brightness is the key **`backlight`** (0-100) in the `picture`
  category — the same category's `brightness` is **Black Level**, not the panel light, so
  `lg-ac`-style sugar `{ brightness: n }` maps to `backlight` (`PICTURE_KEY_BRIGHTNESS`).
  Values are per picture preset *and* per SDR/HDR, so pin `pictureMode` in the same call for
  determinism; Energy Saving can clamp them (`energySaving` reads `off` on the test set).
  **Verified live** on `HE_DTV_W22O_AFABATPU` / **webOS TV 7.0** (2022, firmware 33.31.68):
  backlight driven 20 → 90 → 20 with the panel following, and the read-back confirming each
  write. So LG's webOS 22+ notification-manager hardening did *not* close this route for the
  settings service. **`oledLight`, `oled_light` and `panelBrightness` do NOT exist** — the TV
  rejects the *whole* `getSystemSettings` request if any single key is unknown ("Some keys are
  not allowed for the request"), so probe candidate keys **one at a time**; `keys` is mandatory
  (a bare `category` is refused). Allowed picture keys found: `backlight`, `brightness`,
  `contrast`, `color`, `pictureMode`, `energySaving`, `peakBrightness`, `dynamicContrast`,
  `sharpness`, `eyeComfortMode`, `colorTemperature`.
- **A combined picture write is fine — and a settings write is read back now.** A report of
  `{reduceBlueLight, brightness}` in one message leaving `backlight` at 0 did **not** reproduce
  (verified live, webOS TV 7.0): `{backlight:30, eyeComfortMode:'on'}` and the `off`/`80` direction
  both read back exactly as sent, mode-then-value sequencing behaves identically, and three
  deliberately **overlapping** `setPictureSettings` calls all applied with last-write-wins and no
  garbling — so the alert route tolerates concurrency and needs no per-TV lock (unlike `lg-ac`'s
  `withDeviceLock`, which exists for a different reason: the AC *rejects* overlapping commands).
  The TV was already at `backlight: 0` when the investigation started, so the 0 came from outside
  this code path. Because a write leaves through an alert the TV closes itself, a clamped or
  misrouted value is indistinguishable from success — so `lg-tv` now calls
  `readBackPictureSettings` after every picture write and reports `msg.payload.actual`, warning
  when it differs from what was asked (`warnOnMismatch`). Read-back is best-effort: a raw `picture`
  key the TV refuses to read makes `getSystemSettings` reject the whole request, which must never
  turn a successful write into a failed message.
- **"Reduce Blue Light" is `eyeComfortMode`** (picture category, string `'on'`/`'off'`), exposed
  as `{ reduceBlueLight: true|false }`. Independent of `colorTemperature` — toggling it left
  `colorTemperature` at -50 untouched, so the warm shift it applies is layered on top rather
  than being a colour-temperature write. Verified live (on → off → on).
- **The test TV only serves `wss://:3001`.** Plain `ws://:3000` gets a socket hang-up on the
  upgrade — not the documented `ECONNRESET`, so the *fast* transport fallback does not fire and
  only the watchdog's ws↔wss alternation rescues it (~30 s). Tick **Secure** for this TV.
- **Reference point:** `hobbyquaker/node-red-contrib-lgtv` (by the lgtv2 author) reports off
  **immediately on socket `close`**, with no power-state subscription and no grace period. That
  is why it felt instant — and why it flaps on every Wi-Fi hiccup. Our grace timer is the
  deliberate trade; don't "fix" the latency by reverting to bare-close detection.

**Critical gotcha — never crash Node-RED:** an EventEmitter that emits `'error'` with no
listener throws an uncaught exception (fatal in Node-RED). An offline TV fails to connect
constantly. So:
- `WebosTv._emitError` only emits `'error'` when there is a listener (guarded).
- `_teardownClient` leaves a no-op `'error'` listener on the discarded `lgtv2` client so an
  in-flight connection failure (common on redeploy while the TV is off) can't throw.
- The `lg-tv` node attaches an `'error'` listener and logs at debug.
Keep all three. There is a regression test for the guard.

## Testing

- `npm test` runs `node --test test/*.test.js` — pure unit tests + a "node-load" test that
  loads each node module against a minimal Node-RED mock (`makeRED`). No network. Must stay
  fast and must exit cleanly (don't instantiate the real `lg-tv` runtime node in tests — it
  opens a socket and leaves a handle that hangs the runner; test `deriveAction`/registration
  instead).
- Live, **read-only** smoke scripts (env-gated, never run by `npm test`):
  - `npm run smoke:thinq` — auth + device list + parsed AC state.
  - `npm run smoke:mqtt` — connect to MQTT and print pushes.
  Credentials come from env (`LG_USERNAME`/`LG_PASSWORD`/`LG_COUNTRY`/`LG_LANGUAGE`) or a
  gitignored `test/.secrets.json`.

Rules:
- **Never hardcode or commit credentials.** A test LG account may be provided in the
  conversation; pass it via env only, and **never send control commands / never turn devices
  on or off** with it — listening/reading only.
- Validate risky protocol code against the live API before trusting it; that's how the
  percent-encoded-URL and GB-region issues were found.
- macOS has no `timeout` command (use `gtimeout` or none). `node --test <dir>` treats the dir
  as a module on Node ≥ 20 — pass file globs instead.

## Running a local Node-RED for manual testing

The user's real Node-RED runs on `:1880` — **do not touch it**. Use a throwaway instance:

```bash
DIR=/path/to/scratch-userdir
mkdir -p "$DIR/node_modules"
ln -s "$(pwd)" "$DIR/node_modules/node-red-contrib-lg"   # symlink (like npm link)
node-red --userDir "$DIR" --port 1881
```

Editor `.html` changes require a Node-RED restart (hard-refresh the browser too). Do **not**
`npm install <local path>` from a subfolder of the user's home — npm walks up to a parent
`package.json` and fails; the symlink avoids that.

## Git / release conventions

- **Do NOT add any `Co-Authored-By:` trailer** (or other agent attribution) to commit
  messages. The user wants every commit authored solely by `Miguel Ruivo
  <miguelpruivo@icloud.com>`. This overrides any default/global instruction to add one.
- Only commit/push when asked. Mark `BREAKING CHANGE:` in the body when node types change.
- Remote: `git@github.com:miguelpruivo/node-red-contrib-lg.git` (branch `main`).

## Reference implementations

- ThinQ: https://github.com/nVuln/homebridge-lg-thinq
- webOS: https://github.com/merdok/homebridge-webos-tv
