'use strict';

/**
 * Library mode's own record of what has been watched.
 *
 * Deliberately SEPARATE from the channel's cursors. Picking episode nine out of
 * the middle of a show because you feel like it should not move where the
 * channel is up to — that was the call, and it is the right one for a browse
 * UI. The cost is that this app now has two answers to "where am I in this
 * show", which is a thing to be careful with rather than casual about.
 *
 * Two consequences fall straight out of that and are handled here:
 *
 *  - Seeding. A library that starts empty does not say "no progress yet", it
 *    says "you have never watched Big O" to somebody eight episodes in. That is
 *    wrong information, not a blank slate, so the channel's position is copied
 *    across ONCE and the two diverge from there.
 *
 *  - Honesty about jumping. The channel keeps a high-water index because it
 *    only ever moves forward. Here you can watch episode nine first, so a
 *    high-water mark would quietly claim one to eight as well. `seen` records
 *    what was actually finished; `index` is only the resume point.
 *
 * Everything here is pure so it can be tested without a window, a player or a
 * disk. The renderer owns when to call it; this owns what it means.
 */

/** Far enough in that finishing is a formality — credits, next-episode card. */
const DONE_FRACTION = 0.92;

/** Below this, "resume" is a lie: nobody wants to pick up nine seconds in. */
const RESUME_FLOOR_SECONDS = 30;

function emptyLibrary() {
  return { shows: {}, movies: {}, seeded: false };
}

/** Never mutate what came off disk; every writer here returns a new object. */
function withLibrary(state, library) {
  return { ...state, library };
}

function libraryOf(state) {
  const raw = (state && state.library) || {};
  return {
    shows: raw.shows || {},
    movies: raw.movies || {},
    seeded: Boolean(raw.seeded),
  };
}

/**
 * Copy the channel's position into the library, once and only once.
 *
 * `seeded` is a flag rather than an emptiness check: a viewer who deliberately
 * clears their library progress would otherwise have the channel's poured back
 * in on the next launch, forever.
 *
 * Ordering matters for Continue Watching, so each seeded show takes the
 * timestamp of the last time the channel actually played it. Shows with no
 * history entry get 0 and sort to the bottom, which is honest: we know where
 * they got to but not when.
 */
function seedFromCursors(state, shows) {
  const library = libraryOf(state);
  if (library.seeded) return state;

  const lastPlayed = new Map();
  for (const entry of state.history || []) {
    if (entry && entry.showId && !lastPlayed.has(entry.showId)) {
      lastPlayed.set(entry.showId, entry.at || 0);
    }
  }

  const seeded = {};
  const byId = new Map(shows.map((s) => [s.id, s]));

  for (const [showId, cursor] of Object.entries(state.cursors || {})) {
    const index = Math.max(0, Number(cursor && cursor.index) || 0);
    if (index <= 0) continue;                       // nothing watched, nothing to say
    const show = byId.get(showId);
    if (!show || !show.episodes.length) continue;

    // A cursor IS a high-water mark, so translating it to per-episode `seen` is
    // the one place the two models genuinely line up: the channel cannot have
    // reached index N without having played 0..N-1.
    const seen = {};
    for (let i = 0; i < Math.min(index, show.episodes.length); i += 1) {
      seen[show.episodes[i].relPath] = true;
    }

    const at = show.episodes[Math.min(index, show.episodes.length - 1)];
    seeded[showId] = {
      index: Math.min(index, show.episodes.length),
      relPath: at ? at.relPath : null,
      position: 0,
      at: lastPlayed.get(showId) || 0,
      seen,
    };
  }

  /**
   * The episode still in progress.
   *
   * A cursor is set when an episode STARTS, not when it finishes, so a show
   * stopped ten seconds into episode four has a cursor of four and reads as
   * "four done, play five". Seeding straight from the cursor therefore skips
   * the episode actually on screen, and the first thing the library ever says
   * about the show you were last watching is wrong. state.resume is the only
   * record of that, so it gets the last word.
   */
  const resume = state.resume;
  if (resume && resume.showId && seeded[resume.showId]) {
    const show = byId.get(resume.showId);
    const episode = show && show.episodes[resume.episodeIndex];
    if (episode) {
      const record = seeded[resume.showId];
      const seen = { ...record.seen };
      delete seen[episode.relPath];        // started is not watched
      seeded[resume.showId] = {
        ...record,
        index: resume.episodeIndex,
        relPath: episode.relPath,
        position: Math.max(0, Number(resume.position) || 0),
        seen,
      };
    }
  }

  return withLibrary(state, { ...library, shows: seeded, seeded: true });
}

/**
 * Record where an episode got to.
 *
 * `done` is derived rather than passed in, so "watched" means the same thing
 * everywhere — an episode left running to the credits and one closed at 92% are
 * the same event, and the caller does not get to disagree.
 */
function markEpisode(state, show, episodeIndex, position, duration, now) {
  if (!show || !show.episodes[episodeIndex]) return state;

  const library = libraryOf(state);
  const episode = show.episodes[episodeIndex];
  const prior = library.shows[show.id] || { seen: {} };
  const done = Number.isFinite(duration) && duration > 0
    && position >= duration * DONE_FRACTION;

  const seen = { ...(prior.seen || {}) };
  if (done) seen[episode.relPath] = true;

  // Finishing moves the resume point on; stopping part way leaves it here.
  const nextIndex = done ? episodeIndex + 1 : episodeIndex;
  const landing = show.episodes[nextIndex] || null;

  return withLibrary(state, {
    ...library,
    shows: {
      ...library.shows,
      [show.id]: {
        index: Math.min(nextIndex, show.episodes.length),
        relPath: done ? (landing ? landing.relPath : null) : episode.relPath,
        position: done ? 0 : Math.max(0, position || 0),
        at: now || Date.now(),
        seen,
      },
    },
  });
}

function markMovie(state, movie, position, duration, now) {
  if (!movie || !movie.relPath) return state;
  const library = libraryOf(state);
  const done = Number.isFinite(duration) && duration > 0
    && position >= duration * DONE_FRACTION;

  return withLibrary(state, {
    ...library,
    movies: {
      ...library.movies,
      [movie.relPath]: {
        position: done ? 0 : Math.max(0, position || 0),
        done,
        at: now || Date.now(),
      },
    },
  });
}

/** Wipe library progress without touching the channel. */
function forgetAll(state) {
  return withLibrary(state, { shows: {}, movies: {}, seeded: true });
}

/**
 * What "play" on a show card should do: resume, or start the next one.
 *
 * Returns { episodeIndex, seekTo }. A show finished to the end starts over,
 * because the alternative is a play button that does nothing.
 */
function resumePoint(show, state) {
  const record = libraryOf(state).shows[show.id];
  if (!record) return { episodeIndex: 0, seekTo: 0 };

  const index = Math.min(Number(record.index) || 0, show.episodes.length);
  if (index >= show.episodes.length) return { episodeIndex: 0, seekTo: 0 };

  const position = Number(record.position) || 0;
  return {
    episodeIndex: index,
    seekTo: position >= RESUME_FLOOR_SECONDS ? position : 0,
  };
}

function movieResumePoint(movie, state) {
  const record = libraryOf(state).movies[movie.relPath];
  const position = record ? Number(record.position) || 0 : 0;
  return { seekTo: position >= RESUME_FLOOR_SECONDS ? position : 0 };
}

/** 'watched' | 'resume' | 'unseen', per episode, for the episode list. */
function episodeStatus(show, episodeIndex, state) {
  const record = libraryOf(state).shows[show.id];
  const episode = show.episodes[episodeIndex];
  if (!record || !episode) return 'unseen';
  if (record.seen && record.seen[episode.relPath]) return 'watched';
  if (record.index === episodeIndex && (Number(record.position) || 0) >= RESUME_FLOOR_SECONDS) {
    return 'resume';
  }
  return 'unseen';
}

/** How far into the episode currently being resumed, as a 0..1 fraction. */
function episodeFraction(show, episodeIndex, state, duration) {
  const record = libraryOf(state).shows[show.id];
  if (!record || record.index !== episodeIndex) return 0;
  const position = Number(record.position) || 0;
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return Math.min(1, position / duration);
}

function watchedCount(show, state) {
  const record = libraryOf(state).shows[show.id];
  if (!record || !record.seen) return 0;
  return show.episodes.reduce((n, ep) => n + (record.seen[ep.relPath] ? 1 : 0), 0);
}

/**
 * The Continue Watching row.
 *
 * Shows and movies together, most recently touched first, because that is the
 * question the row answers — "what was I in the middle of" — and it is not a
 * question that cares which kind of thing the answer is.
 *
 * A show that has been watched to the end drops out rather than looping back to
 * episode one. Continue Watching is for things left unfinished; a finished show
 * reappearing there every time is the row slowly filling with everything.
 */
function continueWatching(shows, movies, state, limit = 12) {
  const library = libraryOf(state);
  const byId = new Map(shows.map((s) => [s.id, s]));
  const rows = [];

  for (const [showId, record] of Object.entries(library.shows)) {
    const show = byId.get(showId);
    if (!show || !show.episodes.length) continue;
    const index = Math.min(Number(record.index) || 0, show.episodes.length);
    if (index >= show.episodes.length) continue;          // finished
    const episode = show.episodes[index];
    if (!episode) continue;
    rows.push({
      kind: 'show',
      id: showId,
      name: show.name,
      show,
      episode,
      episodeIndex: index,
      position: Number(record.position) || 0,
      at: Number(record.at) || 0,
    });
  }

  const byPath = new Map(movies.map((m) => [m.relPath, m]));
  for (const [relPath, record] of Object.entries(library.movies)) {
    const movie = byPath.get(relPath);
    if (!movie || record.done) continue;
    if ((Number(record.position) || 0) < RESUME_FLOOR_SECONDS) continue;
    rows.push({
      kind: 'movie',
      id: relPath,
      name: movie.name,
      movie,
      position: Number(record.position) || 0,
      at: Number(record.at) || 0,
    });
  }

  rows.sort((a, b) => b.at - a.at);
  return rows.slice(0, limit);
}

module.exports = {
  DONE_FRACTION,
  RESUME_FLOOR_SECONDS,
  emptyLibrary,
  libraryOf,
  seedFromCursors,
  markEpisode,
  markMovie,
  forgetAll,
  resumePoint,
  movieResumePoint,
  episodeStatus,
  episodeFraction,
  watchedCount,
  continueWatching,
};
