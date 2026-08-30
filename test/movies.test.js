import { describe, it, expect } from 'vitest';
import {
  buildLibrary, parseMovie, isMoviePath, isPresentationPath,
} from '../src/shared/parseEpisode.js';
import {
  createState, applySettings, shouldPlayMovie, nextMovie, markMoviePlayed,
  scheduleMovie, tickMovieLead, movieIsDue, clearPendingMovie,
} from '../src/shared/scheduler.js';

function mulberry32(seed) {
  let a = seed;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const paths = (...rel) => rel.map((relPath) => ({ relPath, absPath: `D:/TV/${relPath}` }));
const films = (n) => Array.from({ length: n }, (_, i) => ({
  relPath: `MOVIES/m${i + 1}.mkv`, fileName: `m${i + 1}.mkv`, name: `m${i + 1}`,
}));
const HOUR = 3600 * 1000;

describe('folder classification', () => {
  it('recognises the movies folder', () => {
    expect(isMoviePath('MOVIES/Alien.mkv')).toBe(true);
    expect(isMoviePath('Movies/Alien/Alien.mkv')).toBe(true);   // a movie in its own folder
    expect(isMoviePath('Seinfeld/Movies/S01E01.mkv')).toBe(false);
  });

  it('accepts both spellings of the presentation folder', () => {
    // The folder was described as MOVIE PRESENTATION and as MOVE PRESENTATION.
    // Matching only one would make the feature silently do nothing.
    for (const p of ['MOVIE PRESENTATION/a.mp4', 'MOVE PRESENTATION/a.mp4',
      'Movie_Presentation/a.mp4', 'movie-presentations/a.mp4']) {
      expect(isPresentationPath(p), p).toBe(true);
    }
  });

  it('keeps movies and presentations out of the shows', () => {
    const { shows, movies, presentations } = buildLibrary(paths(
      'Seinfeld/S01E01.mkv',
      'MOVIES/Blade Runner 1982 1080p BluRay x264-GROUP.mkv',
      'MOVIE PRESENTATION/feature.mp4',
    ), { rootName: 'TV' });

    expect(shows.map((s) => s.name)).toEqual(['Seinfeld']);
    expect(movies).toHaveLength(1);
    expect(presentations).toHaveLength(1);
  });
});

describe('parseMovie', () => {
  it('takes the title from the FILE, not the folder', () => {
    expect(parseMovie('MOVIES/Alien/Alien 1979 2160p.mkv').name).toBe('Alien');
  });

  it('lifts the year out of the title', () => {
    const m = parseMovie('MOVIES/Blade Runner 1982 1080p BluRay x264-GROUP.mkv');
    expect(m.name).toBe('Blade Runner');
    expect(m.year).toBe(1982);
  });

  it('handles dots as separators', () => {
    const m = parseMovie('MOVIES/The.Thing.1982.REMASTERED.1080p.mkv');
    expect(m.name).toBe('The Thing');
    expect(m.year).toBe(1982);
  });

  it('copes with a bracketed year', () => {
    expect(parseMovie('MOVIES/Akira (1988) [1080p].mkv').name).toBe('Akira');
  });

  it('never returns an empty title', () => {
    // A row with no name is worse than a messy one.
    expect(parseMovie('MOVIES/1080p.mkv').name).toBeTruthy();
  });

  it('leaves a title with no year alone', () => {
    const m = parseMovie('MOVIES/Spirited Away.mkv');
    expect(m.name).toBe('Spirited Away');
    expect(m.year).toBeNull();
  });
});

describe('the movie clock', () => {
  const withEvery = (hours, extra = {}) => applySettings(
    [], { ...createState('/tv'), ...extra }, { movieEvery: hours }, { rng: mulberry32(1) },
  );

  it('is on every 24 hours by default', () => {
    const state = createState('/tv');
    expect(state.settings.moviesEnabled).toBe(true);
    expect(state.settings.movieEvery).toBe(24);
    expect(shouldPlayMovie(state, films(3), { now: 1e12 })).toBe(true);
  });

  it('the switch overrides the clock, however overdue', () => {
    // The switch is a separate setting from the interval precisely so that
    // turning movies off does not lose how often you wanted them.
    const state = applySettings([], { ...createState('/tv'), lastMovieAt: 0 },
      { moviesEnabled: false }, { rng: mulberry32(1) });
    expect(shouldPlayMovie(state, films(3), { now: 1e12 })).toBe(false);
    expect(state.settings.movieEvery).toBe(24);
  });

  it('switching back on resumes at the interval already chosen', () => {
    let state = applySettings([], createState('/tv'), { movieEvery: 6 }, { rng: mulberry32(1) });
    state = applySettings([], state, { moviesEnabled: false }, { rng: mulberry32(1) });
    state = applySettings([], { ...state, lastMovieAt: 1e12 },
      { moviesEnabled: true }, { rng: mulberry32(1) });

    expect(state.settings.movieEvery).toBe(6);
    expect(shouldPlayMovie(state, films(3), { now: 1e12 + 5.9 * HOUR })).toBe(false);
    expect(shouldPlayMovie(state, films(3), { now: 1e12 + 6 * HOUR })).toBe(true);
  });

  it('plays immediately the first time, so the setting can be seen working', () => {
    expect(shouldPlayMovie(withEvery(3), films(3), { now: 1e12 })).toBe(true);
  });

  it('waits the full interval after one has played', () => {
    const state = withEvery(3, { lastMovieAt: 1e12 });
    expect(shouldPlayMovie(state, films(3), { now: 1e12 + 2.9 * HOUR })).toBe(false);
    expect(shouldPlayMovie(state, films(3), { now: 1e12 + 3 * HOUR })).toBe(true);
  });

  it('respects each interval the settings offer', () => {
    for (const hours of [3, 6, 12, 24, 48]) {
      const state = withEvery(hours, { lastMovieAt: 1e12 });
      expect(shouldPlayMovie(state, films(2), { now: 1e12 + (hours - 0.1) * HOUR }), `${hours}h early`).toBe(false);
      expect(shouldPlayMovie(state, films(2), { now: 1e12 + hours * HOUR }), `${hours}h due`).toBe(true);
    }
  });

  it('never plays when the folder is empty', () => {
    expect(shouldPlayMovie(withEvery(3), [], { now: 1e12 })).toBe(false);
  });

  it('restarts the clock from when the movie STARTED', () => {
    // Not from when it was due: a two-hour film must not immediately qualify
    // for another one the moment it finishes.
    const started = markMoviePlayed(withEvery(3), { now: 1e12 });
    expect(started.lastMovieAt).toBe(1e12);
    expect(shouldPlayMovie(started, films(3), { now: 1e12 + 2 * HOUR })).toBe(false);
  });
});

describe('booking a movie ahead of time', () => {
  const on = (extra = {}) => applySettings(
    [], { ...createState('/tv'), ...extra }, {}, { rng: mulberry32(1) },
  );

  it('deals it immediately and puts it one to three blocks out', () => {
    const picked = scheduleMovie(films(4), on(), { rng: mulberry32(8) });
    expect(picked.movie).toBeTruthy();
    expect(picked.state.pendingMovie).toBe(picked.movie);
    expect(picked.state.movieLeadBlocks).toBeGreaterThanOrEqual(1);
    expect(picked.state.movieLeadBlocks).toBeLessThanOrEqual(3);
  });

  it('does not book a second one over the first', () => {
    const first = scheduleMovie(films(4), on(), { rng: mulberry32(8) });
    const second = scheduleMovie(films(4), first.state, { rng: mulberry32(3) });
    expect(second.state.pendingMovie).toBe(first.state.pendingMovie);
    expect(second.state.movieLeadBlocks).toBe(first.state.movieLeadBlocks);
  });

  it('books nothing while movies are switched off', () => {
    const off = applySettings([], createState('/tv'), { moviesEnabled: false }, { rng: mulberry32(1) });
    expect(scheduleMovie(films(3), off, { rng: mulberry32(2) }).state.pendingMovie).toBeFalsy();
  });

  it('books nothing when the folder is empty', () => {
    expect(scheduleMovie([], on(), { rng: mulberry32(2) }).state.pendingMovie).toBeFalsy();
  });

  it('spends the lead only where the show changes', () => {
    let state = scheduleMovie(films(3), on(), { rng: mulberry32(8), leadBlocks: 2 }).state;

    // Still inside a block: two episodes of the same show in a row.
    state = tickMovieLead(state, { finishedShowId: 'a', nextShowId: 'a' });
    expect(state.movieLeadBlocks).toBe(2);

    state = tickMovieLead(state, { finishedShowId: 'a', nextShowId: 'b' });
    expect(state.movieLeadBlocks).toBe(1);
    expect(movieIsDue(state)).toBe(false);

    state = tickMovieLead(state, { finishedShowId: 'b', nextShowId: 'c' });
    expect(movieIsDue(state)).toBe(true);
  });

  it('never goes below zero, however many boundaries pass', () => {
    let state = scheduleMovie(films(2), on(), { rng: mulberry32(8), leadBlocks: 1 }).state;
    for (let i = 0; i < 5; i += 1) state = tickMovieLead(state, { finishedShowId: 'a', nextShowId: 'b' });
    expect(state.movieLeadBlocks).toBe(0);
    expect(movieIsDue(state)).toBe(true);
  });

  it('is not due while nothing is booked', () => {
    expect(movieIsDue(createState('/tv'))).toBe(false);
    expect(tickMovieLead(createState('/tv'), { finishedShowId: 'a', nextShowId: 'b' }).movieLeadBlocks)
      .toBe(0);
  });

  it('clears the booking when the movie starts, so it cannot play twice', () => {
    const booked = scheduleMovie(films(3), on(), { rng: mulberry32(8), leadBlocks: 1 }).state;
    const played = markMoviePlayed(booked, { now: 1e12 });
    expect(played.pendingMovie).toBeNull();
    expect(played.movieLeadBlocks).toBe(0);
    expect(played.lastMovieAt).toBe(1e12);
    expect(movieIsDue(played)).toBe(false);
  });

  it('can be cancelled outright', () => {
    const booked = scheduleMovie(films(3), on(), { rng: mulberry32(8) }).state;
    expect(clearPendingMovie(booked).pendingMovie).toBeNull();
  });
});

describe('nextMovie', () => {
  it('plays every movie once before repeating', () => {
    const list = films(5);
    let state = createState('/tv');
    const seen = [];
    for (let i = 0; i < 5; i += 1) {
      const picked = nextMovie(list, state, { rng: mulberry32(4) });
      state = picked.state;
      seen.push(picked.movie.relPath);
    }
    expect(new Set(seen).size).toBe(5);
  });

  it('keeps a deck of its own, separate from bumpers and promos', () => {
    const picked = nextMovie(films(4), createState('/tv'), { rng: mulberry32(2) });
    expect(picked.state.movieDeck).toHaveLength(3);
    expect(picked.state.bumperDeck).toEqual([]);
    expect(picked.state.promoDeck).toEqual([]);
  });

  it('returns null with no movies rather than stalling', () => {
    expect(nextMovie([], createState('/tv'), { rng: mulberry32(1) }).movie).toBeNull();
  });
});

describe('years inside titles', () => {
  it('keeps 2049 in BladeRunner 2049 and takes 2017 as the year', () => {
    // The first year-shaped number is part of the NAME; the release year sits
    // at the end. Taking the first match renamed the film "BladeRunner".
    const movie = parseMovie('MOVIES/BladeRunner 2049 - 2017.mkv');
    expect(movie.name).toBe('BladeRunner 2049');
    expect(movie.year).toBe(2017);
  });

  it('survives the year appearing twice', () => {
    const movie = parseMovie('MOVIES/2001 A Space Odyssey - 1968.mkv');
    expect(movie.name).toBe('2001 A Space Odyssey');
    expect(movie.year).toBe(1968);
  });

  it('still parses the plain trailing-year form', () => {
    const movie = parseMovie('MOVIES/Akira (1988) - 1080p Hybrid.mkv');
    expect(movie.year).toBe(1988);
    expect(movie.name).toMatch(/^Akira/);
  });
});
