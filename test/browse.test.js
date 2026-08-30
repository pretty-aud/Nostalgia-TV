import { describe, it, expect } from 'vitest';
import {
  readyCopy, seedFromCursors, markEpisode, markMovie, forgetAll, forgetShow, libraryOf,
  resumePoint, movieResumePoint, episodeStatus, watchedCount, continueWatching,
} from '../src/shared/browse.js';

const episodes = (showId, n) => Array.from({ length: n }, (_, i) => ({
  index: i,
  relPath: `${showId}/S01E${String(i + 1).padStart(2, '0')}.mkv`,
  label: `S01E${String(i + 1).padStart(2, '0')}`,
}));

const show = (id, n) => ({ id, name: id, episodes: episodes(id, n), episodeCount: n });

const SHOWS = [show('bigo', 12), show('bebop', 26), show('primal', 5)];
const MOVIES = [
  { name: 'The Thing', relPath: 'MOVIES/The Thing.mkv' },
  { name: 'Akira', relPath: 'MOVIES/Akira.mkv' },
];

const base = (over = {}) => ({ cursors: {}, history: [], library: undefined, ...over });

describe('seeding from the channel', () => {
  it('carries the channel position across so the library does not start out lying', () => {
    // The whole reason seeding exists: eight episodes in, an empty library
    // would claim the show had never been watched.
    const state = seedFromCursors(base({ cursors: { bigo: { index: 8 } } }), SHOWS);

    expect(libraryOf(state).shows.bigo.index).toBe(8);
    expect(watchedCount(SHOWS[0], state)).toBe(8);
  });

  it('marks exactly the episodes the cursor implies, and no more', () => {
    const state = seedFromCursors(base({ cursors: { bigo: { index: 3 } } }), SHOWS);

    expect(episodeStatus(SHOWS[0], 0, state)).toBe('watched');
    expect(episodeStatus(SHOWS[0], 2, state)).toBe('watched');
    expect(episodeStatus(SHOWS[0], 3, state)).toBe('unseen');
  });

  it('ignores shows the channel has never played', () => {
    const state = seedFromCursors(base({ cursors: { bigo: { index: 0 } } }), SHOWS);

    expect(libraryOf(state).shows.bigo).toBeUndefined();
  });

  it('orders by when the channel last played each show', () => {
    const state = seedFromCursors(base({
      cursors: { bigo: { index: 2 }, bebop: { index: 4 } },
      history: [{ showId: 'bebop', at: 200 }, { showId: 'bigo', at: 100 }],
    }), SHOWS);

    expect(continueWatching(SHOWS, MOVIES, state).map((r) => r.id)).toEqual(['bebop', 'bigo']);
  });

  it('runs once, so clearing the library is not undone on the next launch', () => {
    const seeded = seedFromCursors(base({ cursors: { bigo: { index: 8 } } }), SHOWS);
    const cleared = forgetAll(seeded);

    expect(libraryOf(seedFromCursors(cleared, SHOWS)).shows).toEqual({});
  });

  it('survives a cursor pointing past the end of a shortened show', () => {
    // The folder can lose episodes between runs; the cursor does not know.
    const state = seedFromCursors(base({ cursors: { primal: { index: 99 } } }), SHOWS);

    expect(libraryOf(state).shows.primal.index).toBe(5);
    expect(watchedCount(SHOWS[2], state)).toBe(5);
  });
});

describe('recording a watch', () => {
  it('does NOT touch the channel cursor', () => {
    // The entire point of the separation.
    const start = base({ cursors: { bigo: { index: 2 } } });
    const after = markEpisode(start, SHOWS[0], 9, 1400, 1440, 1000);

    expect(after.cursors).toEqual({ bigo: { index: 2 } });
  });

  it('marks only the episode actually finished, not everything before it', () => {
    // A high-water mark would claim one to nine here. That is what the channel
    // does, and it is wrong for a UI you can jump around in.
    const after = markEpisode(base(), SHOWS[0], 9, 1400, 1440, 1000);

    expect(episodeStatus(SHOWS[0], 9, after)).toBe('watched');
    expect(episodeStatus(SHOWS[0], 0, after)).toBe('unseen');
    expect(watchedCount(SHOWS[0], after)).toBe(1);
  });

  it('moves the resume point on when an episode finishes', () => {
    const after = markEpisode(base(), SHOWS[0], 3, 1400, 1440, 1000);

    expect(resumePoint(SHOWS[0], after)).toEqual({ episodeIndex: 4, seekTo: 0 });
  });

  it('leaves the resume point where it stopped part way through', () => {
    const after = markEpisode(base(), SHOWS[0], 3, 600, 1440, 1000);

    expect(resumePoint(SHOWS[0], after)).toEqual({ episodeIndex: 3, seekTo: 600 });
    expect(episodeStatus(SHOWS[0], 3, after)).toBe('resume');
  });

  it('does not offer to resume nine seconds in', () => {
    const after = markEpisode(base(), SHOWS[0], 3, 9, 1440, 1000);

    expect(resumePoint(SHOWS[0], after).seekTo).toBe(0);
    expect(episodeStatus(SHOWS[0], 3, after)).toBe('unseen');
  });

  it('counts the credits as finished', () => {
    // 93% is done. Waiting for the very last frame means nothing is ever
    // watched, because nobody sits through the outro.
    const after = markEpisode(base(), SHOWS[0], 0, 1340, 1440, 1000);

    expect(episodeStatus(SHOWS[0], 0, after)).toBe('watched');
  });

  it('cannot run off the end of the last episode', () => {
    const after = markEpisode(base(), SHOWS[2], 4, 1400, 1440, 1000);

    expect(libraryOf(after).shows.primal.index).toBe(5);
    expect(resumePoint(SHOWS[2], after)).toEqual({ episodeIndex: 0, seekTo: 0 });
  });
});

describe('continue watching', () => {
  it('puts the most recently touched first, shows and movies together', () => {
    let state = base();
    state = markEpisode(state, SHOWS[0], 1, 600, 1440, 100);
    state = markMovie(state, MOVIES[0], 900, 6000, 300);
    state = markEpisode(state, SHOWS[1], 1, 600, 1440, 200);

    expect(continueWatching(SHOWS, MOVIES, state).map((r) => r.id))
      .toEqual(['MOVIES/The Thing.mkv', 'bebop', 'bigo']);
  });

  it('drops a show once it is finished rather than looping it to episode one', () => {
    let state = base();
    for (let i = 0; i < 5; i += 1) state = markEpisode(state, SHOWS[2], i, 1400, 1440, i);

    expect(continueWatching(SHOWS, MOVIES, state).map((r) => r.id)).not.toContain('primal');
  });

  it('drops a finished movie', () => {
    const state = markMovie(base(), MOVIES[0], 5900, 6000, 100);

    expect(continueWatching(SHOWS, MOVIES, state)).toEqual([]);
  });

  it('names the episode to resume, not the one just finished', () => {
    const state = markEpisode(base(), SHOWS[0], 3, 1400, 1440, 100);
    const [row] = continueWatching(SHOWS, MOVIES, state);

    expect(row.episodeIndex).toBe(4);
    expect(row.episode.label).toBe('S01E05');
  });

  it('forgets titles that are no longer in the library', () => {
    // A folder can be renamed or removed between runs; the record outlives it.
    const state = markEpisode(base(), SHOWS[0], 1, 600, 1440, 100);

    expect(continueWatching([SHOWS[1]], MOVIES, state)).toEqual([]);
  });

  it('resumes a movie where it was left', () => {
    const state = markMovie(base(), MOVIES[1], 1800, 6000, 100);

    expect(movieResumePoint(MOVIES[1], state).seekTo).toBe(1800);
  });
});

describe('the episode that was still on screen', () => {
  const SHOW = show('lazarus', 13);

  it('seeds as in progress rather than as finished', () => {
    // A cursor moves when an episode STARTS. Ten seconds into episode four the
    // cursor already reads four, so seeding from it alone would offer episode
    // five — and the first thing the library said about the show she was
    // actually watching would be wrong.
    const state = seedFromCursors(base({
      cursors: { lazarus: { index: 4 } },
      resume: { showId: 'lazarus', episodeIndex: 3, relPath: 'lazarus/S01E04.mkv', position: 620 },
    }), [SHOW]);

    expect(resumePoint(SHOW, state)).toEqual({ episodeIndex: 3, seekTo: 620 });
    expect(episodeStatus(SHOW, 3, state)).toBe('resume');
  });

  it('does not count a started episode as watched', () => {
    const state = seedFromCursors(base({
      cursors: { lazarus: { index: 4 } },
      resume: { showId: 'lazarus', episodeIndex: 3, relPath: 'lazarus/S01E04.mkv', position: 620 },
    }), [SHOW]);

    expect(watchedCount(SHOW, state)).toBe(3);
    expect(episodeStatus(SHOW, 2, state)).toBe('watched');
  });

  it('ignores a resume pointing at a show that is gone', () => {
    const state = seedFromCursors(base({
      cursors: { lazarus: { index: 4 } },
      resume: { showId: 'deleted', episodeIndex: 3, position: 620 },
    }), [SHOW]);

    expect(resumePoint(SHOW, state)).toEqual({ episodeIndex: 4, seekTo: 0 });
  });
});

describe('what the library screen says about what is behind it', () => {
  const PLAYING_MOVIE = { title: 'The Thing', detail: '15:00 in.' };
  const RESUMABLE = { title: 'Big O', detail: 'S01E09 - 4:20 in.' };

  it('describes a playing MOVIE rather than the channel schedule', () => {
    // The reported bug. state.resume is never written for a movie, so the
    // screen fell through to "Start the channel / First up: something else"
    // while the button underneath said Resume and resumed the film.
    const copy = readyCopy(PLAYING_MOVIE, null, 'Courage The Cowardly Dog S01E08');

    expect(copy.title).toBe('The Thing');
    expect(copy.body).toBe('15:00 in.');
    expect(copy.button).toBe('Resume');
    expect(copy.body).not.toMatch(/First up/);
  });

  it('describes what is LOADED even when the channel has its own resume', () => {
    // Both records can be set at once: watch a library episode over a channel
    // one, and state.resume still holds the channel's. Resume plays what is
    // loaded, so that is what the screen has to name.
    const copy = readyCopy(PLAYING_MOVIE, RESUMABLE, 'Something Else S01E01');

    expect(copy.title).toBe('The Thing');
  });

  it('falls back to the channel resume when nothing is loaded', () => {
    const copy = readyCopy(null, RESUMABLE, 'Something Else S01E01');

    expect(copy.title).toBe('Big O');
    expect(copy.button).toBe('Resume');
  });

  it('offers the schedule only when there is genuinely nothing to return to', () => {
    const copy = readyCopy(null, null, 'Courage The Cowardly Dog S01E08');

    expect(copy.eyebrow).toBe('Ready');
    expect(copy.title).toBe('Start the channel');
    expect(copy.body).toBe('First up: Courage The Cowardly Dog S01E08.');
  });

  it('says so when there is nothing at all', () => {
    const copy = readyCopy(null, null, null);

    expect(copy.body).toMatch(/Switch a show back on/);
  });
});

describe('forgetShow', () => {
  it('forgets one show and keeps every other record', () => {
    const shows = [
      { id: 'a', episodes: episodes('a', 3) },
      { id: 'b', episodes: episodes('b', 3) },
    ];
    const seeded = seedFromCursors(
      { cursors: { a: { index: 1 }, b: { index: 1 } }, history: [] },
      shows,
    );
    const cleared = forgetShow(seeded, 'a');
    expect(libraryOf(cleared).shows.a).toBeUndefined();
    expect(libraryOf(cleared).shows.b).toBeDefined();
    // seeded stays true: clearing one show must not invite a global re-seed.
    expect(libraryOf(cleared).seeded).toBe(true);
  });

  it('returns the state unchanged when there is nothing to forget', () => {
    const state = { library: { shows: {}, movies: {}, seeded: true } };
    expect(forgetShow(state, 'ghost')).toBe(state);
  });
});
