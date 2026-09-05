import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Structural checks on the two files nothing else can test.
 *
 * The stylesheet and the markup have no runtime that would complain: a broken
 * CSS rule is silently dropped by the browser and a lookup for an id that is
 * not there returns null, so both failures reach the screen looking like a
 * design decision rather than a fault. These have both happened here — twice a
 * selector was lost from a list, leaving a stray comma that invalidated the
 * whole rule, and it stayed that way for weeks because the page still rendered.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(root, 'src/renderer/styles.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'src/renderer/index.js'), 'utf8');

/**
 * Remove comments and string bodies in ONE left-to-right pass.
 *
 * Doing it as two regex passes gets this wrong: strip strings first and an
 * apostrophe inside a comment ("Fitts's Law") opens a string that swallows the
 * rest of the file. Only a single scan knows which context it is in.
 */
function stripNoise(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      out += ' ';
      continue;
    }
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += text[j] === '\\' ? 2 : 1;
      out += '""';
      i = j + 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Every rule prelude, including those nested one level inside an at-rule. */
function preludes(text) {
  const found = [];
  let current = '';
  let depth = 0;
  for (const ch of text) {
    if (ch === '{') {
      if (depth <= 1) found.push(current.trim());
      depth += 1;
      current = '';
    } else if (ch === '}') {
      depth = Math.max(0, depth - 1);
      current = '';
    } else if (depth <= 1) {
      current += ch;
    }
  }
  return found;
}

describe('the stylesheet parses as intended', () => {
  it('has no empty item in any selector list', () => {
    // `, .upnext { ... }` reads as a rule but is not one: an invalid item
    // invalidates the entire list, so the browser drops the block and the
    // element is left with no styling at all.
    const broken = preludes(stripNoise(css))
      .filter((prelude) => !prelude.startsWith('@'))
      .filter((prelude) => prelude === '' || prelude.split(',').some((part) => part.trim() === ''));

    expect(broken).toEqual([]);
  });

  it('balances its braces', () => {
    const bare = stripNoise(css);
    const opens = (bare.match(/\{/g) || []).length;
    const closes = (bare.match(/\}/g) || []).length;
    expect(opens).toBe(closes);
  });
});

describe('every element the renderer reaches for exists', () => {
  it('resolves every el(\'id\') to an id in the markup', () => {
    // getElementById returns null rather than throwing, so a renamed or
    // never-added element shows up as a control that quietly does nothing —
    // which is indistinguishable from a control that was never wired.
    const ids = new Set(
      [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]),
    );
    const looked = new Set(
      [...js.matchAll(/(?:^|[^\w$])el\('([\w-]+)'\)/g)].map((m) => m[1]),
    );

    // Sanity: the extraction itself must be finding something, or this test
    // passes by looking at nothing.
    expect(looked.size).toBeGreaterThan(40);
    expect([...looked].filter((id) => !ids.has(id))).toEqual([]);
  });
});

/**
 * The reverse direction: every id in the markup must be REACHED by something.
 *
 * The forward assertion above catches a renderer asking for an id that is not
 * there; this catches the opposite rot — nine orphan ids sat in the markup
 * referenced by nothing until an audit swept them. An id may be consumed by
 * el()/getElementById/querySelector in the renderer, by a #selector in the
 * stylesheet, or by an aria-labelledby/for attribute in the markup itself.
 */
describe('every markup id is referenced', () => {
  const html = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'src', 'renderer', 'styles.css'), 'utf8');

  const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);

  it('finds a sensible number of ids at all', () => {
    // The control: an extraction regex that quietly matches nothing would
    // make the assertion below pass over an unchecked page.
    expect(ids.length).toBeGreaterThan(100);
  });

  it('leaves no id unreachable', () => {
    const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const orphans = ids.filter((id) => {
      // Word-bounded on purpose: substring matching would let '#npShow'
      // excuse an orphaned 'np', or a '#fff' colour literal excuse an id
      // called 'fff' — the exact silent hole this assertion exists to close.
      const quoted = new RegExp('[\'"`]' + escapeRe(id) + '[\'"`]');
      const hashed = new RegExp('#' + escapeRe(id) + '(?![\\w-])');
      if (quoted.test(js) || hashed.test(js)) return false;
      if (hashed.test(css)) return false;
      if (html.includes(`aria-labelledby="${id}"`)
        || html.includes(`aria-describedby="${id}"`)
        || html.includes(`for="${id}"`)) return false;
      return true;
    });
    expect(orphans).toEqual([]);
  });
});
