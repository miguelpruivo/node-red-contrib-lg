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
- An AC **rejects mode/temperature/fan changes while it is off** (HTTP 400, resultCode
  `0001`). `lg-ac` therefore **power-gates**: changing a setting while off sends power-on
  first (with `COMMAND_DELAY_MS` spacing); turning off ignores other settings in the same
  message. This makes the HomeKit/NRCHKB bridge work, where power/mode/temp arrive as
  separate messages.
- LG errors must be surfaced with their `resultCode` (`describeLgError`), not the bare
  axios "status code 400". `resultCode 0103` is **transient** ("device busy / can't apply now",
  common for fan speed after a power/mode change or in auto-managed modes) — `sendCommand` retries
  these (`TRANSIENT_RESULT_CODES`); `0001` is a hard "bad value/state" and is not retried.
- **Fan (windStrength) numeric values are model-specific.** The static map in `constants.js` is LG's
  standard RAC enum (LOW=2/MID=4/HIGH=6 reliable; SLOW=0, POWER=7, NATURE=8) but some models differ
  — authoritative source is the model JSON `Value['airState.windStrength'].value_mapping`. There is
  no AUTO windStrength (AUTO is an opMode). Same model-specificity applies to vanes.
- AC reports current room temperature **even while off** — important: polling delivers
  temperature regardless of power state. Don't "optimize" that away.
- **Vane/louver control**: `airState.wDir.vStep` (vertical) and `airState.wDir.hStep`
  (horizontal); `0` = stop, `1..N` = fixed position, `100` = swing. `lg-ac` accepts
  `verticalVane` / `horizontalVane` / `swing` plus a `raw` escape hatch (`{ raw: { "airState.x": n } }`).
  Valid fixed positions are **model-specific** — the authoritative source is the device's
  `modelJsonUri` (`Value['airState.wDir.vStep'].value_mapping`), where `@`-prefixed entries are
  the user-facing values and bare numbers are internal bitmasks. `buildCommands` does not
  validate against the model (it trusts the value), so document the per-model range instead.

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
  the websocket connection state as a fallback. Off detection ≈ instant; on detection ≈
  within the `reconnect` interval (default 5 s) because we retry-connect while off.
- First connection needs a one-time **pairing prompt** accepted on the TV; the key is saved
  to `webos-<id>.key`.

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

- End commit messages with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Only commit/push when asked. Mark `BREAKING CHANGE:` in the body when node types change.
- Remote: `git@github.com:miguelpruivo/node-red-contrib-lg.git` (branch `main`).

## Reference implementations

- ThinQ: https://github.com/nVuln/homebridge-lg-thinq
- webOS: https://github.com/merdok/homebridge-webos-tv
