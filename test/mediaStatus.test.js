import { describe, it, expect } from 'vitest';
import {
  entryConverts,
  summarizeShow,
  movieVerdict,
  describeShowConversion,
  describeMovieConversion,
  describeEpisodeConversion,
} from '../src/shared/mediaStatus.js';

/**
 * The library table's words, pinned. The rule that matters most: absence of a
 * verdict is NOT a verdict — an un-ingested episode must read "not checked",
 * never fold into "plays as-is".
 */

const show = {
  id: 'bigo',
  episodes: [
    { relPath: 'BigO/E1.mkv' },
    { relPath: 'BigO/E2.mkv' },
    { relPath: 'BigO/E3.mkv' },
  ],
};

describe('summarizeShow', () => {
  it('splits judged from unjudged, and never guesses', () => {
    const entries = {
      'episode:BigO/E1.mkv': { needsWork: true, at: 1 },
      'episode:BigO/E2.mkv': { needsWork: false, at: 1 },
      // E3 never ingested
    };
    expect(summarizeShow(show, entries)).toEqual({ total: 3, needsWork: 1, playsAsIs: 1, unknown: 1 });
  });

  it('treats an entry without a verdict as unknown, not as fine', () => {
    // The ingest writes verdict-less entries when a file was unreadable; the
    // table must not launder that into "plays as-is".
    const entries = { 'episode:BigO/E1.mkv': { at: 1 } };
    expect(summarizeShow(show, entries).unknown).toBe(3);
  });
});

describe('the table copy', () => {
  it('says ingest first when nothing was checked', () => {
    expect(describeShowConversion({ total: 3, needsWork: 0, playsAsIs: 0, unknown: 3 }))
      .toBe('not checked — ingest first');
  });

  it('reads as a sentence when the picture is mixed', () => {
    expect(describeShowConversion({ total: 5, needsWork: 2, playsAsIs: 2, unknown: 1 }))
      .toBe('2 need converting · 2 play as-is · 1 not checked');
  });

  it('handles the singular', () => {
    expect(describeShowConversion({ total: 2, needsWork: 1, playsAsIs: 1, unknown: 0 }))
      .toBe('1 needs converting · 1 plays as-is');
  });

  it('movie rows say the same three things the same way', () => {
    expect(describeMovieConversion({ known: false })).toBe('not checked — ingest first');
    expect(describeMovieConversion({ known: true, needsWork: true })).toBe('needs converting');
    expect(describeMovieConversion({ known: true, needsWork: false })).toBe('plays as-is');
  });

  it('episode detail rows stay terse', () => {
    const entries = { 'episode:BigO/E1.mkv': { needsWork: true } };
    expect(describeEpisodeConversion(entries, 'BigO/E1.mkv')).toBe('converts');
    expect(describeEpisodeConversion(entries, 'BigO/E9.mkv')).toBe('not checked');
  });
});

describe('movieVerdict', () => {
  it('answers only from the ledger', () => {
    const movie = { relPath: 'MOVIES/Akira.mkv' };
    expect(movieVerdict(movie, {}).known).toBe(false);
    expect(movieVerdict(movie, { 'movie:MOVIES/Akira.mkv': { needsWork: false, tier: 'direct' } }))
      .toEqual({ known: true, needsWork: false, tier: 'direct' });
  });
});

describe('entryConverts — the planner-vs-player rule', () => {
  it('a remux with the wanted track first plays as-is', () => {
    // The planner never promises Matroska; the player proves it at first
    // play. Recording the caution as "needs converting" painted a wall of
    // false warnings over a library that plays natively.
    expect(entryConverts({ needsWork: true, tier: 'remux', audioIndex: 0 })).toBe(false);
  });

  it('a remux forced by track selection is a real conversion', () => {
    expect(entryConverts({ needsWork: true, tier: 'remux', audioIndex: 2 })).toBe(true);
  });

  it('audio and full re-encodes are always real', () => {
    expect(entryConverts({ needsWork: true, tier: 'audio', audioIndex: 0 })).toBe(true);
    expect(entryConverts({ needsWork: true, tier: 'full', audioIndex: 0 })).toBe(true);
  });

  it('a pre-fix remux entry is unknown, never guessed', () => {
    // Entries recorded before audioIndex existed cannot be told apart;
    // they re-check rather than claim either answer.
    expect(entryConverts({ needsWork: true, tier: 'remux' })).toBe(null);
  });

  it('no verdict is unknown', () => {
    expect(entryConverts(null)).toBe(null);
    expect(entryConverts({ at: 1 })).toBe(null);
  });
});
