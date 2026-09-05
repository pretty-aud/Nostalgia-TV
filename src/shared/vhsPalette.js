'use strict';

/**
 * The VHS skin's colours: four inks, four grounds, sixteen pairs.
 *
 * THE PAIR IS THE UNIT, not the two axes. Treating them independently means
 * white-on-white, blue-on-blue and green-on-green are the same colour on
 * itself — 1:1 contrast, three of the sixteen combinations invisible — and
 * the usual answers to that are all worse than the problem. Disabling cells
 * greys out a quarter of the grid and makes the second control's meaning
 * depend on the first, which reads as broken software. Auto-shifting the
 * other axis means her ink changes when she touches the ground, which is
 * indistinguishable from a bug. And letting her pick it is not a cosmetic
 * flaw but a trapdoor: white on white makes the settings sheet itself
 * unreadable, removing the way back out.
 *
 * So the ink NAME selects a hue family and the pair decides its shade. Green
 * on green is bright phosphor on deep bottle green — which is exactly what a
 * monochrome monitor looked like, not a collision.
 *
 * ON A WHITE GROUND THE OSD INVERTS. Bright phosphor type on white paper is
 * a physical contradiction and no shade of it works, so on white the inks
 * resolve dark — "white" becomes near-black, exactly the way a VCR's
 * highlight bar inverts a row. The rail shows the resolved swatch, so the
 * dark chip is visible before it is chosen.
 *
 * Every pair is measured by test/vhsPalette.test.js against WCAG AA.
 */

/** The four grounds, in menu order. */
const GROUNDS = {
  blue:  { label: 'BLUE',  paper: '#0b0bb4' },
  black: { label: 'BLACK', paper: '#050505' },
  green: { label: 'GREEN', paper: '#063a0c' },
  white: { label: 'WHITE', paper: '#f4f4f4' },
};

/** The four inks, in menu order. */
const INK_NAMES = {
  white:  'WHITE',
  blue:   'BLUE',
  green:  'GREEN',
  orange: 'ORANGE',
};

/**
 * The resolved ink for every pair.
 *
 * Read as: on THIS ground, the ink called X is this colour. The three dark
 * grounds carry bright phosphor shades; the white ground carries dark ones.
 */
const INKS = {
  blue: {
    white:  '#ffffff',
    // Lightened from #9dc2ff, which measured 6.74:1 — legible, but under the
    // stricter bar the same-name pairs are held to, and blue-on-blue is the
    // one a careless edit would take back below usable.
    blue:   '#b3d2ff',
    green:  '#66f066',
    orange: '#ffb454',
  },
  black: {
    white:  '#f4f1ea',
    blue:   '#7fb2ff',
    green:  '#5be85b',
    orange: '#ffa733',
  },
  green: {
    white:  '#f4f1ea',
    blue:   '#8fc0ff',
    green:  '#a8f5a8',
    orange: '#ffb454',
  },
  white: {
    white:  '#141414',
    blue:   '#0a1f8c',
    green:  '#0a5c12',
    orange: '#7a3b00',
  },
};

const DEFAULT_GROUND = 'blue';
const DEFAULT_INK = 'white';

/** Grounds whose panels are LIGHT — the app's existing data-light machinery. */
const LIGHT_GROUNDS = ['white'];

/** A ground name that exists, falling back rather than yielding undefined. */
function groundOf(name) {
  return GROUNDS[String(name)] ? String(name) : DEFAULT_GROUND;
}

/** An ink name that exists. */
function inkOf(name) {
  return INK_NAMES[String(name)] ? String(name) : DEFAULT_INK;
}

/** The two hex values a pair resolves to. */
function pairFor(ground, ink) {
  const g = groundOf(ground);
  const i = inkOf(ink);
  return { ground: g, ink: i, paper: GROUNDS[g].paper, colour: INKS[g][i] };
}

/** Every pair, for the contrast test and for generating the stylesheet. */
function allPairs() {
  const out = [];
  for (const g of Object.keys(GROUNDS)) {
    for (const i of Object.keys(INK_NAMES)) out.push(pairFor(g, i));
  }
  return out;
}

/**
 * What the rail draws in each cell: the option's own name, and the colour it
 * would actually resolve to under the ground currently in force. A swatch
 * showing the literal named colour would promise something the pair table
 * does not deliver — on a white ground, "WHITE" is a dark chip.
 */
function inkOptionsFor(ground) {
  const g = groundOf(ground);
  const out = {};
  for (const [key, label] of Object.entries(INK_NAMES)) {
    out[key] = { label, swatch: INKS[g][key] };
  }
  return out;
}

/** The ground options, each swatched in its own paper. */
function groundOptions() {
  const out = {};
  for (const [key, def] of Object.entries(GROUNDS)) {
    out[key] = { label: def.label, swatch: def.paper };
  }
  return out;
}

module.exports = {
  GROUNDS,
  INK_NAMES,
  INKS,
  DEFAULT_GROUND,
  DEFAULT_INK,
  LIGHT_GROUNDS,
  groundOf,
  inkOf,
  pairFor,
  allPairs,
  inkOptionsFor,
  groundOptions,
};
