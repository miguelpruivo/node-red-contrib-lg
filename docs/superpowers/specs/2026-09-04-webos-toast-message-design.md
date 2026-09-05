# webOS settings-write toast: give it a message, in the TV's language

Date: 2026-09-04
Status: implemented and shipped in 0.7.3/0.7.4. See the "Verified live
        afterwards" section — one assumption here turned out to be wrong.

## Problem

Every TV picture write (`brightness`, `reduceBlueLight`, `pictureMode`, raw `picture`)
flashes a blank notification on screen for ~1-2 s.

The toast is ours and it is unavoidable. LG refuses
`ssap://settings/setSystemSettings` from a paired third-party client ("no such
service or method"), so `WebosTv.lunaSend` writes settings by opening a
privileged system alert (`isSysReq: true`) whose `onclose` action carries the
`luna://` call and then closing it — **closing the alert is what executes the
write**. No alert, no write. We currently pass `message: ' '` (a single space),
an attempt to hide it that works on some models but not on the user's webOS 7.0
sets. The ~1-2 s is not a configured duration: `closeAlert` is called as soon as
`createAlert` returns, so what is visible is only the TV's render-and-fade
animation outliving our close.

## Decisions

1. **Put a real message in the alert.** Not having it is not on the menu.
2. **Describe what changed**, derived from the settings actually being written.
3. **One line, settings piped.** Every named setting in the message gets a
   part joined by ` | `, blue light first: `{reduceBlueLight:true,
   brightness:70}` reads "Reduzir a luz azul ligado | Brilho dos píxeis OLED
   70%". Only the two sugar settings are named -- listing a `pictureMode` or
   raw keys too would make the line unreadable.
4. **Hold the toast 2 s.** This delays the write by 2 s, because `closeAlert`
   fires it. Accepted deliberately.
5. **Translate into the TV's UI language**, curated table, English fallback.
6. **No coalescing.** Two concurrent messages still produce two alerts; the
   documented shape is to send both keys in one message.

## Design

### `lib/webos/picture.js` (new, no dependencies)

- `KEYS = { BRIGHTNESS: 'backlight', BLUE_LIGHT: 'eyeComfortMode' }` — moved out
  of `nodes/lg-tv.js`. These are protocol facts, and `lib/` is where protocol
  facts live; both the node and the label builder need them.
- `STRINGS` — 14 languages: en pt es fr de it nl pl sv da nb fi tr ru. Four
  fields each: `blueLight` (LG's menu name for `eyeComfortMode`), `on`, `off`,
  `brightness` (a bare noun), `picture`. The wording is LG's own, never ours:
  "Reduce Blue Light" / "Reduzir a luz azul", not "night mode", so the viewer
  can find the same toggle in the TV's menus.
- `pickLanguage(tag)` — takes `pt-PT`, returns `pt` if present in `STRINGS`,
  else `en`. Tolerates `null`/garbage.
- `describePictureWrite(settings, lang)` — pure. In order:
  | settings contain | message |
  |---|---|
  | `eyeComfortMode: 'on'` / `'off'` | `Reduce Blue Light on` / `Reduce Blue Light off` |
  | else finite numeric `backlight` | `OLED Pixel Brightness 30%` (`${brightness} ${n}%`) |
  | else | `Picture settings updated` |
  An unexpected `eyeComfortMode` value, or a non-numeric `backlight` (reachable
  only through the unvalidated raw `picture` path), falls to the generic label
  rather than emitting `Brightness undefined%`.

### `lib/webos/tv.js`

- `lunaSend(uri, params, { message, holdMs } = {})`. `message` defaults to `' '`
  and `holdMs` to `0`, so every existing caller — including the `{ luna: ... }`
  escape hatch — behaves exactly as today. When `holdMs > 0`, await a plain
  timer between `createAlert` and `closeAlert`.
- Threaded through `setSystemSettings(category, settings, options)` →
  `setPictureSettings(settings, options)`.
- `uiLanguage()` — lazily reads `getSystemSettings('option', ['localeInfo'])`,
  returns `settings.localeInfo.locales.UI` (e.g. `pt-PT`), caches it, clears the
  cache on disconnect so a language change self-heals on reconnect. A plain
  SSAP read; no alert. Returns `null` on any failure.

### `nodes/lg-tv.js`

- Imports `KEYS` and `describePictureWrite` from `lib/webos/picture.js`.
- `node.toastMs` from `config.toastMs`, **default 2000**. Not surfaced in the
  editor HTML — the same deliberate call as `offGraceMs`, `watchdogMs` and
  `coalesceMs`. Tests pass `0`.
- Call site: `setPictureSettings(command.settings, { message, holdMs })`.

## Error handling

The locale read is best-effort and must never turn a working write into a failed
message: any failure (rejected request, missing key, malformed payload) falls
back to English, logged at debug. Same rule the existing
`readBackPictureSettings` follows.

## Consequences, documented rather than fixed

- The picture command's output message (carrying the `actual` read-back) now
  lands ~2 s later. Downstream flow timing shifts by that much.
- The alert carries a focused `ok` button for those 2 s. Pressing OK on the
  remote inside the window fires `onClick` (the write) and closes the alert;
  our `closeAlert` then fires `onclose` — the same values are written twice.
  Idempotent and harmless; gets a code comment.
- Two concurrent picture messages hold two alerts side by side for 2 s each.

## Testing

- `describePictureWrite` table: all three rows in English, the same three in
  Portuguese, most-relevant-wins for `{eyeComfortMode, backlight}` together,
  raw `{picture:{eyeComfortMode:'on'}}` labelled correctly, non-numeric
  `backlight` falling through, unknown `eyeComfortMode` value falling through.
- `pickLanguage`: `pt-PT` → `pt`, `PT` → `pt`, `ja-JP` → `en`, `null` → `en`.
- `lunaSend`: message and hold threaded; default still `' '` with an immediate
  close; ordering `createAlert` → wait → `closeAlert` preserved; a locale-read
  failure still writes, in English.

## Verified live afterwards (webOS 7.0, HE_DTV_W22O_AFABATPU)

- **`localeInfo` is NOT readable — this design was wrong.** LG refuses it from a
  paired client (`Some keys are not allowed for the request. ( localeInfo )`)
  under categories `option`, `general`, `locale` and `localeInfo`, as it refuses
  every other language key, and `ssap://com.webos.settingsservice/getSystemSettings`
  answers `{}` to everything. The English fallback therefore fired on *every*
  write, which is exactly what the user reported. Shipped fix: read
  `option`/`country` (`"PRT"`, which *is* allowed) and map country -> language,
  with an explicit `language` setting on the node for when that guess is wrong.
- **`dimension` does not target a picture preset on reads.** `getSystemSettings`
  accepts `{pictureMode, hdrStatus}` without complaint but ignores it: every
  preset and every hdrStatus returned the *current* preset's values, and the
  response echoes only `category`. So there is no global panel brightness to
  set. Whether a *write* honours `dimension` is still untested.

## Still not verified

- Whether a 2 s hold renders as a steady toast or the TV fades it early anyway.
- Whether a longer label wraps or truncates, and whether non-ASCII
  (`ativado`, `Ночной режим включён`) renders correctly.
