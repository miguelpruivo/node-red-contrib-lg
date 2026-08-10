# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Dates are npm publish dates. Versions marked _(unreleased)_ exist in git but were never
published to npm; their changes reached users in the following release.

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
