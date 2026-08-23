import { describe, it, expect } from 'vitest';
import {
  showKey, movieKey, parseKey, lockableItems,
  prerequisiteMet, earnUnlocks, isLocked, lockedShowIds, unlockedMovies,
  lockLabel, wouldCycle, setLock, resetUnlocks, recordMoviePlayed,
} from '../src/shared/locks.js';
import {
  createState, applySettings, refillQueue, peek, scheduleMovie, markMoviePlayed,
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

const makeShows = (count, episodes) => Array.from({ length: count }, (_, s) => ({
  id: `show-${s}`,
  name: `Show ${s}`,
  episodes: Array.from({ length: episodes }, (_, e) => ({
    relPath: `Show ${s}/S01E${String(e + 1).padStart(2, '0')}.mp4`,
    fileName: `S01E${String(e + 1).padStart(2, '0')}.mp4`,
    season: 1, episode: e + 1, title: `Ep ${e + 1}`, index: e, confidence: 'high',
  })),
}));

const films = (n) => Array.from({ length: n }, (_, i) => ({
  relPath: `MOVIES/m${i + 1}.mkv`, fileName: `m${i + 1}.mkv`, name: `Film ${i + 1}`, year: 1990 + i,
}));

/** A state with one lock in it and cursors where the caller wants them. */
function withLock(key, lock, cursors = {}) {
  const base = createState('/tv');
  return {
    ...base,
    cursors,
    settings: { ...base.settings, locks: { [key]: lock } },
  };
}

describe('keys', () => {
  it('round-trips a show and a movie', () => {
    expect(parseKey(showKey('big-o'))).toEqual({ type: 'show', id: 'big-o' });
    expect(parseKey(movieKey('MOVIES/Akira.mkv'))).toEqual({ type: 'movie', id: 'MOVIES/Akira.mkv' });
  });

  it('survives a path containing a colon, which every Windows path does', () => {
    // 'movie:D:/TV/x.mkv' must not split on the drive letter's colon.
    expect(parseKey(movieKey('D:/TV/x.mkv'))).toEqual({ type: 'movie', id: 'D:/TV/x.mkv' });
  });

  it('refuses nonsense rather than inventing a type', () => {
    expect(parseKey('')).toBeNull();
    expect(parseKey('nope')).toBeNull();
    expect(parseKey('other:thing')).toBeNull();
  });

  it('lists shows and movies together', () => {
    const items = lockableItems(makeShows(2, 3), films(1));
    expect(items.map((i) => i.key)).toEqual(['show:show-0', 'show:show-1', 'movie:MOVIES/m1.mkv']);
  });
});

describe('when a prerequisite counts as played', () => {
  const shows = makeShows(1, 4);

  it('a whole show needs the counter to REACH the last episode', () => {
    const context = (index) => ({ shows, cursors: { 'show-0': { index } }, moviesPlayed: {} });
    const lock = { after: 'show:show-0', wholeShow: true };
    expect(prerequisiteMet(lock, context(3))).toBe(false);
    expect(prerequisiteMet(lock, context(4))).toBe(true);
  });

  it('a specific episode needs the counter PAST it, not on it', () => {
    // Sitting on episode 3 means it is next, not watched.
    const context = (index) => ({ shows, cursors: { 'show-0': { index } }, moviesPlayed: {} });
    const lock = { after: 'show:show-0', wholeShow: false, episodeIndex: 2 };
    expect(prerequisiteMet(lock, context(2))).toBe(false);
    expect(prerequisiteMet(lock, context(3))).toBe(true);
  });

  it('a movie needs to have actually played', () => {
    const lock = { after: 'movie:MOVIES/m1.mkv' };
    expect(prerequisiteMet(lock, { shows, cursors: {}, moviesPlayed: {} })).toBe(false);
    expect(prerequisiteMet(lock, { shows, cursors: {}, moviesPlayed: { 'MOVIES/m1.mkv': 1 } })).toBe(true);
  });

  it('treats a show missing from the scan as UNMET, never as satisfied', () => {
    // "Absent from this scan" is usually "unreadable right now". Unlocking on
    // that would play the sequel first, which is the whole thing being avoided.
    const lock = { after: 'show:gone', wholeShow: true };
    expect(prerequisiteMet(lock, { shows, cursors: {}, moviesPlayed: {} })).toBe(false);
  });
});

describe('unlocks are earned once and kept', () => {
  const shows = makeShows(1, 3);

  it('does not unlock while the prerequisite is unfinished', () => {
    const state = earnUnlocks(withLock('movie:MOVIES/m1.mkv',
      { after: 'show:show-0', wholeShow: true }, { 'show-0': { index: 1 } }), shows);
    expect(isLocked('movie:MOVIES/m1.mkv', state)).toBe(true);
  });

  it('unlocks when it finishes', () => {
    const state = earnUnlocks(withLock('movie:MOVIES/m1.mkv',
      { after: 'show:show-0', wholeShow: true }, { 'show-0': { index: 3 } }), shows);
    expect(isLocked('movie:MOVIES/m1.mkv', state)).toBe(false);
  });

  it('STAYS unlocked after the show loops back to episode one', () => {
    // The reason unlocked is stored rather than recomputed: this channel loops
    // by default, so a live rule would re-lock the sequel on every lap.
    let state = earnUnlocks(withLock('movie:MOVIES/m1.mkv',
      { after: 'show:show-0', wholeShow: true }, { 'show-0': { index: 3 } }), shows);
    expect(isLocked('movie:MOVIES/m1.mkv', state)).toBe(false);

    state = { ...state, cursors: { 'show-0': { index: 0 } } };
    state = earnUnlocks(state, shows);
    expect(isLocked('movie:MOVIES/m1.mkv', state)).toBe(false);
  });

  it('re-locks only when the unlocks are reset by hand', () => {
    let state = earnUnlocks(withLock('movie:MOVIES/m1.mkv',
      { after: 'show:show-0', wholeShow: true }, { 'show-0': { index: 3 } }), shows);
    state = resetUnlocks({ ...state, cursors: { 'show-0': { index: 0 } } });
    expect(isLocked('movie:MOVIES/m1.mkv', state)).toBe(true);
  });

  it('returns the SAME object when nothing changed, so callers can skip a save', () => {
    const state = withLock('movie:MOVIES/m1.mkv',
      { after: 'show:show-0', wholeShow: true }, { 'show-0': { index: 0 } });
    expect(earnUnlocks(state, shows)).toBe(state);
  });
});

describe('cycles are refused', () => {
  it('spots a direct loop', () => {
    expect(wouldCycle({ 'show:b': { after: 'show:a' } }, 'show:a', 'show:b')).toBe(true);
  });

  it('spots a longer chain looping back', () => {
    const locks = { 'show:b': { after: 'show:c' }, 'show:c': { after: 'show:a' } };
    expect(wouldCycle(locks, 'show:a', 'show:b')).toBe(true);
  });

  it('allows a straight chain, which is how a trilogy is expressed', () => {
    const locks = { 'show:b': { after: 'show:a' } };
    expect(wouldCycle(locks, 'show:c', 'show:b')).toBe(false);
  });

  it('refuses pointing something at itself', () => {
    expect(wouldCycle({}, 'show:a', 'show:a')).toBe(true);
  });

  it('setLock leaves the settings untouched when the edit would loop', () => {
    let settings = { locks: {} };
    settings = setLock(settings, 'show:b', { after: 'show:a' });
    const before = JSON.stringify(settings.locks);
    settings = setLock(settings, 'show:a', { after: 'show:b' });
    expect(JSON.stringify(settings.locks)).toBe(before);
  });

  it('clears a lock when given nothing to wait for', () => {
    let settings = setLock({ locks: {} }, 'show:b', { after: 'show:a' });
    settings = setLock(settings, 'show:b', null);
    expect(settings.locks['show:b']).toBeUndefined();
  });
});

describe('the channel actually skips locked things', () => {
  it('keeps a locked show out of the queue', () => {
    const shows = makeShows(3, 4);
    const base = createState('/tv');
    const state = refillQueue(shows, {
      ...base,
      settings: { ...base.settings, locks: { 'show:show-1': { after: 'show:show-0', wholeShow: true } } },
    }, { rng: mulberry32(4) });

    expect(state.queue.length).toBeGreaterThan(0);
    expect(state.queue.some((item) => item.showId === 'show-1')).toBe(false);
    expect(state.queue.some((item) => item.showId === 'show-0')).toBe(true);
  });

  it('lets it back in once the prerequisite is done', () => {
    const shows = makeShows(3, 4);
    const base = createState('/tv');
    let state = {
      ...base,
      cursors: { 'show-0': { index: 4 } },
      settings: { ...base.settings, locks: { 'show:show-1': { after: 'show:show-0', wholeShow: true } } },
    };
    state = earnUnlocks(state, shows);
    state = refillQueue(shows, state, { rng: mulberry32(4) });
    expect(state.queue.some((item) => item.showId === 'show-1')).toBe(true);
  });

  it('MARATHON overrides a lock, because asking by name is explicit', () => {
    const shows = makeShows(3, 4);
    const base = createState('/tv');
    const state = refillQueue(shows, {
      ...base,
      settings: {
        ...base.settings,
        marathonShowId: 'show-1',
        locks: { 'show:show-1': { after: 'show:show-0', wholeShow: true } },
      },
    }, { rng: mulberry32(4) });

    expect(state.queue.length).toBeGreaterThan(0);
    expect(state.queue.every((item) => item.showId === 'show-1')).toBe(true);
  });

  it('never deals a locked movie', () => {
    const base = createState('/tv');
    const state = {
      ...base,
      settings: {
        ...base.settings,
        locks: {
          'movie:MOVIES/m1.mkv': { after: 'show:show-0', wholeShow: true },
          'movie:MOVIES/m3.mkv': { after: 'show:show-0', wholeShow: true },
        },
      },
    };
    for (let seed = 1; seed <= 12; seed += 1) {
      const picked = scheduleMovie(films(3), state, { rng: mulberry32(seed) });
      expect(picked.movie && picked.movie.relPath).toBe('MOVIES/m2.mkv');
    }
  });

  it('books nothing at all when every movie is locked', () => {
    const base = createState('/tv');
    const locks = {};
    for (const film of films(3)) locks[movieKey(film.relPath)] = { after: 'show:show-0', wholeShow: true };
    const state = { ...base, settings: { ...base.settings, locks } };
    expect(scheduleMovie(films(3), state, { rng: mulberry32(2) }).movie).toBeNull();
  });

  it('records a movie as played when it starts, which is what a sequel waits on', () => {
    const base = createState('/tv');
    const state = markMoviePlayed({ ...base, pendingMovie: films(1)[0] }, { now: 1e12 });
    expect(state.moviesPlayed['MOVIES/m1.mkv']).toBe(1e12);
    expect(prerequisiteMet({ after: 'movie:MOVIES/m1.mkv' },
      { shows: [], cursors: {}, moviesPlayed: state.moviesPlayed })).toBe(true);
  });
});

describe('what the row says it is waiting for', () => {
  const shows = makeShows(2, 5);

  it('names a whole show', () => {
    const state = withLock('show:show-1', { after: 'show:show-0', wholeShow: true });
    expect(lockLabel('show:show-1', state, shows, [])).toBe('all of Show 0');
  });

  it('names the episode when it is not the whole show', () => {
    const state = withLock('show:show-1', { after: 'show:show-0', wholeShow: false, episodeIndex: 2 });
    expect(lockLabel('show:show-1', state, shows, [])).toBe('Show 0 S01E03');
  });

  it('names a movie', () => {
    const state = withLock('show:show-1', { after: 'movie:MOVIES/m1.mkv' });
    expect(lockLabel('show:show-1', state, shows, films(1))).toBe('Film 1');
  });

  it('says nothing at all when the item is free', () => {
    expect(lockLabel('show:show-1', createState('/tv'), shows, [])).toBeNull();
  });

  it('is honest when the prerequisite has left the library', () => {
    const state = withLock('show:show-1', { after: 'show:vanished', wholeShow: true });
    expect(lockLabel('show:show-1', state, shows, [])).toContain('no longer in the library');
  });
});

describe('helpers the renderer leans on', () => {
  it('lockedShowIds returns only the shows still held back', () => {
    const shows = makeShows(2, 3);
    let state = withLock('show:show-1', { after: 'show:show-0', wholeShow: true }, { 'show-0': { index: 0 } });
    expect([...lockedShowIds(state)]).toEqual(['show-1']);

    state = earnUnlocks({ ...state, cursors: { 'show-0': { index: 3 } } }, shows);
    expect([...lockedShowIds(state)]).toEqual([]);
  });

  it('unlockedMovies drops the held-back films', () => {
    const base = createState('/tv');
    const state = {
      ...base,
      settings: { ...base.settings, locks: { 'movie:MOVIES/m2.mkv': { after: 'show:x', wholeShow: true } } },
    };
    expect(unlockedMovies(films(3), state).map((m) => m.relPath))
      .toEqual(['MOVIES/m1.mkv', 'MOVIES/m3.mkv']);
  });

  it('recordMoviePlayed ignores an empty path rather than writing a junk key', () => {
    const state = createState('/tv');
    expect(recordMoviePlayed(state, null)).toBe(state);
  });
});
