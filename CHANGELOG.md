# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Dates are npm publish dates. Versions marked _(unreleased)_ exist in git but were never
published to npm; their changes reached users in the following release.

## [0.7.3] — 2026-09-05

### Changed

- **The notification a TV picture write puts on screen now says what it is doing, in the TV's own
  menu language, and stays up for about 2 seconds.** It used to be blank: a settings write can only
  leave as a system notification whose action carries the `luna://` call, so one always appeared,
  carrying `message: ' '` in the hope of being invisible — which it is not on every model. It now
  reads `Reduce Blue Light on`, `Reduzir a luz azul ligado`, `OLED Pixel Brightness 30%` and so on,
  using LG's own menu wording so the viewer can find the same toggle on the TV. Settings changed
  in the same message are piped into one line — `Reduzir a luz azul ligado | Brilho dos píxeis
  OLED 70%`.
- The language is **guessed from the TV's country**, because LG does not let a third-party client
  read the menu language — `localeInfo` is refused outright on webOS 7.0, under every category, as
  is every other language key. The country (`PRT`) is readable and is what gets mapped. Copy ships
  for en, pt, es, fr, de, it, nl, pl, sv, da, nb, fi, tr and ru; any other country falls back to
  English. Since it is a guess, the node gained a **Language** setting to pin one explicitly —
  useful when a TV's menus are in a different language than its country's.
- Documented that **OLED Pixel Brightness cannot be set globally**: it is stored per picture preset
  and per SDR/HDR, and the TV changes preset by itself for HDR content, so a value set in one
  preset stops applying. The README now covers the three mitigations (pin `pictureMode` in the
  message, re-apply on a schedule, or set the presets by hand and drive `reduceBlueLight` — which
  *is* global — from the flow).
- **A picture setting now takes effect ~2 s after the message**, because closing the notification is
  what executes the write, so holding it on screen holds the write. The output message follows it.
  Sending two settings as two simultaneous messages produces two writes and two notifications; put
  them in a single message instead.

## [0.7.2] — 2026-08-26

### Added

- **A picture-settings write is now read straight back**, and `msg.payload.actual` reports what
  the TV actually holds (`null` if the read-back failed) instead of only echoing the request.
  A difference between the two is logged as a warning. A settings write leaves through an alert
  the TV closes by itself, so until now a clamped or misrouted value was indistinguishable from
  a successful one — Energy Saving can clamp the panel light, and values are stored per picture
  preset and separately for SDR/HDR, so a write can land in a slot other than the one being
  watched.

### Notes

- Investigated a report of `{ reduceBlueLight, brightness }` in one message leaving OLED Pixel
  Brightness at 0. **Not reproducible**: verified live on `HE_DTV_W22O_AFABATPU` / webOS TV 7.0
  that the combined write applies exactly as sent in both directions, that sequencing the mode
  before the value behaves identically, and that even three deliberately overlapping writes
  apply cleanly (last one wins) with nothing garbled. The TV was found already at `backlight: 0`
  before any test ran, so the 0 came from outside this code path — hence the read-back above,
  which makes the next occurrence attributable.

## [0.7.1] — 2026-08-25 _(unreleased)_

### Documentation

- The README still described the TV node as power-only ("Volume, inputs and app launch are
  not exposed") — 0.7.0 documented the new picture-settings commands only in the editor help
  panel. The command reference now covers `brightness` / `reduceBlueLight` / `pictureMode` /
  `picture`, the `request` and `luna` escape hatches, the per-preset and SDR/HDR caveats, and
  the output shapes each command returns.
- The webOS example flow gained scheduled day/night picture-settings injects and a read-back
  inject using the raw `ssap://` route.

## [0.7.0] — 2026-08-24

### Added

- **The TV node can now change picture settings**, so OLED Pixel Brightness and the
  "Reduce Blue Light" toggle can be driven from a flow (day/night automations, for
  example). With Action set to "From msg.payload":
  `{ "brightness": 40 }` (0–100), `{ "reduceBlueLight": true }`,
  `{ "pictureMode": "cinema" }`, or `{ "picture": { … } }` for any setting verbatim.
  Several in one message are applied as a single write.
- **Raw escape hatches** for anything not modelled: `{ "request": "ssap://…", "params": … }`
  runs any SSAP call and returns its response as `msg.payload` (useful for reading settings
  back), and `{ "luna": "luna://…", "params": … }` runs any luna service call.

  LG refuses `ssap://settings/setSystemSettings` from third-party clients, so writes go the
  way every other project does it: through a privileged system alert that carries the luna
  call, which is then closed to fire it. Verified live on a 2022 set running webOS TV 7.0 —
  LG's webOS 22+ permission hardening did not close this route. Requires webOS 4 or newer,
  and the TV must be on. A brief alert may flash on screen.

## [0.6.6] — 2026-08-10

### Fixed

- **ACs now recover on their own after an outage instead of staying dead for minutes or
  hours.** LG signs every OAuth request with a timestamp that it validates against *its*
  clock, and the window is tight — measured live, 30 minutes behind is already rejected by
  the authorize step and 1 hour by the token endpoint (`Time of request execution
  exceeded.` when the clock is behind, `Can't handle requests from the future.` when it is
  ahead). A host that reboots after a power or network cut has a wrong clock — a Pi has no
  RTC, and NTP cannot sync while the uplink is still down — so every poll failed until the
  host clock happened to be fixed. The client now learns LG's clock from the `Date` header
  of their responses and signs with that, so a skewed host clock no longer blocks
  authentication at all. A large skew is reported once as a warning, since it is worth
  fixing on the host too.
- A rejected timestamp is no longer mistaken for a bad refresh token. It used to throw the
  (perfectly good) token away and burn a five-request username/password login on **every
  poll**, all of which failed at the very same signature check, against LG's rate-limited
  login endpoints. The refresh token is now kept, and the recovery login is throttled to at
  most one attempt every 5 minutes so it can never storm.
- Authentication retries once immediately when LG rejects a timestamp, because the
  rejecting response is itself what teaches the client LG's clock — so recovery happens
  within the same poll rather than on some later one.

## [0.6.5] — 2026-08-07

### Changed

- The TV **Secure** option is now only a *starting point*, not a setting you have to get
  right. The transport is auto-detected: the watchdog alternates `ws://…:3000` and
  `wss://…:3001` whenever the current one has gone a full watchdog window without
  completing a pairing handshake, and whichever transport pairs is locked in for the
  node's lifetime. Previously a wrongly-ticked Secure box stranded the node forever,
  because the existing `ECONNRESET` fast path only flips ws → wss and never back.

### Fixed

- A tight reconnect loop against any TV that refuses plain `ws`. The ws → wss fallback
  applies its flip by restarting the client, so reverting the transport inside that
  restart made the fallback undo itself and spin (flip → restart → revert → reset → …).
  Transport policy now lives in exactly one place.

## [0.6.4] — 2026-08-06

### Fixed

- **TV power-off is reported instantly** (~3.2 s faster). webOS announces a remote
  power-off immediately (`processing: "Request Power Off"`, `onOff: "off"`) but keeps
  reporting `state: "Active"` for another ~3.2 s. Only one transition name was
  recognised, so every announcement read as "Unknown" — treated as ON — and the
  power-off was only noticed on the final message.
- **A TV could stop reporting its state permanently.** `lgtv2` arms a response timeout
  for `request` messages only, never for the pairing `register` message, so a TV that
  accepted the websocket without answering (webOS still booting, or a wedged ssap
  service) left the client open, silent and unrecoverable until a redeploy. Websocket
  keepalive could not break it either, because the TV's framing layer keeps answering
  pings while its app layer is wedged. A connection watchdog now rebuilds the client
  when it stops making progress.
- A TV that was never reachable (NIC powered down) produced only connect failures and
  never a `close`, so the node published no state at all after a restart. It now reports
  `off` once a full watchdog window of failed attempts has elapsed.
- **AC data after a Node-RED restart.** The first poll already ran immediately, but if it
  failed — common right after a host reboot, before DNS and the network are up — the next
  attempt was a whole poll interval (60 s by default) away. Failed polls now retry at
  5 s → 10 s → 20 s → 40 s, capped at the poll interval and reset on success.
- A failed token refresh only falls back to a full username/password login when LG
  actually answered. A bare network error at boot previously triggered a five-request
  login that could not succeed either, slowing every failed poll and hammering LG's
  rate-limited login endpoints once per interval.

## [0.6.3] — 2026-07-19

### Fixed

- Refresh tokens are bound to the regional OAuth backend that issued them, so the issuing
  backend is now persisted alongside the token and a rejected refresh falls back to a full
  login. Previously the token file was only written during a full login, so a token
  supplied via node credentials was never cached and every poll failed with LG's "not
  exist refresh token".
  ([#1](https://github.com/miguelpruivo/node-red-contrib-lg/issues/1))

## [0.6.2] — 2026-07-18 _(unreleased)_

### Fixed

- Transient TV websocket drops (Wi-Fi hiccups, a missed keepalive pong, webOS-side resets)
  no longer flap the reported power off → on. A bare socket close now starts a short grace
  timer instead of reporting off immediately, and any power-state update cancels it. A
  genuine power-off is unaffected — it is announced on the subscription before the socket
  dies.

## [0.6.1] — 2026-07-08 _(unreleased)_

### Security

- Enforce TLS certificate verification for non-AWS MQTT brokers.
- Harden file permissions (0600) on the token and MQTT key stores when overwriting, not
  only on creation, so a file left world-readable by an older version is corrected.

## [0.6.0] — 2026-06-20

### Added

- AC panel display (LED) control via `{ display: true | false }`, reported back in the
  parsed snapshot. Like every other setting it only applies while the unit is on.

## [0.5.0] — 2026-06-14

### Changed

- AC control commands are coalesced **leading-edge**: a lone command is sent on the next
  tick (~0 ms) instead of waiting out a debounce window, with same-tick messages merged
  into it and a short trailing window catching stragglers. Replaces the previous 600 ms
  trailing debounce, which made every command — even a single one — feel laggy.
- Settings are **on-only**: a mode/temperature/fan change takes effect only if the unit
  ends up on, and is otherwise discarded rather than powering the unit on. This makes a
  power-off final regardless of message timing.

### Fixed

- Commands that would set a value the device already holds are skipped, cutting both the
  cloud calls and the confirmation beep down to genuine changes.

## [0.4.0] — 2026-06-13

### Changed

- Bursts of AC control messages are coalesced into one ordered sequence, sending the first
  command quickly and ordering power-off last.

## [0.3.0] — 2026-06-11

### Added

- The AC fan is forced to AUTO whenever a control sequence powers the unit on.

### Changed

- Queued control commands are debounced so a burst becomes a single sequence.

## [0.2.1] — 2026-06-11

### Fixed

- The TV is no longer reported off when the screensaver starts. The screensaver and a
  blanked panel are panel states while the unit is still powered; only Suspend and the
  Pixel Refresher count as off.

### Changed

- Added an npm files allowlist so local configuration can never ship in the package.

## [0.2.0] — 2026-06-10

First published release.

### Added

- `lg-account` config node: ThinQ authentication with a cached refresh token, a shared
  device poller, and real-time push via LG's AWS IoT MQTT broker.
- `lg-ac` node: control and monitoring for ThinQ air conditioners — power, mode, target
  temperature, fan speed and vane (louver) direction, plus a `raw` escape hatch.
- `lg-tv` node: webOS TV control and power-state monitoring, with Wake-on-LAN turn-on
  implemented natively over `dgram`.
- Importable example flows, and a full command reference in the node help panels.

### Changed

- Control and status were merged into a single node per device (one input, one output).
  Earlier development versions had separate `lg-ac-status`, `lg-tv-control` and
  `lg-tv-status` nodes plus an `lg-tv` config node.

### Fixed

- An offline TV can no longer crash Node-RED. An `EventEmitter` that emits `error` with no
  listener throws an uncaught exception, and a TV that is off fails to connect constantly.
- Transient LG `0103` control errors ("device busy") are retried; other result codes are
  surfaced with their meaning instead of a bare "status code 400".
- Control commands are serialized per device, so a rapid sequence no longer sends
  overlapping `control-sync` calls that the unit rejects or reacts to by powering off.
- Duplicate devices in the AC node's dropdown.
