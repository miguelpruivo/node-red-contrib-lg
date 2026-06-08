# node-red-contrib-lg

Node-RED nodes to **control and monitor LG ThinQ air conditioners** and **LG webOS TVs**.

- ❄️ **Air conditioners (LG ThinQ)** — turn on/off, set mode / temperature / fan, and read live state.
- 🌡️ **Periodic AC status** — temperature, power, mode, etc. are reported on a schedule, **even when the AC is off**.
- 🔔 **AC change events** — get notified the moment an AC is turned on/off or changes.
- 📺 **TVs (LG webOS)** — turn on (Wake-on-LAN) / off, and get notified when a TV turns on or off.
- 🔑 **Automatic auth** — log in once with your LG account; the refresh token is extracted and saved for reuse.

> Unofficial project. Not affiliated with or endorsed by LG. Use at your own risk.

---

## Installation

From your Node-RED user directory (usually `~/.node-red`):

```bash
npm install node-red-contrib-lg
```

Or use **Menu → Manage palette → Install** and search for `node-red-contrib-lg`.

Restart Node-RED. Six nodes appear under the **LG** category, plus two config nodes
(`LG ThinQ account` and `LG TV`).

Requires Node.js 18+ and Node-RED 3.0+.

---

## Nodes

| Node | Kind | Purpose |
|------|------|---------|
| `lg-account` | config | LG ThinQ account + shared device poller |
| `lg-ac` | control | Send commands to an AC and read its state back |
| `lg-ac-status` | listener | Emit AC state periodically and/or on change |
| `lg-tv` | config | A single webOS TV connection |
| `lg-tv-control` | control | Turn a TV on (Wake-on-LAN) / off / toggle |
| `lg-tv-status` | listener | Emit when a TV turns on/off |

There are ready-made example flows under **Menu → Import → Examples → node-red-contrib-lg**.

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

### 2. Control an AC — `lg-ac`

Pick the account and the AC from the dropdown. Send a message to control it:

| `msg.payload` | Effect |
|---------------|--------|
| `true` / `"on"` | Turn on |
| `false` / `"off"` | Turn off |
| `"status"` | Just read the current state |
| `22` (number) | Set target temperature to 22 °C |
| `"cool"` / `"heat"` / `"fan"` / `"dry"` / `"auto"` | Set mode |
| `{ "power": true, "mode": "COOL", "temperature": 22, "fan": "HIGH" }` | Set several at once |

The node always responds with the **current state** after the command:

```json
{
  "online": true,
  "power": true,
  "mode": "COOL",
  "currentTemperature": 23.5,
  "targetTemperature": 22,
  "fanSpeed": "HIGH",
  "humidity": null
}
```

`msg.raw` contains the raw `airState.*` snapshot. Set `msg.deviceId` to target a different AC at runtime.

### 3. Monitor an AC — `lg-ac-status`

This node uses the account's poller, so it works whether the AC is on or off:

- **Periodic** (default on) — emits on every poll cycle. Use this to log temperature
  continuously, even while the AC is idle.
- **On change** (default on) — emits the instant the AC turns on/off or any value changes.

Output `msg`:

```json
{
  "topic": "<deviceId>",
  "deviceId": "<deviceId>",
  "name": "Living room",
  "event": "change",          // "initial" | "change" | "periodic"
  "changed": ["power"],        // which fields changed
  "payload": { "power": true, "currentTemperature": 23.5, "...": "..." }
}
```

The **poll interval** is set on the account node (default 60 s, minimum 10 s) and is shared by
all `lg-ac-status` nodes.

---

## Quick start — TVs (webOS)

### 1. Configure the TV — `lg-tv`

- **IP address** — the TV's IP (give it a static lease on your router).
- **MAC** — the TV's MAC address. **Required to turn the TV on** via Wake-on-LAN.
- **Broadcast** — usually `255.255.255.255` (or your subnet broadcast, e.g. `192.168.1.255`).
- **Secure** — leave off to try `ws://…:3000` first; enable for TVs that require `wss://…:3001`.

On the TV, enable **Settings → General → Mobile TV On** (and keep **Quick Start+** on) so
Wake-on-LAN works while the TV is in standby.

**Pairing:** the first time Node-RED connects, the TV shows a pairing prompt — **accept it once**.
The pairing key is then stored at `<userDir>/node-red-contrib-lg/webos-<nodeId>.key`.

### 2. Control the TV — `lg-tv-control`

Set the **Action** to `From msg.payload` and send `"on"`, `"off"`, or `"toggle"` — or hard-wire
the action in the node. Output `msg.payload` is `{ power, state, connected }` once the action settles.

### 3. Monitor the TV — `lg-tv-status`

Emits whenever the TV turns on or off:

```json
{
  "topic": "Living room TV",
  "event": "on",
  "payload": { "power": true, "state": "On", "connected": true }
}
```

Detection uses the webOS power-state subscription when available, and falls back to the
websocket connection state on older TVs.

---

## How it works

- **ThinQ** uses the (unofficial) LG ThinQ v2 cloud API: a gateway lookup, an OAuth login that
  yields a **refresh token**, and periodic polling of `service/homes` for each device's snapshot.
  AC commands are `control-sync` `Set` calls (`airState.operation`, `airState.opMode`,
  `airState.tempState.target`, `airState.windStrength`).
- **webOS** uses the local WebSocket protocol (via [`lgtv2`](https://www.npmjs.com/package/lgtv2))
  for control and power-state subscription, and a built-in **Wake-on-LAN** magic packet to power on.

AC state changes are detected by polling (default every 60 s, configurable). This is simple and
reliable and reports temperature even when the unit is off. Real-time MQTT push is intentionally
left out to keep the plugin dependency-light; a shorter poll interval covers most automations.

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

# Optional read-only live check against a real LG account (never sends control commands):
LG_USERNAME=you@example.com LG_PASSWORD=secret LG_COUNTRY=PT LG_LANGUAGE=en-US npm run smoke:thinq
```

## Credits

Protocol details were learned from the excellent community projects
[homebridge-lg-thinq](https://github.com/nVuln/homebridge-lg-thinq) and
[homebridge-webos-tv](https://github.com/merdok/homebridge-webos-tv).

## License

MIT © Miguel Ruivo
