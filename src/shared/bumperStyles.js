'use strict';

/**
 * THE UP-NEXT STYLES — one entry per way the continuity card can look.
 *
 * The word is STYLE, not theme. "Theme" already means one of the 35 colour
 * schemes (THEMES in the renderer, [data-theme] on <html>), and two different
 * things sharing a name in settings is how somebody ends up changing the wrong
 * one. The user-facing label is "Style" for the same reason.
 *
 * ── Why a registry at all ────────────────────────────────────────────────
 *
 * Because the alternative has already gone wrong here once. The theme menu is
 * 35 hand-written <option>s in index.html and a separate THEMES array in
 * index.js, and five palettes shipped that nobody could select — past a green
 * suite, because nothing checked that the two lists agreed. The only thing
 * holding them together now is a test that scrapes the source text.
 *
 * So the list of styles lives HERE, once, and the <select> is built from it.
 * Adding a style is an entry in this file plus a draw function in the
 * renderer. There is no second list to keep in step.
 *
 * ── Why `fields` ─────────────────────────────────────────────────────────
 *
 * Styles do not want the same settings. A still card needs to be told how long
 * to stay up; a video card has a fixed running time and that control would be
 * a lie. So each style declares which controls it wants, and the settings
 * panel shows exactly those.
 *
 * They are FIELDS inside one permanent "Up next" group, never a group that
 * appears and disappears: renderSettingsNav builds the left rail from the
 * group headings, so a group that came and went would make the settings
 * navigation resize as you changed style. Same reason the VHS controls are
 * three fields inside Interface rather than a group of their own.
 *
 * ── Shaped for styles that are not written yet ────────────────────────────
 *
 * `resolveStyle` and `fieldsFor` both take the style list as an argument
 * rather than closing over the built-in one. That is what will let an imported
 * template be appended to the list at runtime without any of this changing —
 * and it is what lets the tests drive these with a fake list instead of
 * asserting against whatever happens to ship.
 */

/**
 * Every settings control a style may ask for, and the element that draws it.
 *
 * A style naming a field that is not in here is a typo that would otherwise
 * fail silently as "that control just never appears", so assertFieldsExist
 * turns it into a test failure instead.
 *
 * Only what is BUILT belongs here. An entry for a control with no markup would
 * fail test/markup.test.js, which requires every id in index.html to be
 * reachable and every el('id') to exist — in both directions.
 */
const FIELD_ELEMENTS = {
  /** How long a still card holds. Meaningless for anything with a run time. */
  duration: 'bumperField',
  /** Where a music-backed style deals its track from. */
  musicDir: 'bumperMusicField',
};

/**
 * The styles that ship.
 *
 * Deliberately only the ones that actually PLAY. A picker that lists something
 * unfinished is a setting the viewer can choose and then watch do nothing, and
 * this app has shipped that exact shape before — a menu offering choices the
 * code could not honour.
 */
const BUILTIN_STYLES = [
  {
    id: 'still',
    label: 'Default still menu',
    /**
     * 'still' holds a frame for a configurable time; 'video' runs for a fixed
     * length with its own sound. The kind is what decides whether a duration
     * control makes sense, so it is stated rather than inferred from `fields`.
     */
    kind: 'still',
    fields: ['duration'],
    note: 'The card this channel has always used — artwork, the episode, and what follows it.',
  },
  {
    id: 'cewr',
    label: 'Child exclusive water recreation',
    kind: 'video',
    fields: ['musicDir'],
    note: 'A schedule card on black, under a different piece of music every time. '
      + 'Fifteen seconds, cut from wherever in the track sounds best.',
  },
];

/** The fixed running time every video style is cut to, in seconds. */
const VIDEO_SECONDS = 15;

/** The style anything falling back to defaults lands on. */
const DEFAULT_STYLE_ID = 'still';

/**
 * The saved id, or the default when it names nothing.
 *
 * A settings file written by a later build — or by a template that has since
 * been removed — must not leave the channel with no card at all, so an
 * unknown id resolves rather than throwing. Same contract as resolveTheme.
 */
function resolveStyle(id, styles = BUILTIN_STYLES) {
  const found = styles.find((style) => style.id === id);
  return found || styles.find((style) => style.id === DEFAULT_STYLE_ID) || styles[0] || null;
}

/**
 * Which settings controls this style wants, as element ids.
 *
 * Returns element ids rather than field keys because the caller's job is to
 * hide everything else, and it can only do that by comparing like with like.
 */
function fieldsFor(id, styles = BUILTIN_STYLES) {
  const style = resolveStyle(id, styles);
  if (!style) return [];
  return (style.fields || [])
    .map((field) => FIELD_ELEMENTS[field])
    .filter(Boolean);
}

/** Every element id any style could ask for — the set to hide before showing. */
function allFieldElements() {
  return Object.values(FIELD_ELEMENTS);
}

/** Does this style run for a fixed time of its own? */
function isFixedLength(id, styles = BUILTIN_STYLES) {
  const style = resolveStyle(id, styles);
  return Boolean(style && style.kind === 'video');
}

/**
 * Every field name used by every style must exist in FIELD_ELEMENTS.
 *
 * Exported so a test can assert it against the shipping list. A style that
 * asks for a control nobody drew does not throw and does not warn — the
 * control simply never appears, which reads as a settings bug months later.
 */
function unknownFields(styles = BUILTIN_STYLES) {
  const missing = [];
  for (const style of styles) {
    for (const field of style.fields || []) {
      if (!FIELD_ELEMENTS[field]) missing.push(`${style.id}: ${field}`);
    }
  }
  return missing;
}

module.exports = {
  BUILTIN_STYLES,
  FIELD_ELEMENTS,
  VIDEO_SECONDS,
  DEFAULT_STYLE_ID,
  resolveStyle,
  fieldsFor,
  allFieldElements,
  isFixedLength,
  unknownFields,
};
