'use strict';

/**
 * Locks: "do not play this until that has played."
 *
 * Some films are sequels, and some are continuations of a series — playing them
 * out of order spoils them. A lock names ONE prerequisite per item, which is
 * enough for a trilogy because locks chain: C waits on B, B waits on A.
 *
 * Two pieces of state, deliberately kept apart:
 *
 *   settings.locks   what the viewer asked for. Edited in the table, and never
 *                    changed by playback.
 *   state.unlocked   what has been EARNED. Written once, when a prerequisite is
 *                    first satisfied, and never expires on its own.
 *
 * Keeping them apart is what makes an unlock permanent. Evaluating the rule
 * live instead would re-lock a sequel the moment its prerequisite looped back
 * to episode one, which for a channel that loops by default means the sequel
 * would flicker in and out of the rotation forever.
 *
 * Pure module — no filesystem, no Electron.
 */

const SHOW = 'show';
const MOVIE = 'movie';

const showKey = (showId) => `${SHOW}:${showId}`;
const movieKey = (relPath) => `${MOVIE}:${relPath}`;

function parseKey(key) {
  const text = String(key || '');
  const cut = text.indexOf(':');
  if (cut === -1) return null;
  const type = text.slice(0, cut);
  const id = text.slice(cut + 1);
  if ((type !== SHOW && type !== MOVIE) || !id) return null;
  return { type, id };
}

/** Everything that can be locked or be a prerequisite, in one list. */
function lockableItems(shows, movies) {
  return [
    ...(shows || []).map((show) => ({
      key: showKey(show.id),
      type: SHOW,
      name: show.name,
      episodes: show.episodes || [],
    })),
    ...(movies || []).map((movie) => ({
      key: movieKey(movie.relPath),
      type: MOVIE,
      name: movie.name,
      year: movie.year || null,
      episodes: [],
    })),
  ];
}

/**
 * Has this prerequisite played?
 *
 * A whole show counts as played once its counter REACHES the last episode —
 * the number in the library row — rather than once every episode has been
 * watched individually. Skipping one episode should not keep a sequel locked
 * for good.
 */
function prerequisiteMet(lock, context) {
  if (!lock || !lock.after) return true;
  const target = parseKey(lock.after);
  if (!target) return true;

  if (target.type === MOVIE) {
    return Boolean((context.moviesPlayed || {})[target.id]);
  }

  const show = (context.shows || []).find((s) => s.id === target.id);
  // A prerequisite whose show is not in this scan cannot be judged. Treated as
  // unmet: silently unlocking because a drive was slow would play the sequel
  // first, which is the one outcome this feature exists to prevent.
  if (!show || !show.episodes || show.episodes.length === 0) return false;

  const cursor = (context.cursors || {})[target.id];
  const index = cursor && Number.isInteger(cursor.index) ? cursor.index : 0;

  if (lock.wholeShow !== false) return index >= show.episodes.length;

  const wanted = Number.isInteger(lock.episodeIndex) ? lock.episodeIndex : 0;
  return index > wanted;
}

/** The context prerequisiteMet needs, gathered from a state in one place. */
function contextFor(state, shows) {
  return {
    shows: shows || [],
    cursors: (state && state.cursors) || {},
    moviesPlayed: (state && state.moviesPlayed) || {},
  };
}

/**
 * Record every lock whose prerequisite is now satisfied.
 *
 * Called after anything that moves progress. Returns the SAME state object when
 * nothing changed, so callers can skip a save.
 */
function earnUnlocks(state, shows, options = {}) {
  const locks = ((state.settings || {}).locks) || {};
  const keys = Object.keys(locks);
  if (keys.length === 0) return state;

  const context = contextFor(state, shows);
  const unlocked = { ...(state.unlocked || {}) };
  let changed = false;

  for (const key of keys) {
    if (unlocked[key]) continue;
    if (!prerequisiteMet(locks[key], context)) continue;
    unlocked[key] = options.now || Date.now();
    changed = true;
  }

  return changed ? { ...state, unlocked } : state;
}

/**
 * Is this item currently held back?
 *
 * Reads only what has been EARNED, never the live rule — see the note at the
 * top. earnUnlocks is what turns a satisfied rule into an unlock.
 */
function isLocked(key, state) {
  const lock = (((state.settings || {}).locks) || {})[key];
  if (!lock || !lock.after) return false;
  return !((state.unlocked || {})[key]);
}

/** Every locked show id, as a Set — the shape refillQueue wants. */
function lockedShowIds(state) {
  const locks = ((state.settings || {}).locks) || {};
  const out = new Set();
  for (const key of Object.keys(locks)) {
    const parsed = parseKey(key);
    if (parsed && parsed.type === SHOW && isLocked(key, state)) out.add(parsed.id);
  }
  return out;
}

/** Movies that may be dealt right now. */
function unlockedMovies(movies, state) {
  return (movies || []).filter((movie) => !isLocked(movieKey(movie.relPath), state));
}

/**
 * The one episode-label formatter.
 *
 * It lives HERE, in the leaf module, because scheduler.js requires locks.js —
 * this is the only direction without a cycle; scheduler re-exports it for its
 * own callers. It replaced a stripped-down local copy that had quietly
 * diverged: the play-order table rendered "S1994E512" for dated episodes and
 * "S00E07" for bare-numbered ones while every other surface said "1994-05-12"
 * and "Ep 7". Two formatters for one concept always end up disagreeing in
 * front of the viewer.
 */
function formatEpisodeLabel(episode) {
  if (!episode) return '';
  if (episode.dated && episode.season) {
    const mmdd = String(episode.episode).padStart(4, '0');
    return `${episode.season}-${mmdd.slice(0, 2)}-${mmdd.slice(2)}`;
  }
  if (episode.season !== null && episode.season !== undefined && episode.episode !== null) {
    const s = String(episode.season).padStart(2, '0');
    const e = String(episode.episode).padStart(2, '0');
    const base = `S${s}E${e}`;
    if (episode.episodeEnd && episode.episodeEnd !== episode.episode) {
      return `${base}-E${String(episode.episodeEnd).padStart(2, '0')}`;
    }
    return base;
  }
  if (episode.episode !== null && episode.episode !== undefined) {
    return `Ep ${episode.episode}`;
  }
  return episode.fileName;
}

/** What an item is waiting for, in words, or null when it is free. */
function lockLabel(key, state, shows, movies) {
  if (!isLocked(key, state)) return null;
  const lock = (((state.settings || {}).locks) || {})[key];
  const target = parseKey(lock.after);
  if (!target) return null;

  if (target.type === MOVIE) {
    const movie = (movies || []).find((m) => m.relPath === target.id);
    return movie ? movie.name : 'a movie that is no longer in the library';
  }

  const show = (shows || []).find((s) => s.id === target.id);
  if (!show) return 'a show that is no longer in the library';
  if (lock.wholeShow !== false) return `all of ${show.name}`;

  const episode = (show.episodes || [])[lock.episodeIndex];
  return episode
    ? `${show.name} ${formatEpisodeLabel(episode)}`
    : `${show.name} episode ${(Number(lock.episodeIndex) || 0) + 1}`;
}

/**
 * Would pointing `key` at `after` create a loop?
 *
 * A → B → A can never unlock: both sides wait for the other forever, and the
 * two items simply vanish from the channel with no explanation. Cheaper to
 * refuse the edit than to explain the deadlock later.
 */
function wouldCycle(locks, key, after) {
  if (!after) return false;
  if (after === key) return true;

  const seen = new Set([key]);
  let at = after;
  while (at) {
    if (seen.has(at)) return true;
    seen.add(at);
    const next = (locks || {})[at];
    at = next && next.after ? next.after : null;
  }
  return false;
}

/** Set or clear one lock, refusing anything that would deadlock. */
function setLock(settings, key, lock) {
  const locks = { ...((settings || {}).locks || {}) };

  if (!lock || !lock.after) {
    delete locks[key];
    return { ...settings, locks };
  }
  if (wouldCycle(locks, key, lock.after)) return settings;

  locks[key] = {
    after: lock.after,
    wholeShow: lock.wholeShow !== false,
    episodeIndex: Number.isInteger(lock.episodeIndex) ? lock.episodeIndex : null,
  };
  return { ...settings, locks };
}

/** Forget every earned unlock, so all locks apply again from now. */
function resetUnlocks(state) {
  return { ...state, unlocked: {} };
}

/** Note that a movie has played, which is what a movie prerequisite reads. */
function recordMoviePlayed(state, relPath, options = {}) {
  if (!relPath) return state;
  return {
    ...state,
    moviesPlayed: { ...(state.moviesPlayed || {}), [relPath]: options.now || Date.now() },
  };
}

module.exports = {
  SHOW,
  MOVIE,
  showKey,
  movieKey,
  parseKey,
  lockableItems,
  prerequisiteMet,
  earnUnlocks,
  isLocked,
  lockedShowIds,
  unlockedMovies,
  lockLabel,
  formatEpisodeLabel,
  wouldCycle,
  setLock,
  resetUnlocks,
  recordMoviePlayed,
};
