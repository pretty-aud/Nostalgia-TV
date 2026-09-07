import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GROUNDS, INK_NAMES, INKS, DEFAULT_GROUND, DEFAULT_INK, LIGHT_GROUNDS,
  groundOf, inkOf, pairFor, allPairs, inkOptionsFor, groundOptions,
} from '../src/shared/vhsPalette.js';

/**
 * Sixteen combinations, none of them unreadable.
 *
 * Four inks by four grounds includes white on white, blue on blue and green
 * on green — 1:1 contrast if the two axes are independent. The pair table
 * exists so they are not, and this is what keeps that true: every pair is
 * measured, and a shade edited to look nicer cannot quietly drop below
 * legible.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const toRgb = (hex) => {
  const s = hex.trim().replace('#', '');
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
};
const luminance = (hex) => {
  const c = toRgb(hex).map((v) => {
    const n = v / 255;
    return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe('the contrast maths', () => {
  it('is right about the extremes', () => {
    // Failing control. A ratio function that always returned a big number
    // would make every assertion below pass over any palette at all.
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 0);
    expect(contrast('#ffffff', '#ffffff')).toBeCloseTo(1, 2);
    expect(contrast('#0b0bb4', '#0b0bb4')).toBeCloseTo(1, 2);
  });
});

describe('every VHS pair is legible', () => {
  /**
   * THE GRID IS COMPLETE, whatever size it is.
   *
   * This asserted sixteen, four and four, which is three numbers that have to
   * be re-typed every time a colour is added and say nothing about what
   * actually matters — that every ground crosses every ink with no gaps. It is
   * the product now, so adding red took the count from 16 to 25 without
   * anybody editing a literal, and a MISSING pair still fails.
   */
  it('is every ground crossed with every ink, with no gaps', () => {
    const grounds = Object.keys(GROUNDS);
    const inks = Object.keys(INK_NAMES);
    expect(allPairs()).toHaveLength(grounds.length * inks.length);

    const missing = [];
    for (const g of grounds) {
      for (const i of inks) if (!INKS[g] || !INKS[g][i]) missing.push(`${i} on ${g}`);
    }
    expect(missing, 'pairs the table does not resolve').toEqual([]);
  });

  it('clears WCAG AA for body text, all sixteen', () => {
    const weak = allPairs()
      .map((p) => ({ ...p, ratio: contrast(p.colour, p.paper) }))
      .filter((p) => p.ratio < 4.5);
    expect(
      weak.map((p) => `${p.ink} on ${p.ground} = ${p.ratio.toFixed(2)}:1`),
      'pairs below 4.5:1',
    ).toEqual([]);
  });

  it('clears AAA (7:1) for the three same-name pairs, which are the risky ones', () => {
    // white/white, blue/blue and green/green are where an independent-axes
    // design would have produced 1:1. They get the strictest check.
    for (const name of ['white', 'blue', 'green']) {
      const p = pairFor(name, name);
      expect(contrast(p.colour, p.paper), `${name} on ${name}`).toBeGreaterThan(7);
    }
  });

  it('keeps the inks on a ground distinguishable from each other', () => {
    // Options that resolve to near-identical colours would make the control
    // pointless even though every pair passed on its own.
    const wanted = Object.keys(INK_NAMES).length;
    for (const ground of Object.keys(GROUNDS)) {
      const inks = Object.keys(INK_NAMES).map((i) => INKS[ground][i]);
      expect(new Set(inks).size, `${ground} has duplicate inks`).toBe(wanted);
    }
  });

  it('inverts on the white ground, and only there', () => {
    // The one deliberate dishonesty: on white, "WHITE" is near-black. Pinned
    // so it cannot be "fixed" back into an invisible pair.
    expect(luminance(pairFor('white', 'white').colour)).toBeLessThan(0.2);
    for (const g of ['blue', 'black', 'green']) {
      expect(luminance(pairFor(g, 'white').colour), `${g} should stay bright`).toBeGreaterThan(0.7);
    }
  });
});

describe('the lookups refuse to yield undefined', () => {
  it('falls back for a name that does not exist', () => {
    expect(groundOf('mauve')).toBe(DEFAULT_GROUND);
    expect(inkOf('mauve')).toBe(DEFAULT_INK);
    expect(groundOf(undefined)).toBe(DEFAULT_GROUND);
    expect(inkOf(null)).toBe(DEFAULT_INK);
    // A saved setting written before a name changed must not reach the
    // stylesheet as the string "undefined".
    expect(pairFor('nope', 'nope').paper).toBe(GROUNDS[DEFAULT_GROUND].paper);
  });

  it('defaults to white on blue, as asked', () => {
    expect(DEFAULT_GROUND).toBe('blue');
    expect(DEFAULT_INK).toBe('white');
    expect(pairFor(DEFAULT_GROUND, DEFAULT_INK).colour).toBe('#ffffff');
  });
});

describe('what the rails draw', () => {
  it('swatches the ink options in their RESOLVED colour, not their name', () => {
    // On white, the "WHITE" chip must be the dark shade it will actually
    // produce — a literal white chip would promise something else.
    expect(inkOptionsFor('white').white.swatch).toBe(INKS.white.white);
    expect(inkOptionsFor('blue').white.swatch).toBe(INKS.blue.white);
    expect(inkOptionsFor('white').white.swatch).not.toBe(inkOptionsFor('blue').white.swatch);
  });

  it('offers every ink and every ground, labelled', () => {
    expect(Object.keys(inkOptionsFor('blue'))).toEqual(Object.keys(INK_NAMES));
    expect(Object.keys(groundOptions())).toEqual(Object.keys(GROUNDS));
    expect(groundOptions().black.label).toBe('BLACK');
    expect(groundOptions().red.label).toBe('RED');
  });
});

describe('the stylesheet agrees with the module', () => {
  const css = fs.readFileSync(path.join(root, 'src', 'renderer', 'styles.css'), 'utf8');

  it('declares a block for every ground', () => {
    const missing = Object.keys(GROUNDS)
      .filter((g) => !css.includes(`[data-osd-ground="${g}"]`));
    expect(missing, 'grounds with no CSS').toEqual([]);
  });

  it('declares the resolved ink for every one of the sixteen pairs', () => {
    // The one that catches a pair added to the module and forgotten in the
    // sheet, which would silently inherit the previous ground's ink.
    const missing = allPairs()
      .filter((p) => !css.includes(`[data-osd-ground="${p.ground}"][data-osd-ink="${p.ink}"]`))
      .map((p) => `${p.ink} on ${p.ground}`);
    expect(missing, 'pairs with no CSS').toEqual([]);
  });

  it('marks the white ground as light', () => {
    expect(LIGHT_GROUNDS).toEqual(['white']);
  });
});
