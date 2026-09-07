import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { markSvg, GEOMETRY, AMBER, DARK } from '../src/shared/nostalgiaMark.js';

/**
 * The vector mark and the raster icon must stay the same drawing.
 *
 * They are two files owning the same numbers, which is the shape that already
 * cost this repo a session — THEMES and a hand-written <option> list drifted
 * apart and five palettes shipped unselectable. Here the drift would be
 * quieter still: move a dial in the icon and the end card keeps drawing the
 * old set forever, on a screen nobody is diffing against the taskbar.
 *
 * So the constants are parsed back out of make-icon.js and compared.
 */
const ICON = readFileSync(new URL('../scripts/make-icon.js', import.meta.url), 'utf8');

/** Pull `const NAME = <literal>;` out of the icon script. */
function constant(name) {
  const match = new RegExp(`^const ${name} = ([^;]+);`, 'm').exec(ICON);
  if (!match) throw new Error(`make-icon.js has no constant named ${name}`);
  // Numbers and arrays of numbers — but the colours are written as hex byte
  // literals, [0xff, 0xc2, 0x47], which JSON will not take.
  const literal = match[1]
    .replace(/\s+/g, '')
    .replace(/0x[0-9a-f]+/gi, (hex) => String(parseInt(hex, 16)));
  return JSON.parse(literal);
}

describe('the vector mark matches the icon it was traced from', () => {
  it('finds the constants in make-icon.js at all', () => {
    // The control: a parser that matched nothing would make every comparison
    // below compare undefined with undefined and pass.
    expect(constant('EAR_WIDTH')).toBeTypeOf('number');
    expect(constant('BODY')).toHaveLength(4);
  });

  for (const name of [
    'EAR_BASE', 'EAR_LEFT', 'EAR_RIGHT', 'EAR_WIDTH', 'EAR_KNOB',
    'BODY', 'BODY_R', 'SCREEN', 'SCREEN_R',
    'DIALS', 'GRILLE', 'GRILLE_R', 'FEET', 'FOOT_R', 'KEYLINE',
  ]) {
    it(`has the same ${name}`, () => {
      expect(GEOMETRY[name]).toEqual(constant(name));
    });
  }

  it('uses the same two colours', () => {
    // Written as byte arrays in the icon, as hex here.
    const bytes = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    expect(constant('AMBER')).toEqual(bytes(AMBER));
    expect(constant('DARK')).toEqual(bytes(DARK));
  });
});

describe('the svg it produces', () => {
  const svg = markSvg({ size: 240 });

  it('is a square viewBox with the requested size', () => {
    expect(svg).toContain('viewBox="0 0 1000 1000"');
    expect(svg).toContain('width="240" height="240"');
  });

  it('draws every part of the set', () => {
    // Two ears with knobs, two feet, cabinet, screen, two dials, grille —
    // each in a dark keyline pass and an amber pass where it has one.
    expect((svg.match(/<line /g) || []).length).toBe(4);      // 2 ears x keyline+amber
    expect((svg.match(/<circle /g) || []).length).toBe(6);    // 2 knobs x2, 2 dials
    expect((svg.match(/<rect /g) || []).length).toBe(8);      // feet x2x2, body x2, screen, grille
  });

  it('puts the amber cabinet under the dark screen, not over it', () => {
    // Order IS the drawing here: the screen is cut back out of the cabinet by
    // being painted after it. Reversed, the mark is a featureless amber box.
    const body = svg.lastIndexOf(`rx="72" fill="${AMBER}"`);
    const screen = svg.indexOf(`fill="${DARK}"`, body);
    expect(body).toBeGreaterThan(-1);
    expect(screen).toBeGreaterThan(body);
  });

  it('can be drawn decoratively, without announcing itself twice', () => {
    expect(markSvg({ title: null })).toContain('aria-hidden="true"');
    expect(markSvg({ title: 'Nostalgia TV' })).toContain('aria-label="Nostalgia TV"');
  });

  it('clamps a grown corner radius to the shape, as the hit-test does', () => {
    // The feet are 0.058 tall and grow by 0.016 either side; an unclamped
    // radius of FOOT_R + KEYLINE would exceed half the height and SVG would
    // clamp it differently from make-icon, giving visibly different corners.
    const grownFootHeight = (0.938 - 0.880 + (2 * 0.016)) * 1000;
    const radii = [...svg.matchAll(/rx="([\d.]+)"/g)].map((m) => Number(m[1]));
    for (const r of radii) expect(r).toBeLessThanOrEqual(grownFootHeight);
  });
});
