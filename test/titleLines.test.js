import { describe, it, expect } from 'vitest';
import { titleLines, hasSeam } from '../src/shared/titleLines.js';

describe('titleLines', () => {
  it('breaks a series from its subtitle at a spaced hyphen', () => {
    expect(titleLines('Ghost in the Shell - Stand Alone Complex'))
      .toEqual(['Ghost in the Shell', 'Stand Alone Complex']);
  });

  it('handles the Gundam shape she is about to add', () => {
    expect(titleLines('Mobile Suit Gundam - The Witch from Mercury'))
      .toEqual(['Mobile Suit Gundam', 'The Witch from Mercury']);
  });

  it('leaves a title with no seam alone', () => {
    expect(titleLines('Yu Yu Hakusho')).toEqual(['Yu Yu Hakusho']);
    expect(titleLines('Cowboy Bebop')).toEqual(['Cowboy Bebop']);
  });

  it('does NOT break a hyphenated word', () => {
    // No spaces: this is one word, not a seam.
    expect(titleLines('Spider-Man')).toEqual(['Spider-Man']);
    expect(titleLines('Cyberpunk-Edgerunners')).toEqual(['Cyberpunk-Edgerunners']);
  });

  it('breaks only ONCE, at the first seam', () => {
    // A row has a height budget; a title that keeps subdividing would push
    // the list off the bottom of the sidebar.
    expect(titleLines("Rurouni Kenshin - Trust and Betrayal - Director's Cut"))
      .toEqual(['Rurouni Kenshin', "Trust and Betrayal - Director's Cut"]);
  });

  it('accepts en and em dashes, which are the same seam', () => {
    expect(titleLines('Ghost in the Shell – Stand Alone Complex'))
      .toEqual(['Ghost in the Shell', 'Stand Alone Complex']);
    expect(titleLines('Ghost in the Shell — Stand Alone Complex'))
      .toEqual(['Ghost in the Shell', 'Stand Alone Complex']);
  });

  it('tolerates ragged spacing around the seam', () => {
    expect(titleLines('Ghost in the Shell   -   Stand Alone Complex'))
      .toEqual(['Ghost in the Shell', 'Stand Alone Complex']);
  });

  it('refuses to produce an empty line', () => {
    // Punctuation at either end is not structure. Rendering these as a break
    // would draw a blank row, which is worse than the long title.
    expect(titleLines('- Stand Alone Complex')).toEqual(['- Stand Alone Complex']);
    expect(titleLines('Ghost in the Shell -')).toEqual(['Ghost in the Shell -']);
  });

  it('never returns nothing to draw', () => {
    for (const input of ['', '   ', null, undefined]) {
      const lines = titleLines(input);
      expect(lines).toHaveLength(1);
      expect(typeof lines[0]).toBe('string');
    }
  });

  it('trims the parts it returns', () => {
    expect(titleLines('  Ghost in the Shell - Stand Alone Complex  '))
      .toEqual(['Ghost in the Shell', 'Stand Alone Complex']);
  });

  it('hasSeam agrees with titleLines', () => {
    expect(hasSeam('Ghost in the Shell - Stand Alone Complex')).toBe(true);
    expect(hasSeam('Yu Yu Hakusho')).toBe(false);
    expect(hasSeam('Spider-Man')).toBe(false);
  });
});
