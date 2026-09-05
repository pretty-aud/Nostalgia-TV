import { describe, it, expect } from 'vitest';
import { FONT_CHOICES, DEFAULT_FONTS, fontStackFor } from '../src/shared/fonts.js';

/**
 * The interface can be set in six faces, and the one thing that must never
 * happen is the app coming back in NO face — a settings file written by a
 * later version, or a hand-edited one, must not be able to blank the type.
 */
describe('the font choices', () => {
  it('offers six, each with an id, a label and a stack', () => {
    expect(FONT_CHOICES).toHaveLength(6);
    for (const font of FONT_CHOICES) {
      expect(typeof font.id).toBe('string');
      expect(font.id).not.toBe('');
      expect(typeof font.label).toBe('string');
      expect(font.stack).toBeTruthy();
    }
  });

  it('has no duplicate ids, which would make one choice unreachable', () => {
    const ids = FONT_CHOICES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('ends every stack in a generic family', () => {
    // Three of the six are Windows faces rather than bundled ones, so the
    // last resort has to be a SHAPE — a missing serif should fall to a serif,
    // not to whatever the browser happens to reach for first.
    const generics = ['sans-serif', 'serif', 'monospace', 'cursive', 'system-ui'];
    for (const font of FONT_CHOICES) {
      const last = font.stack.split(',').pop().trim();
      expect(generics, `${font.id} ends in "${last}"`).toContain(last);
    }
  });

  it('names the app\'s own bundled faces as the defaults', () => {
    // Anything else would mean a fresh install did not look like the design.
    expect(fontStackFor(DEFAULT_FONTS.display)).toContain('Space Grotesk');
    expect(fontStackFor(DEFAULT_FONTS.body)).toContain('Inter');
  });

  it('covers the four looks the app promises', () => {
    const stackFor = (id) => fontStackFor(id, id);
    expect(stackFor('terminal')).toMatch(/Mono|Consolas/);   // retro terminal
    expect(stackFor('serif')).toContain('Georgia');           // traditional
    expect(stackFor('modern')).toContain('Bahnschrift');      // very modern
    expect(stackFor('playful')).toMatch(/Ink Free|Comic/);    // fun
  });
});

describe('resolving a saved id', () => {
  it('returns the chosen face', () => {
    expect(fontStackFor('serif', 'inter')).toContain('Georgia');
  });

  it('falls back rather than blanking the interface', () => {
    // A file from a later version naming a face this build has never heard
    // of must land on the fallback, not on undefined.
    expect(fontStackFor('face-from-the-future', 'inter')).toContain('Inter');
    expect(fontStackFor(undefined, 'terminal')).toMatch(/Mono|Consolas/);
    expect(fontStackFor(null, 'serif')).toContain('Georgia');
  });

  it('still returns a real stack when the FALLBACK is nonsense too', () => {
    // Both arguments wrong is the case that would actually leave the app
    // unstyled, so it resolves to the first choice rather than nothing.
    const stack = fontStackFor('nope', 'also-nope');
    expect(stack).toBeTruthy();
    expect(stack).toBe(FONT_CHOICES[0].stack);
  });
});
