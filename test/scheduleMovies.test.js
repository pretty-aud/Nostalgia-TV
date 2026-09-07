import { describe, it, expect } from 'vitest';
import {
  MOVIE_BLOCK, isMovieBlock, hasMovieBlocks, normaliseSchedule,
  moviesForSchedule, nextScheduledMovie,
  createState, refillQueue, pruneQueue, peek, advance, showsInSchedule, isEnabled,
  DEFAULT_SETTINGS,
} from '../src/shared/scheduler.js';

/**
 * FILMS PLACED IN A RUNNING ORDER.
 *
 * A schedule's items used to be show ids and only show ids, and four separate
 * places quietly deleted anything else: the editor pruned on every render, the
 * deck refill filtered unknown entries out, the dealer skipped them, and
 * pruneQueue dropped queue entries that resolved to no episode. Every one of
 * those looked like correct defensive code. The feature would have appeared to
 * work and then emptied itself.
 */
const film = (name, year) => ({
  relPath: `MOVIES/${name}.mkv`, fileName: `${name}.mkv`, name, year,
  absPath: `D:/TV/MOVIES/${name}.mkv`, mediaUrl: `media://${name}`,
});
const FILMS = [film('Alien', 1979), film('Blade Runner', 1982), film('Contact', 1997)];

const show = (id, count = 4) => ({
  id,
  name: id,
  episodes: Array.from({ length: count }, (_, i) => ({
    relPath: `${id}/S01E0${i + 1}.mkv`, showId: id, showName: id, season: 1, episode: i + 1,
  })),
});
const SHOWS = [show('alpha'), show('beta')];

describe('the reserved entry', () => {
  it('is a string, so items never stops being string[]', () => {
    expect(typeof MOVIE_BLOCK).toBe('string');
  });

  /**
   * showId() lowercases a folder name and turns every run of non-alphanumerics
   * into a dash, so no show id can contain an underscore. The token is
   * unreachable by the id generator rather than merely unlikely.
   */
  it('cannot be produced by the show-id generator', () => {
    expect(MOVIE_BLOCK).toMatch(/_/);
    expect(MOVIE_BLOCK.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')).not.toBe(MOVIE_BLOCK);
  });

  it('recognises itself and nothing else', () => {
    expect(isMovieBlock(MOVIE_BLOCK)).toBe(true);
    for (const other of ['alpha', '__movies__', 'movie', '', null, undefined, 0]) {
      expect(isMovieBlock(other), `${String(other)} must not read as a film`).toBe(false);
    }
  });

  it('reports whether a schedule places films at all', () => {
    expect(hasMovieBlocks({ items: ['alpha', MOVIE_BLOCK] })).toBe(true);
    expect(hasMovieBlocks({ items: ['alpha', 'beta'] })).toBe(false);
    expect(hasMovieBlocks(null)).toBe(false);
  });
});

/**
 * The token must be invisible to the two places that read items as a set of
 * SHOW ids. Both were already safe — a token can never equal a show id — but
 * "already safe" is the kind of claim that stops being true when someone later
 * makes the comparison looser.
 */
describe('the two places that read items as shows', () => {
  const schedule = { id: 's', name: 'S', items: ['alpha', MOVIE_BLOCK, 'beta'] };

  it('does not put a film in the sidebar show list', () => {
    expect(showsInSchedule(SHOWS, schedule).map((s) => s.id)).toEqual(['alpha', 'beta']);
  });

  it('does not let a film change which shows may play', () => {
    const settings = { ...DEFAULT_SETTINGS, schedules: [schedule], activeScheduleId: 's' };
    expect(isEnabled(show('alpha'), settings, new Set())).toBe(true);
    expect(isEnabled(show('gamma'), settings, new Set())).toBe(false);
  });
});

describe('normalising a schedule saved before any of this existed', () => {
  const old = { id: 'sat', name: 'Saturday', blockSize: 2, items: ['alpha'] };

  it('fills every field, so nothing downstream reads undefined', () => {
    const n = normaliseSchedule(old);
    expect(n.bumperStyle).toBe(null);
    expect(n.movies).toBe(null);
    expect(n.movieOrder).toBe('shuffle');
  });

  it('leaves what was already there alone', () => {
    expect(normaliseSchedule(old)).toMatchObject({ id: 'sat', name: 'Saturday', blockSize: 2, items: ['alpha'] });
  });

  it('treats an empty movie list as no list at all', () => {
    // "I opened the box and put nothing in it" is not a decision to play
    // nothing. Note this is the OPPOSITE of items, where empty means empty.
    expect(normaliseSchedule({ ...old, movies: [] }).movies).toBe(null);
  });

  it('rejects a movieOrder it does not understand rather than storing it', () => {
    expect(normaliseSchedule({ ...old, movieOrder: 'sideways' }).movieOrder).toBe('shuffle');
    expect(normaliseSchedule({ ...old, movieOrder: 'inorder' }).movieOrder).toBe('inorder');
  });

  it('clamps a block size that could stall or flood the channel', () => {
    expect(normaliseSchedule({ ...old, blockSize: 0 }).blockSize).toBe(1);
    expect(normaliseSchedule({ ...old, blockSize: 99 }).blockSize).toBe(12);
  });
});

describe('which films a schedule may play', () => {
  it('plays everything when she has not made a list', () => {
    expect(moviesForSchedule(FILMS, { movies: null })).toHaveLength(3);
    expect(moviesForSchedule(FILMS, { movies: [] })).toHaveLength(3);
  });

  it('plays only her list once she has made one', () => {
    const chosen = moviesForSchedule(FILMS, { movies: [FILMS[2].relPath, FILMS[0].relPath] });
    expect(chosen.map((m) => m.name)).toEqual(['Contact', 'Alien']);
  });

  it('keeps her order, because with shuffle off her order is the running order', () => {
    const chosen = moviesForSchedule(FILMS, { movies: [FILMS[1].relPath, FILMS[0].relPath] });
    expect(chosen.map((m) => m.name)).toEqual(['Blade Runner', 'Alien']);
  });

  /**
   * A renamed file must NOT fall back to the whole folder. She chose a list
   * because the others do not suit the schedule; playing one of them because a
   * file moved is the one outcome worse than playing none.
   */
  it('drops a film the library cannot see rather than falling back to all', () => {
    const chosen = moviesForSchedule(FILMS, { movies: ['MOVIES/Gone.mkv', FILMS[0].relPath] });
    expect(chosen.map((m) => m.name)).toEqual(['Alien']);
  });

  it('plays nothing when every film on her list has gone', () => {
    expect(moviesForSchedule(FILMS, { movies: ['MOVIES/Gone.mkv'] })).toEqual([]);
  });
});

describe('choosing the film for a placed block', () => {
  const inorder = normaliseSchedule({ id: 'sat', name: 'S', items: [MOVIE_BLOCK], movieOrder: 'inorder' });
  const base = () => createState('D:/TV');

  it('walks the list in order', () => {
    let state = base();
    const played = [];
    for (let i = 0; i < 3; i += 1) {
      const out = nextScheduledMovie(FILMS, state, inorder);
      state = out.state;
      played.push(out.movie.name);
    }
    expect(played).toEqual(['Alien', 'Blade Runner', 'Contact']);
  });

  it('loops back to the top at the end', () => {
    let state = base();
    const played = [];
    for (let i = 0; i < 5; i += 1) {
      const out = nextScheduledMovie(FILMS, state, inorder);
      state = out.state;
      played.push(out.movie.name);
    }
    expect(played).toEqual(['Alien', 'Blade Runner', 'Contact', 'Alien', 'Blade Runner']);
  });

  it('remembers where it got to, which is what survives a restart', () => {
    let state = base();
    state = nextScheduledMovie(FILMS, state, inorder).state;
    // Only the cursor is carried over — everything else is a fresh launch.
    const restarted = { ...base(), scheduleMovieCursor: state.scheduleMovieCursor };
    expect(nextScheduledMovie(FILMS, restarted, inorder).movie.name).toBe('Blade Runner');
  });

  /**
   * BY PATH FIRST, index second. An index alone stops meaning anything the
   * moment she reorders the list — it would silently point at a different film.
   */
  it('follows the film it last played when she reorders the list', () => {
    let state = base();
    state = nextScheduledMovie(FILMS, state, inorder).state;      // Alien
    const reordered = [FILMS[2], FILMS[1], FILMS[0]];             // Contact, Blade Runner, Alien
    expect(nextScheduledMovie(reordered, state, inorder).movie.name).toBe('Contact');
  });

  it('keeps two schedules on separate positions', () => {
    const other = { ...inorder, id: 'late' };
    let state = base();
    state = nextScheduledMovie(FILMS, state, inorder).state;
    state = nextScheduledMovie(FILMS, state, inorder).state;
    // 'late' has never played anything and must start at the beginning.
    expect(nextScheduledMovie(FILMS, state, other).movie.name).toBe('Alien');
  });

  it('shuffles when asked to, without repeating until the list is spent', () => {
    const shuffled = { ...inorder, movieOrder: 'shuffle' };
    let state = base();
    const played = [];
    for (let i = 0; i < 3; i += 1) {
      const out = nextScheduledMovie(FILMS, state, shuffled, { rng: () => 0.42 });
      state = out.state;
      played.push(out.movie.name);
    }
    expect(new Set(played).size, 'a deck must not repeat inside one pass').toBe(3);
  });

  it('plays nothing when her list names only films that have gone', () => {
    const gone = { ...inorder, movies: ['MOVIES/Gone.mkv'] };
    expect(nextScheduledMovie(FILMS, base(), gone).movie).toBe(null);
  });
});

describe('a placed block through the queue', () => {
  const schedule = normaliseSchedule({
    id: 'sat', name: 'Saturday', blockSize: 1, items: ['alpha', MOVIE_BLOCK, 'beta'],
  });
  const stateWith = () => ({
    ...createState('D:/TV'),
    settings: { ...DEFAULT_SETTINGS, schedules: [schedule], activeScheduleId: 'sat' },
  });

  it('reaches the queue as a marker, in the position she put it', () => {
    const { queue } = refillQueue(SHOWS, stateWith(), { rng: () => 0.42 });
    const shape = queue.slice(0, 3).map((item) => (item.movieBlock ? 'MOVIE' : item.showId));
    expect(shape).toEqual(['alpha', 'MOVIE', 'beta']);
  });

  /**
   * THE ONE THAT WOULD HAVE EMPTIED THE FEATURE. pruneQueue drops any entry
   * that resolves to no episode, and a placed film resolves to none by design —
   * so every rescan would have deleted them all, silently.
   */
  it('survives a rescan', () => {
    const { queue } = refillQueue(SHOWS, stateWith(), { rng: () => 0.42 });
    expect(pruneQueue(SHOWS, queue).filter((i) => i.movieBlock)).toHaveLength(
      queue.filter((i) => i.movieBlock).length,
    );
    expect(pruneQueue(SHOWS, queue).some((i) => i.movieBlock)).toBe(true);
  });

  it('is announced in Up next rather than being invisible between two episodes', () => {
    const state = { ...stateWith() };
    const filled = refillQueue(SHOWS, state, { rng: () => 0.42 });
    const upcoming = peek(SHOWS, { ...state, queue: filled.queue }, 3);
    expect(upcoming.map((e) => (e.movieBlock ? 'MOVIE' : e.showName))).toEqual(['alpha', 'MOVIE', 'beta']);
  });

  it('leaves the queue without writing a cursor or a history entry for it', () => {
    const state = { ...stateWith() };
    const filled = refillQueue(SHOWS, state, { rng: () => 0.42 });
    const after = advance(SHOWS, { ...state, queue: filled.queue.slice(1), deck: filled.deck }, { rng: () => 0.42 });
    expect(after.item.movieBlock).toBe(true);
    expect(after.movieBlock).toBe(true);
    expect(after.state.cursors[MOVIE_BLOCK], 'a film is not a show and has no cursor').toBeUndefined();
    expect((after.state.history || []).some((h) => h.showId === MOVIE_BLOCK)).toBe(false);
  });

  it('does not spin for ever on a schedule made only of films', () => {
    const filmsOnly = normaliseSchedule({ id: 'f', name: 'F', blockSize: 1, items: [MOVIE_BLOCK] });
    const state = {
      ...createState('D:/TV'),
      settings: { ...DEFAULT_SETTINGS, schedules: [filmsOnly], activeScheduleId: 'f' },
    };
    const { queue } = refillQueue(SHOWS, state, { rng: () => 0.42 });
    expect(queue.length).toBeGreaterThan(0);
    expect(queue.every((i) => i.movieBlock)).toBe(true);
  });
});
