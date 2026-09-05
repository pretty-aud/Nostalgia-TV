import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The theme menu and the theme list must be the SAME list.
 *
 * They are two separate things that look like one: THEMES in
 * src/renderer/index.js is only consulted by resolveTheme to validate a saved
 * name, while the menu the viewer actually picks from is thirty-odd
 * hand-written <option> elements in index.html. Nothing connected them.
 *
 * That gap shipped a release. Five palettes were added to the stylesheet and
 * to THEMES, the CSS was verified by rendering the tokens directly, every test
 * passed — and not one of them was selectable, because nobody added the
 * options. The design-shot proved the paint and said nothing about the door.
 *
 * The same trap in the other direction is worse: an option whose value is not
 * in THEMES resolves to midnight, so picking it silently does nothing.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const js = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src', 'renderer', 'styles.css'), 'utf8');

/** THEMES, read out of the source text — it is not exported. */
function themesFromSource() {
  const start = js.indexOf('const THEMES = [');
  const end = js.indexOf('];', start);
  const body = js.slice(start, end);
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** The values of the <option>s inside #themeSelect, in markup order. */
function optionsFromMarkup() {
  const start = html.indexOf('<select class="select" id="themeSelect">');
  const end = html.indexOf('</select>', start);
  const body = html.slice(start, end);
  return [...body.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
}

const THEMES = themesFromSource();
const OPTIONS = optionsFromMarkup();
const LIGHT = (() => {
  const m = /const LIGHT_THEMES = \[([^\]]*)\]/.exec(js);
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
})();

describe('the theme list and the theme menu', () => {
  it('found both lists at all', () => {
    // The control: a regex that quietly matched nothing would make every
    // assertion below pass over an empty set.
    expect(THEMES.length).toBeGreaterThan(20);
    expect(OPTIONS.length).toBeGreaterThan(20);
  });

  it('offers EVERY theme in the menu', () => {
    const missing = THEMES.filter((t) => !OPTIONS.includes(t));
    expect(missing, `in THEMES but not selectable: ${missing.join(', ')}`).toEqual([]);
  });

  it('offers NOTHING the app cannot resolve', () => {
    // An option outside THEMES falls back to midnight, so picking it looks
    // like the setting silently failing to save.
    const orphans = OPTIONS.filter((o) => !THEMES.includes(o));
    expect(orphans, `selectable but unknown to the app: ${orphans.join(', ')}`).toEqual([]);
  });

  it('lists them in the SAME ORDER, because THEMES claims to be menu order', () => {
    expect(OPTIONS).toEqual(THEMES);
  });

  it('gives every theme a palette in the stylesheet', () => {
    // midnight is the :root default and has no data-theme block of its own.
    const unstyled = THEMES.filter((t) => t !== 'midnight'
      && !css.includes(`:root[data-theme="${t}"]`));
    expect(unstyled, `no CSS block: ${unstyled.join(', ')}`).toEqual([]);
  });

  it('gives every light theme its own shadow and rim tokens', () => {
    /**
     * The dark defaults are invisible on a pale ground, so a light theme that
     * forgets these renders with no depth anywhere.
     *
     * marigold and kawaii predate the convention and ship without them — seven
     * of the nine light themes follow it, these two do not. Exempted rather
     * than quietly dropping the check, and rather than changing how two
     * shipped themes look on the way past. Worth tidying one day; not worth
     * folding into an unrelated change.
     */
    const PREDATE = ['marigold', 'kawaii'];
    const thin = LIGHT.filter((t) => !PREDATE.includes(t)).filter((t) => {
      const start = css.indexOf(`:root[data-theme="${t}"] {`);
      if (start === -1) return true;
      const block = css.slice(start, css.indexOf('}', start));
      return !block.includes('--rim:') || !block.includes('--e-3:');
    });
    expect(thin, `light theme without its own elevation tokens: ${thin.join(', ')}`).toEqual([]);
  });

  it('keeps every light theme inside THEMES', () => {
    expect(LIGHT.filter((t) => !THEMES.includes(t))).toEqual([]);
  });

  it('has no duplicate entries in either list', () => {
    expect(new Set(THEMES).size).toBe(THEMES.length);
    expect(new Set(OPTIONS).size).toBe(OPTIONS.length);
  });

  it('resolves every retired alias to something that still exists', () => {
    const m = /const THEME_ALIASES = \{([^}]*)\}/.exec(js);
    const targets = m ? [...m[1].matchAll(/:\s*'([^']+)'/g)].map((x) => x[1]) : [];
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.filter((t) => !THEMES.includes(t))).toEqual([]);
  });
});
