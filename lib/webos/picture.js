'use strict';

/**
 * Picture-setting keys, and the label that goes on screen when we write one.
 *
 * A settings write can only leave through a system alert that the TV puts up
 * (see `WebosTv.lunaSend`) -- closing that alert is what executes the write, so
 * something is going to flash on screen whether we want it or not. Rather than
 * fight it with a blank message, we fill it in: LG's own menu wording for the
 * setting being changed, in the TV's own UI language, so what appears reads
 * like the TV talking instead of like a debug line.
 *
 * The wording is deliberately LG's, not ours: the on-screen name for
 * `eyeComfortMode` is "Reduce Blue Light", never "night mode", because that is
 * what the viewer will find if they go looking for the same toggle in the TV's
 * own menus.
 */

// `backlight` is the panel light -- "OLED Pixel Brightness" in the menus of an
// OLED set. The picture category's own `brightness` key is Black Level, NOT
// the panel light, which is why the sugar maps to this key instead.
const KEYS = {
  BRIGHTNESS: 'backlight',
  BLUE_LIGHT: 'eyeComfortMode',
};

/**
 * LG's menu names, per language. `on`/`off` are the words the TV uses for a
 * toggle state, appended to the setting name the way the menus read them out.
 * Anything not listed falls back to `en` -- see `pickLanguage`.
 */
const STRINGS = {
  en: { blueLight: 'Reduce Blue Light', on: 'on', off: 'off', brightness: 'OLED Pixel Brightness', picture: 'Picture settings updated' },
  pt: { blueLight: 'Reduzir a luz azul', on: 'ligado', off: 'desligado', brightness: 'Brilho dos píxeis OLED', picture: 'Definições de imagem atualizadas' },
  es: { blueLight: 'Reducir luz azul', on: 'activado', off: 'desactivado', brightness: 'Brillo de píxeles OLED', picture: 'Ajustes de imagen actualizados' },
  fr: { blueLight: 'Réduire la lumière bleue', on: 'activé', off: 'désactivé', brightness: 'Luminosité des pixels OLED', picture: "Paramètres d'image mis à jour" },
  de: { blueLight: 'Blaulicht reduzieren', on: 'ein', off: 'aus', brightness: 'OLED-Pixelhelligkeit', picture: 'Bildeinstellungen aktualisiert' },
  it: { blueLight: 'Riduci luce blu', on: 'attivo', off: 'disattivo', brightness: 'Luminosità pixel OLED', picture: 'Impostazioni immagine aggiornate' },
  nl: { blueLight: 'Blauw licht verminderen', on: 'aan', off: 'uit', brightness: 'OLED-pixelhelderheid', picture: 'Beeldinstellingen bijgewerkt' },
  pl: { blueLight: 'Redukcja niebieskiego światła', on: 'wł.', off: 'wył.', brightness: 'Jasność pikseli OLED', picture: 'Zaktualizowano ustawienia obrazu' },
  sv: { blueLight: 'Minska blått ljus', on: 'på', off: 'av', brightness: 'OLED-pixelljusstyrka', picture: 'Bildinställningar uppdaterade' },
  da: { blueLight: 'Reducer blåt lys', on: 'til', off: 'fra', brightness: 'OLED-pixellysstyrke', picture: 'Billedindstillinger opdateret' },
  nb: { blueLight: 'Reduser blått lys', on: 'på', off: 'av', brightness: 'OLED-piksellysstyrke', picture: 'Bildeinnstillinger oppdatert' },
  fi: { blueLight: 'Vähennä sinistä valoa', on: 'päällä', off: 'pois', brightness: 'OLED-pikselien kirkkaus', picture: 'Kuva-asetukset päivitetty' },
  tr: { blueLight: 'Mavi Işığı Azalt', on: 'açık', off: 'kapalı', brightness: 'OLED Piksel Parlaklığı', picture: 'Görüntü ayarları güncellendi' },
  ru: { blueLight: 'Уменьшение синего света', on: 'вкл.', off: 'выкл.', brightness: 'Яркость пикселей OLED', picture: 'Настройки изображения обновлены' },
};

/**
 * Reduce a locale tag from the TV (`pt-PT`, `en_US`) to a language we have copy
 * for. Anything unknown, missing or malformed becomes English -- the locale
 * read is best-effort and must never be able to break a write.
 */
function pickLanguage(tag) {
  if (typeof tag !== 'string') {
    return 'en';
  }
  const lang = tag.trim().toLowerCase().split(/[-_]/)[0];
  return Object.prototype.hasOwnProperty.call(STRINGS, lang) ? lang : 'en';
}

// Between the named settings when one message changes several of them.
const SEPARATOR = ' | ';

/**
 * Length cap, with enough headroom that it never fires for our own copy: the
 * longest line the table can produce is 65 characters (French, both settings,
 * three-digit brightness), and the TV takes a long message happily.
 *
 * It exists for the raw `picture` escape hatch, which is not validated -- a
 * `{ picture: { backlight: 999999999 } }` should not put a wall of text on
 * screen. There is a test asserting no language's worst case reaches this, so
 * the cap stays headroom rather than quietly clipping real labels.
 */
const MAX_LENGTH = 80;

function truncate(line) {
  return line.length > MAX_LENGTH ? `${line.slice(0, MAX_LENGTH - 1)}…` : line;
}

/**
 * One short line describing a picture write, for the alert the TV shows.
 *
 * Every named setting in the message gets a part, joined by `SEPARATOR`, so a
 * combined write says both halves of what it did ("Reduce Blue Light on | OLED
 * Pixel Brightness 70%") instead of hiding one behind the other. Blue light
 * leads because it is the one a viewer notices.
 *
 * Only the two sugar settings are named. Anything else in the message (a
 * `pictureMode`, a raw key) is not spelled out -- writing every key on screen
 * would make the line unreadable, which defeats the point of labelling it. So a
 * write with nothing named in it falls back to the generic line, as does an
 * unexpected `eyeComfortMode` value or a `backlight` that is not a number (both
 * only reachable through the unvalidated raw `picture` payload) -- rather than
 * putting `undefined` on the screen.
 */
function describePictureWrite(settings, tag) {
  const s = STRINGS[pickLanguage(tag)];
  const parts = [];

  const blueLight = settings ? settings[KEYS.BLUE_LIGHT] : undefined;
  if (blueLight === 'on' || blueLight === 'off') {
    parts.push(`${s.blueLight} ${blueLight === 'on' ? s.on : s.off}`);
  }
  const level = settings ? settings[KEYS.BRIGHTNESS] : undefined;
  if (Number.isFinite(level)) {
    parts.push(`${s.brightness} ${level}%`);
  }

  return truncate(parts.length ? parts.join(SEPARATOR) : s.picture);
}

module.exports = { KEYS, STRINGS, MAX_LENGTH, pickLanguage, describePictureWrite };
