import { describe, it, expect } from 'vitest';
import {
  DEFAULT_GENRES, tagsOf, cleanTag, keyFor, hasTag, sortTags, tagsFor, withTags,
  allTags, tagsInUse, matchesGenres, withCustomTag, withoutTag, countTagged,
} from '../src/shared/genres.js';

/**
 * Genre tags, the pure half.
 *
 * The rules pinned here are the ones a careless edit would break silently:
 * near-duplicate tags must collide rather than split a shelf, an emptied
 * title must leave nothing behind, the filter must be ANY and not ALL, and
 * the store must survive a state file written before it existed.
 */

const show = (id) => ({ id });
const movie = (relPath) => ({ relPath });

const stateWith = (tags) => ({ tags });

describe('tagsOf', () => {
  it('gives the full shape for state that predates the feature', () => {
    // The renderer hydrates with a SHALLOW spread, so an old save arrives
    // with no `tags` key at all and every read would throw on `.shows`.
    for (const missing of [undefined, null, {}, { tags: undefined }, { tags: {} }]) {
      const store = tagsOf(missing);
      expect(store.shows).toEqual({});
      expect(store.movies).toEqual({});
      expect(store.custom).toEqual([]);
    }
  });

  it('repairs a half-written store rather than trusting it', () => {
    const store = tagsOf({ tags: { shows: { a: ['Horror'] } } });
    expect(store.shows).toEqual({ a: ['Horror'] });
    expect(store.movies).toEqual({});
    expect(store.custom).toEqual([]);
  });

  it('refuses a custom list that is not a list', () => {
    expect(tagsOf({ tags: { custom: 'Horror' } }).custom).toEqual([]);
  });
});

describe('cleanTag', () => {
  it('trims and collapses whitespace', () => {
    expect(cleanTag('  slice   of  life ')).toBe('slice of life');
  });

  it('caps the length so a chip stays a chip', () => {
    expect(cleanTag('x'.repeat(80))).toHaveLength(24);
  });

  it('survives the values a text input can actually produce', () => {
    expect(cleanTag(null)).toBe('');
    expect(cleanTag(undefined)).toBe('');
    expect(cleanTag(0)).toBe('0');
  });

  it('does NOT case-fold — the chip should read the way it was typed', () => {
    expect(cleanTag('Sci-Fi')).toBe('Sci-Fi');
  });
});

describe('keyFor', () => {
  it('folds case and punctuation, so near-duplicates collide', () => {
    // The whole point: typing these must not create four separate shelves.
    const keys = ['Sci-Fi', 'sci fi', 'SCI-FI', 'Sci  Fi'].map(keyFor);
    expect(new Set(keys).size).toBe(1);
  });

  it('keeps genuinely different tags apart', () => {
    expect(keyFor('Horror')).not.toBe(keyFor('Horrors'));
    expect(keyFor('Action')).not.toBe(keyFor('Adventure'));
  });

  it('is empty for something that is only punctuation', () => {
    expect(keyFor('---')).toBe('');
    expect(keyFor('   ')).toBe('');
  });
});

describe('hasTag', () => {
  it('matches case-insensitively', () => {
    expect(hasTag(['Horror'], 'horror')).toBe(true);
    expect(hasTag(['Slice of Life'], 'slice-of-life')).toBe(true);
  });

  it('is false for an empty tag, never true by accident', () => {
    expect(hasTag(['Horror'], '')).toBe(false);
    expect(hasTag(['Horror'], '  ')).toBe(false);
  });

  it('tolerates a missing list', () => {
    expect(hasTag(undefined, 'Horror')).toBe(false);
  });
});

describe('sortTags', () => {
  it('sorts A-Z ignoring case, so lowercase does not sink to the bottom', () => {
    expect(sortTags(['zombie', 'Anime', 'action'])).toEqual(['action', 'Anime', 'zombie']);
  });

  it('does not mutate its input', () => {
    const list = ['b', 'a'];
    sortTags(list);
    expect(list).toEqual(['b', 'a']);
  });
});

describe('tagsFor', () => {
  const state = stateWith({ shows: { berserk: ['Horror', 'Action'] }, movies: { 'MOVIES/Akira.mkv': ['Sci-Fi'] } });

  it('reads shows by id and movies by relPath', () => {
    expect(tagsFor(state, 'show', 'berserk')).toEqual(['Action', 'Horror']);
    expect(tagsFor(state, 'movie', 'MOVIES/Akira.mkv')).toEqual(['Sci-Fi']);
  });

  it('returns sorted, so the chips never reorder between renders', () => {
    expect(tagsFor(state, 'show', 'berserk')).toEqual(['Action', 'Horror']);
  });

  it('is an empty array for anything untagged or malformed', () => {
    expect(tagsFor(state, 'show', 'nope')).toEqual([]);
    expect(tagsFor(state, 'show', '')).toEqual([]);
    expect(tagsFor(state, '', 'berserk')).toEqual([]);
    expect(tagsFor(stateWith({ shows: { x: 'Horror' } }), 'show', 'x')).toEqual([]);
  });
});

describe('withTags', () => {
  it('stores a cleaned, sorted, de-duplicated list', () => {
    const next = withTags({}, 'show', 'a', ['  Horror ', 'Action', 'horror']);
    expect(next.shows.a).toEqual(['Action', 'Horror']);
  });

  it('DELETES the key when the list empties, rather than leaving []', () => {
    // Nothing prunes this store against a scan, so an empty array would be
    // permanent litter in the save file.
    const state = stateWith({ shows: { a: ['Horror'] } });
    expect(withTags(state, 'show', 'a', []).shows).toEqual({});
    expect(withTags(state, 'show', 'a', ['  ']).shows).toEqual({});
  });

  it('leaves every other title alone', () => {
    const state = stateWith({ shows: { a: ['Horror'], b: ['Comedy'] }, movies: { m: ['Drama'] } });
    const next = withTags(state, 'show', 'a', ['Action']);
    expect(next.shows.b).toEqual(['Comedy']);
    expect(next.movies.m).toEqual(['Drama']);
  });

  it('does not mutate the state it was given', () => {
    const state = stateWith({ shows: { a: ['Horror'] } });
    withTags(state, 'show', 'a', ['Action']);
    expect(state.tags.shows.a).toEqual(['Horror']);
  });

  it('refuses a tag that is only punctuation', () => {
    // It survives cleanTag but folds to an empty key, so it could be stored
    // and then never matched, counted or deleted — a chip that does nothing.
    expect(withTags({}, 'show', 'a', ['---']).shows).toEqual({});
    expect(withTags({}, 'show', 'a', ['Horror', '···']).shows.a).toEqual(['Horror']);
  });

  it('writes movies into the movies bucket, not shows', () => {
    const next = withTags({}, 'movie', 'MOVIES/Akira.mkv', ['Sci-Fi']);
    expect(next.movies['MOVIES/Akira.mkv']).toEqual(['Sci-Fi']);
    expect(next.shows).toEqual({});
  });
});

describe('DEFAULT_GENRES', () => {
  it('carries both Animation and Anime, the convention this app chose', () => {
    // An anime title is tagged BOTH. If Animation ever silently meant
    // "non-anime animation", filtering it would hide half the library.
    expect(DEFAULT_GENRES).toContain('Animation');
    expect(DEFAULT_GENRES).toContain('Anime');
  });

  it('has no near-duplicates under the app\'s own collision rule', () => {
    const keys = DEFAULT_GENRES.map(keyFor);
    expect(new Set(keys).size).toBe(DEFAULT_GENRES.length);
  });

  it('is already sorted, so the picker needs no special first render', () => {
    expect(DEFAULT_GENRES).toEqual(sortTags(DEFAULT_GENRES));
  });

  it('is short enough to scan', () => {
    expect(DEFAULT_GENRES.length).toBeLessThanOrEqual(20);
  });
});

describe('allTags', () => {
  it('is the defaults when nothing has been tagged', () => {
    expect(allTags({})).toEqual(sortTags(DEFAULT_GENRES));
  });

  it('includes user-created tags', () => {
    expect(allTags(stateWith({ custom: ['Isekai'] }))).toContain('Isekai');
  });

  it('includes a tag that is only ON a title and in no list', () => {
    // A hand-edited save, or one written before `custom` existed. A tag you
    // can see on a chip but cannot find in the picker reads as a bug.
    expect(allTags(stateWith({ shows: { a: ['Iyashikei'] } }))).toContain('Iyashikei');
  });

  it('never lists a default twice because someone re-typed it', () => {
    const tags = allTags(stateWith({ custom: ['horror'], shows: { a: ['HORROR'] } }));
    expect(tags.filter((t) => keyFor(t) === keyFor('Horror'))).toHaveLength(1);
  });
});

describe('tagsInUse', () => {
  const shows = [show('a'), show('b'), show('c')];
  const movies = [movie('m1')];
  const state = stateWith({
    shows: { a: ['Horror', 'Anime'], b: ['Anime'] },
    movies: { m1: ['Horror'] },
    custom: ['Isekai'],
  });

  it('offers ONLY tags something actually carries', () => {
    // The filter must not list 14 options that return an empty page.
    const names = tagsInUse(state, shows, movies).map((t) => t.name);
    expect(names).toEqual(['Anime', 'Horror']);
    expect(names).not.toContain('Isekai');
    expect(names).not.toContain('Drama');
  });

  it('counts titles across shows AND movies', () => {
    const byName = Object.fromEntries(tagsInUse(state, shows, movies).map((t) => [t.name, t.count]));
    expect(byName.Horror).toBe(2);
    expect(byName.Anime).toBe(2);
  });

  it('ignores tags on titles the library no longer contains', () => {
    // The store is never pruned, so a deleted show's tags linger — they must
    // not put a dead option in the filter.
    const names = tagsInUse(state, [show('a')], []).map((t) => t.name);
    expect(names).toEqual(['Anime', 'Horror']);
    expect(tagsInUse(state, [], []).length).toBe(0);
  });

  it('counts a near-duplicate as one option', () => {
    const messy = stateWith({ shows: { a: ['Sci-Fi'], b: ['sci fi'] } });
    const used = tagsInUse(messy, [show('a'), show('b')], []);
    expect(used).toHaveLength(1);
    expect(used[0].count).toBe(2);
  });

  it('is empty for a library nobody has tagged', () => {
    expect(tagsInUse({}, shows, movies)).toEqual([]);
  });
});

describe('matchesGenres', () => {
  it('passes everything when nothing is selected', () => {
    expect(matchesGenres([], [])).toBe(true);
    expect(matchesGenres(['Horror'], undefined)).toBe(true);
  });

  it('is ANY, not ALL', () => {
    // Two ticks on a ~55-title library must widen the shelf, not empty it.
    expect(matchesGenres(['Horror'], ['Horror', 'Comedy'])).toBe(true);
    expect(matchesGenres(['Comedy'], ['Horror', 'Comedy'])).toBe(true);
  });

  it('excludes a title carrying none of the selected tags', () => {
    expect(matchesGenres(['Drama'], ['Horror'])).toBe(false);
    expect(matchesGenres([], ['Horror'])).toBe(false);
  });

  it('matches case- and punctuation-insensitively', () => {
    expect(matchesGenres(['Sci-Fi'], ['sci fi'])).toBe(true);
  });

  it('treats a selection of only junk as no selection at all', () => {
    expect(matchesGenres(['Drama'], ['   '])).toBe(true);
  });
});

describe('withCustomTag', () => {
  it('adds a tag nobody has yet', () => {
    expect(withCustomTag({}, 'Isekai').custom).toEqual(['Isekai']);
  });

  it('is a no-op for a tag that already exists in any form', () => {
    expect(withCustomTag({}, 'Horror').custom).toEqual([]);
    expect(withCustomTag({}, 'horror').custom).toEqual([]);
    expect(withCustomTag(stateWith({ custom: ['Isekai'] }), 'ISEKAI').custom).toEqual(['Isekai']);
    expect(withCustomTag(stateWith({ shows: { a: ['Iyashikei'] } }), 'iyashikei').custom).toEqual([]);
  });

  it('ignores an empty or punctuation-only tag', () => {
    expect(withCustomTag({}, '   ').custom).toEqual([]);
    expect(withCustomTag({}, '---').custom).toEqual([]);
  });
});

describe('withoutTag', () => {
  const state = stateWith({
    shows: { a: ['Horror', 'Anime'], b: ['Horror'] },
    movies: { m1: ['Horror', 'Drama'] },
    custom: ['Horror', 'Isekai'],
  });

  it('strips the tag from every title and from the vocabulary', () => {
    const next = withoutTag(state, 'Horror');
    expect(next.shows.a).toEqual(['Anime']);
    expect(next.movies.m1).toEqual(['Drama']);
    expect(next.custom).toEqual(['Isekai']);
  });

  it('drops a title that had nothing else, rather than leaving []', () => {
    expect(withoutTag(state, 'Horror').shows.b).toBeUndefined();
  });

  it('matches case-insensitively', () => {
    expect(withoutTag(state, 'HORROR').shows.b).toBeUndefined();
  });

  it('does not mutate the state it was given', () => {
    withoutTag(state, 'Horror');
    expect(state.tags.shows.a).toEqual(['Horror', 'Anime']);
  });

  it('is a no-op for junk', () => {
    expect(withoutTag(state, '  ').shows.a).toEqual(['Horror', 'Anime']);
  });
});

describe('countTagged', () => {
  const shows = [show('a'), show('b')];
  const movies = [movie('m1')];
  const state = stateWith({ shows: { a: ['Horror'], b: ['Comedy'] }, movies: { m1: ['horror'] } });

  it('counts shows and movies together, case-insensitively', () => {
    expect(countTagged(state, shows, movies, 'Horror')).toBe(2);
  });

  it('counts only titles the library still holds', () => {
    expect(countTagged(state, [show('a')], [], 'Horror')).toBe(1);
  });

  it('is zero for an unused or junk tag', () => {
    expect(countTagged(state, shows, movies, 'Isekai')).toBe(0);
    expect(countTagged(state, shows, movies, '  ')).toBe(0);
  });
});
