# node-red-contrib-lg

Node-RED nodes to **control and monitor LG ThinQ air conditioners** and **LG webOS TVs**.

- ❄️ **Air conditioners (LG ThinQ)** — one `lg-ac` node: send commands in, get live state out
  (turn on/off, set mode / temperature / fan).
- 🌡️ **AC status** — temperature, power, mode, etc. are emitted on a schedule **even when the AC
  is off**, plus **real-time push** so changes made on the AC itself (its remote, the LG app) emit instantly.
- 📺 **TVs (LG webOS)** — one `lg-tv` node: turn on (Wake-on-LAN) / off / toggle in, on/off events out.
- 🔑 **Automatic auth** — log in once with your LG account; the refresh token is extracted and saved for reuse.

> Unofficial project. Not affiliated with or endorsed by LG. Use at your own risk.

---

## Installation

From your Node-RED user directory (usually `~/.node-red`):

```bash
npm install node-red-contrib-lg
```

Or use **Menu → Manage palette → Install** and search for `node-red-contrib-lg`.

Restart Node-RED. Two nodes (`LG AC`, `LG TV`) appear under the **LG** category, plus the
`LG ThinQ account` config node.

Requires Node.js 18+ and Node-RED 3.0+.

---

## Nodes

| Node | Kind | Purpose |
|------|------|---------|
| `lg-account` | config | LG ThinQ account + shared device poller |
| `lg-ac` | in + out | Control an AC **and** emit its state (after commands and on every poll) |
| `lg-tv` | in + out | Control a webOS TV (on/off/toggle) **and** emit on/off events |

Each device is a single node: wire your commands into its input, and wire its output to read
state. There are ready-made example flows under
**Menu → Import → Examples → node-red-contrib-lg**.

---

## Quick start — Air conditioners (ThinQ)

### 1. Configure your account

Add an **`lg-account`** config node (it appears when you drop an `lg-ac` node and open it):

- **Country** — the ISO code of the country your LG account is registered in (e.g. `US`, `GB`, `PT`).
- **Language** — e.g. `en-US`, `pt-PT`.
- **Username / Password** — your LG ThinQ account credentials.
- Click **Extract refresh token / Test**. This logs in, pulls a long-lived **refresh token**
  (filled into the field) and lists your devices. Click **Done** and **Deploy**.

How the token is handled:

- It is stored as an encrypted Node-RED credential when you use the button.
- At runtime it is **also cached to disk** at
  `<userDir>/node-red-contrib-lg/thinq-<nodeId>.token`, so restarts never need a fresh
  username/password login. If the refresh token ever becomes invalid, the node
  automatically logs in again using the stored username/password.

### 2. Add an AC — `lg-ac`

Pick the account and the AC from the dropdown. The single `lg-ac` node both **takes commands on
its input** and **emits the AC state on its output**.

**Input — commands** (`msg.payload`):

| `msg.payload` | Effect |
|---------------|--------|
| `true` / `"on"` | Turn on |
| `false` / `"off"` | Turn off |
| `"status"` | Just read the current state now |
| `22` (number) | Set target temperature to 22 °C |
| `"cool"` / `"heat"` / `"fan"` / `"dry"` / `"auto"` | Set mode |
| `{ "power": true, "mode": "COOL", "temperature": 22, "fan": "HIGH" }` | Set several at once |
| `{ "verticalVane": 1, "horizontalVane": 1 }` | Aim the louvers (1 = top / left … higher = down / right; `"swing"` = sweep; `"off"` = stop) |
| `{ "swing": "both" }` | Swing shorthand (`"vertical"` / `"horizontal"` / `"both"` / `"off"`) |
| `{ "raw": { "airState.xxx": n } }` | Escape hatch: send any LG `airState.*` key directly |

An LG AC rejects mode/temperature/fan changes while it is off, so the node **automatically turns
the AC on first** when you change one of those while it is off (power-on is sent before the other
settings, with a short gap so the unit is ready). Turning the AC **off** ignores any other settings
in the same message. This makes it safe to drive from HomeKit, where power, mode and temperature
arrive as separate messages. Set `msg.deviceId` to target a different AC at runtime.

**Output — state** is emitted after every command **and** on each poll cycle:

```json
{
  "topic": "<deviceId>",
  "deviceId": "<deviceId>",
  "name": "Living room",
  "event": "change",
  "changed": ["power"],
  "payload": {
    "online": true,
    "power": true,
    "mode": "COOL",
    "currentTemperature": 23.5,
    "targetTemperature": 22,
    "fanSpeed": "HIGH",
    "humidity": null,
    "verticalVane": 1,
    "horizontalVane": 1
  }
}
```

Vane positions are raw LG values: `0` = stop, `1..N` = fixed position, `100` = swing. The valid
fixed positions are model-dependent (e.g. vertical `1`–`6`, horizontal `1`–`5`).

`msg.event` tells you why it was emitted: `initial` / `change` / `periodic` (from polling),
`command` (after a control), or `query` (after a `"status"` request). Enable **Raw** to also get
the raw `airState.*` snapshot in `msg.raw`.

Two checkboxes control the output: **Periodic** (emit every poll cycle — reports temperature even
while off) and **On change** (emit the instant something changes). Disable both to only get
responses to commands you send. The **poll interval** lives on the account node (default 60 s,
minimum 10 s) and is shared by all `lg-ac` nodes.

**Real-time changes:** with **Real-time** enabled on the account (default on), changes made on the
AC itself — its remote, the LG ThinQ app, a wall controller — are pushed over MQTT and emitted
**immediately** (as `event: "change"`), instead of waiting for the next poll. Polling still runs in
parallel for periodic temperature updates.

---

## Quick start — TVs (webOS)

The `lg-tv` node is self-contained (no separate config node): it holds the connection, takes
control commands on its input, and emits on/off events on its output.

### 1. Configure the node — `lg-tv`

- **IP address** — the TV's IP (give it a static lease on your router).
- **MAC** — the TV's MAC address. **Required to turn the TV on** via Wake-on-LAN.
- **Broadcast** — usually `255.255.255.255` (or your subnet broadcast, e.g. `192.168.1.255`).
- **Reconnect** — retry interval (seconds, default 5) used while the TV is off. On/off detection is
  event-driven (an off is detected almost immediately); this interval is how quickly an
  **off → on** transition is noticed. Lower it for snappier detection.
- **Secure** — leave off to try `ws://…:3000` first; enable for TVs that require `wss://…:3001`.
- **Action** — `From msg.payload` (default), or hard-wire `on` / `off` / `toggle`.

On the TV, enable **Settings → General → Mobile TV On** (and keep **Quick Start+** on) so
Wake-on-LAN works while the TV is in standby.

**Pairing:** the first time Node-RED connects, the TV shows a pairing prompt — **accept it once**.
The pairing key is then stored at `<userDir>/node-red-contrib-lg/webos-<nodeId>.key`.

### 2. Use it

**Input — commands**: with Action set to `From msg.payload`, send `"on"`, `"off"`, or `"toggle"`.

**Output — state** is emitted whenever the TV turns on or off (and after a command):

```json
{
  "topic": "Living room TV",
  "event": "on",
  "payload": { "power": true, "state": "On", "connected": true }
}
```

`msg.event` is `on` / `off` for status changes, or `command` right after a control. Detection uses
the webOS power-state subscription when available, and falls back to the websocket connection state
on older TVs.

---

## Command reference

### Air conditioner — `lg-ac`

Send any of these as `msg.payload` on the input. Set `msg.deviceId` to target a different AC than
the one configured. Changing mode/temperature/fan/vane while the AC is off turns it on first;
sending an "off" ignores any other settings in the same message.

**Shortcut payloads**

| `msg.payload` | Effect |
|---|---|
| `true` / `"on"` | Power on |
| `false` / `"off"` | Power off |
| `"status"` (or `msg.topic` = `"status"`) | Read current state, change nothing |
| a number, e.g. `22` | Set target temperature (°C) |
| `"cool"` / `"heat"` / `"dry"` / `"fan"` / `"auto"` / `"air_clean"` | Set mode |

**Object payload** — combine any of these fields in one object:

| Field | Accepted values |
|---|---|
| `power` | `true` / `false` (also `"on"`, `"off"`, `"start"`, `"stop"`, `1`, `0`) |
| `mode` | `"COOL"`, `"DRY"`, `"FAN"`, `"HEAT"`, `"AIR_CLEAN"`, `"AUTO"` (case-insensitive) or the numeric value |
| `temperature` | number in °C (sent as-is; valid range is model-dependent, typically 16–30) |
| `fan` | `"SLOW"`, `"LOW"`, `"LOW_MID"`, `"MID"`, `"MID_HIGH"`, `"HIGH"`, `"POWER"`, `"AUTO"`, `"NATURE"` or the numeric value |
| `verticalVane` | `0` = stop, `1`–`6` = fixed position (1 = top), `100` = swing — or `"off"` / `"swing"` |
| `horizontalVane` | `0` = stop, `1`–`5` = fixed position (1 = left), `100` = swing — or `"off"` / `"swing"` |
| `swing` | `"vertical"`, `"horizontal"`, `"both"`, `"off"` (shorthand for setting both louvers to swing/stop) |
| `raw` | `{ "airState.<key>": value, … }` — sends those LG keys verbatim (escape hatch for anything not modelled) |

Example: `{ "power": true, "mode": "COOL", "temperature": 22, "fan": "HIGH", "verticalVane": 1, "horizontalVane": 1 }`

**Numeric value maps** (for `raw` or when sending numbers):

| Mode | # | | Fan | # |
|---|---|---|---|---|
| COOL | 0 | | SLOW | 1 |
| DRY | 1 | | LOW | 2 |
| FAN | 2 | | LOW_MID | 3 |
| HEAT | 4 | | MID | 4 |
| AIR_CLEAN | 5 | | MID_HIGH | 5 |
| AUTO | 6 | | HIGH | 6 |
| | | | POWER / AUTO | 8 |
| | | | NATURE | 16 |

> Which modes / fan speeds / vane positions a unit actually supports is model-dependent; an
> unsupported value returns an LG `resultCode` error. The authoritative list is the device's model
> JSON (`modelJsonUri`).

**Output `msg`** (emitted after a command and on every poll / real-time change):

| Field | Description |
|---|---|
| `payload` | `{ online, power, mode, modeValue, currentTemperature, targetTemperature, fanSpeed, fanSpeedValue, humidity, energyWatts, verticalVane, horizontalVane }` |
| `event` | `initial` / `change` / `periodic` (poll) · `command` (after a control) · `query` (after `"status"`) · `change` (real-time MQTT push) |
| `changed` | array of fields that changed (poll / push) |
| `deviceId`, `topic` | the AC device id |
| `raw` | the raw `airState.*` snapshot (only if **Raw** is enabled) |
| `commands` | labels of the commands that were sent (after a control) |

### TV — `lg-tv`

Set the node's **Action** to `From msg.payload` (default) and send a command, or hard-wire the
Action to `on` / `off` / `toggle` (then the payload is ignored).

**Input `msg.payload`**

| `msg.payload` | Effect |
|---|---|
| `true` / `"on"` / `1` | Turn on (Wake-on-LAN) |
| `false` / `"off"` / `0` | Turn off |
| `"toggle"` | Toggle on/off |
| `{ "power": true }` / `{ "power": false }` | On / off |

> The TV node currently controls **power only** (on / off / toggle). Volume, inputs and app launch
> are not exposed.

**Output `msg`** (emitted whenever the TV turns on/off and after a command):

| Field | Description |
|---|---|
| `payload` | `{ power: boolean, state: string, connected: boolean }` (`state` is the webOS label, e.g. `On`, `Off`) |
| `event` | `on` / `off` (status change) or `command` (after a control) |
| `topic` | the TV name |

---

## How it works

- **ThinQ** uses the (unofficial) LG ThinQ v2 cloud API: a gateway lookup, an OAuth login that
  yields a **refresh token**, and periodic polling of `service/homes` for each device's snapshot.
  AC commands are `control-sync` `Set` calls (`airState.operation`, `airState.opMode`,
  `airState.tempState.target`, `airState.windStrength`).
- **Real-time updates** use LG's AWS IoT MQTT broker: the plugin requests a client certificate
  (it generates an RSA key + CSR), connects over mutual-TLS MQTT and subscribes to the account's
  topics. LG pushes a delta (`{ deviceId, data: { state: { reported } } }`) whenever a device
  changes, which is merged into the cached snapshot and emitted instantly. The poll runs alongside
  it for periodic temperature and as a fallback if MQTT is unavailable.
- **webOS** uses the local WebSocket protocol (via [`lgtv2`](https://www.npmjs.com/package/lgtv2))
  for control and power-state subscription, and a built-in **Wake-on-LAN** magic packet to power on.

The poller and the MQTT connection are shared by all `lg-ac` nodes on the same account.

---

## Notes & limitations

- This relies on LG's cloud for ThinQ; if LG changes the API it may need updating.
- Supported AC fan-speed values and modes vary by model; you can always pass a raw numeric value.
- TV power-on requires Wake-on-LAN to be enabled on the TV and a reachable broadcast address.
- ThinQ "v1" (older) devices are not specifically handled; this targets ThinQ v2 ACs.

## Development

```bash
npm install
npm test                 # unit + node-load tests (no network)

# Optional read-only live checks against a real LG account (never send control commands):
LG_USERNAME=you@example.com LG_PASSWORD=secret LG_COUNTRY=PT LG_LANGUAGE=en-US npm run smoke:thinq
LG_USERNAME=you@example.com LG_PASSWORD=secret LG_COUNTRY=PT LG_LANGUAGE=en-US npm run smoke:mqtt
```

## Credits

Protocol details were learned from the excellent community projects
[homebridge-lg-thinq](https://github.com/nVuln/homebridge-lg-thinq) and
[homebridge-webos-tv](https://github.com/merdok/homebridge-webos-tv).

## License

MIT © Miguel Ruivo
