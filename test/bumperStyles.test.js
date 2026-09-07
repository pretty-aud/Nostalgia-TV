import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  BUILTIN_STYLES,
  FIELD_ELEMENTS,
  DEFAULT_STYLE_ID,
  resolveStyle,
  fieldsFor,
  allFieldElements,
  isFixedLength,
  unknownFields,
} from '../src/shared/bumperStyles.js';

/**
 * The up-next style registry.
 *
 * This file exists because of the theme menu. THEMES is an array in index.js
 * and the <option>s are 35 hand-written lines in index.html, and five palettes
 * shipped that no one could select — past 670 green tests, because nothing
 * checked the two lists agreed. The registry is the fix; these are the tests
 * that keep it one list.
 */

const HTML = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
const JS = readFileSync(new URL('../src/renderer/index.js', import.meta.url), 'utf8');

describe('the style list is the only list', () => {
  /**
   * THE ONE THAT MATTERS. If someone "helpfully" writes the options into the
   * markup the way the theme menu does, the two lists can drift apart again
   * and a style becomes unselectable with every test still green.
   */
  it('has no hand-written <option> for any style in the markup', () => {
    const select = /<select[^>]*id="bumperStyleSelect"[^>]*>([\s\S]*?)<\/select>/.exec(HTML);
    expect(select, 'the style select is missing from index.html').toBeTruthy();
    expect(select[1].trim()).toBe('');
  });

  it('builds its options from BUILTIN_STYLES', () => {
    // Not a style note: the options existing at all depends on this loop.
    expect(JS).toMatch(/for \(const style of BUILTIN_STYLES\)/);
  });

  it('draws a field for every field a style asks for', () => {
    // A style naming a control nobody built does not throw and does not warn —
    // the control simply never appears, and that reads as a settings bug
    // months later rather than a typo today.
    expect(unknownFields()).toEqual([]);
  });

  it('has markup for every element the registry can show', () => {
    for (const id of allFieldElements()) {
      expect(HTML, `no element id="${id}" for a registered field`).toContain(`id="${id}"`);
    }
  });
});

describe('resolving a saved style', () => {
  it('returns the style whose id was saved', () => {
    expect(resolveStyle('still').id).toBe('still');
  });

  /**
   * A settings file written by a later build, or naming a template that has
   * since been removed, must not leave the channel with no card at all.
   */
  it('falls back to the default rather than nothing for an unknown id', () => {
    expect(resolveStyle('a-style-that-was-deleted').id).toBe(DEFAULT_STYLE_ID);
    expect(resolveStyle(undefined).id).toBe(DEFAULT_STYLE_ID);
  });

  it('ships the default it falls back to', () => {
    expect(BUILTIN_STYLES.some((s) => s.id === DEFAULT_STYLE_ID)).toBe(true);
  });
});

/**
 * Driven with a FAKE list, not the shipping one.
 *
 * Written when only one style existed, because asserting against
 * BUILTIN_STYLES then could not tell "the fields swap" from "there is nothing
 * to swap to". It stays on the fake now that there are two, for a second
 * reason: a test bound to the shipping list changes meaning every time a style
 * is added, and the mechanism it is checking does not. The fake is also the
 * shape an imported template will arrive in.
 */
describe('the fields follow the style', () => {
  const FAKE = [
    { id: 'still', label: 'Still', kind: 'still', fields: ['duration'] },
    { id: 'timed', label: 'Timed', kind: 'video', fields: [] },
  ];

  it('shows the duration control for a still style', () => {
    expect(fieldsFor('still', FAKE)).toEqual([FIELD_ELEMENTS.duration]);
  });

  it('shows no duration control for a style with its own running time', () => {
    expect(fieldsFor('timed', FAKE)).toEqual([]);
  });

  it('knows which styles have a running time of their own', () => {
    expect(isFixedLength('timed', FAKE)).toBe(true);
    expect(isFixedLength('still', FAKE)).toBe(false);
  });

  it('reports a field no one drew instead of silently dropping it', () => {
    // A field name that is not in FIELD_ELEMENTS. Deliberately nonsense
    // rather than a plausible one: this test previously used 'musicDir',
    // which then became a real field and quietly stopped testing anything.
    const broken = [{ id: 'x', label: 'X', kind: 'video', fields: ['noSuchControl'] }];
    expect(unknownFields(broken)).toEqual(['x: noSuchControl']);
  });
});

describe('the settings key', () => {
  /**
   * FLAT, like vhsFont beside it. boot() merges saved settings exactly one
   * level deep, so a nested `bumper: { style }` written before a key existed
   * comes back with that key undefined — and undefined reaches the stylesheet
   * as the string "undefined". Every per-style setting added later must stay
   * flat too, which is easy to forget once there are four of them.
   */
  it('is flat in the defaults, not nested under an object', () => {
    const scheduler = readFileSync(new URL('../src/shared/scheduler.js', import.meta.url), 'utf8');
    expect(scheduler).toMatch(/^\s*bumperStyle: 'still',$/m);
  });
});
