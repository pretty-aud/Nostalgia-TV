'use strict';

/**
 * The channel scheduler.
 *
 * Two rules define the whole product:
 *   1. Shows appear in a randomised order.
 *   2. Within a show, episodes only ever advance in broadcast order.
 *
 * The implementation is a "deck shuffle": every show goes into a deck, the deck
 * is shuffled, and we deal from it until it is empty before shuffling a fresh
 * one. Compared with rolling a die at each transition this guarantees that no
 * show comes back around until every other show has had a turn — which is what
 * makes it feel like a channel rather than a broken jukebox.
 *
 * The queue is COMMITTED and persisted, not recomputed on the fly. That is what
 * lets the "up next" bumper be truthful: it reads the same queue the player
 * consumes, so what it promises is what actually plays.
 *
 * Pure module — no filesystem, no Electron. `rng` is injectable so tests are
 * deterministic.
 */

const { lockedShowIds, unlockedMovies, recordMoviePlayed } = require('./locks.js');

const DEFAULT_SETTINGS = {
  /**
   * Blocks is the default: a couple of episodes of one show, then a change.
   *
   * It is also what anything falling back to defaults lands on. That matters
   * more than it looks — 'deck' deals a single episode per show, which from
   * the sofa is indistinguishable from "it randomly went back to shuffle", so
   * a default of deck turns any settings hiccup into that exact complaint.
   */
  mode: 'blocks',          // 'deck' | 'blocks' | 'random'
  blockSize: 2,            // consecutive episodes per turn when mode === 'blocks'
  bumperSeconds: 8,
  bumperEnabled: true,
  loopWhenExhausted: true, // a channel should not die when a show runs out
  disabledShows: [],       // show ids the user has switched off
  marathonShowId: null,    // when set, ONLY this show plays (see isEnabled)
  /**
   * Saved set schedules — a fixed running order, as opposed to a shuffle.
   *
   * Each entry is { id, name, blockSize, items: [showId, ...] }. `items` is
   * ORDERED and may repeat a show deliberately: putting the same card in twice
   * is how you give a show two blocks in one rotation.
   *
   * Kept in settings rather than at the top of state because activating one
   * reshapes the queue exactly the way `mode` does, and applySettings already
   * knows how to handle that.
   */
  schedules: [],
  activeScheduleId: null,   // when set, the running order is fixed, not shuffled

  /**
   * Per-show playback preferences, keyed by show id.
   * { [showId]: { audio: 'jpn'|'spa'|null, subs: 'eng'|'spa'|null } }
   *
   * Audio changes which track the preparer selects; subtitles auto-enable the
   * matching text track. Neither reshapes the queue, so this key is
   * deliberately NOT in applySettings' reshape list.
   */
  showPrefs: {},

  bumperClipsEnabled: true, // play a clip from the BUMPERS folder between episodes
  promosEnabled: true,      // play a clip from the PROMOS folder after the bumper
  promoEvery: 1,            // gap in episodes: 1 = between every episode
  /**
   * Put promos on the SEAM between shows instead of counting episodes.
   *
   * Overrides promoEvery when set. One rule that follows whichever rotation is
   * selected: the end of a block in blocks mode, every change of show in deck
   * or random mode.
   */
  promoBetweenShows: false,

  /**
   * "Do not play this until that has played" — see src/shared/locks.js.
   * Keyed `show:<id>` / `movie:<relPath>`; what has been EARNED lives on the
   * state as `unlocked`, not here, so an unlock survives a show looping.
   */
  locks: {},

  /**
   * Movies run on a CLOCK, not on the episode counter.
   *
   * "Every three hours" has to mean three hours of wall time; counting
   * episodes would drift with their length and with how long the app was
   * closed. 0 means never.
   */
  /**
   * On/off is its own setting rather than a "never" entry in the interval
   * list. Switching movies off and back on should not make you re-pick how
   * often you wanted them — the two are different questions.
   */
  moviesEnabled: true,
  movieEvery: 24,           // hours between movies
  moviePresentationEnabled: true,
  /**
   * There is deliberately no fit/fill or global zoom setting.
   *
   * The picture is always scaled to the largest size that fits the window with
   * its shape intact, and whatever is left over is black — 4:3 gets bars at the
   * sides, a taller frame gets them top and bottom, and both re-compute on
   * resize. That is what every other player does, it never hides part of the
   * frame, and having it as an option only invited getting it wrong.
   */
  /**
   * Crop black bars that are baked INTO the picture.
   *
   * Distinct from the framing above, which is settled. Some releases encode 4:3
   * inside a 16:9 frame with the pillarbox burnt in — object-fit cannot see
   * those as bars, so a correctly-fitted frame still shows them. Detected with
   * ffmpeg and scaled off the edge.
   */
  /**
   * Sound. Kept in settings rather than on the element so it survives a
   * restart — a channel that comes back at full volume every launch is a
   * genuinely unpleasant surprise.
   */
  volume: 100,
  muted: false,

  /**
   * Interface theme. Every one is the same token set with different values, so
   * a theme can never restyle a component — see the themes block in styles.css.
   */
  theme: 'midnight',   // one of THEMES in the renderer; anything else falls back

  autoCrop: true,
  interstitialZoom: 100,    // scale % for bumpers/promos ONLY, to crop baked-in bars
  uiScale: 100,             // scale % for player text and controls

  /**
   * How subtitles are drawn. Lives in settings so it persists and follows the
   * viewer, rather than being a per-episode choice — legibility is a property
   * of the room and the screen, not of the programme.
   */
  subtitles: {
    color: '#ffffff',
    font: 'sans',            // 'sans' | 'mono' | 'serif'
    size: 100,               // percent of the player's default cue size
    background: true,
    backgroundOpacity: 75,   // percent, ignored when background is off
    position: 'bottom',      // 'top' | 'middle' | 'bottom'
  },
};

const QUEUE_TARGET = 12; // deep enough for the bumper's lookahead plus slack

function createState(rootPath) {
  return {
    version: 1,
    rootPath: rootPath || null,
    cursors: {},   // showId -> { index, lastRelPath }
    queue: [],     // committed upcoming items
    deck: [],      // show ids left to deal in the current round (see refillQueue)
    history: [],   // most recent first
    resume: null,  // { relPath, position } for mid-episode resume
    bumperDeck: [],           // clip paths left to deal this round (see nextBumper)
    lastBumperRelPath: null,  // guards the deck boundary against a repeat
    promoDeck: [],            // same, for the PROMOS folder
    lastPromoRelPath: null,
    movieDeck: [],            // same, for the MOVIES folder
    lastMovieRelPath: null,
    lastMovieAt: null,        // ms timestamp of the last movie that played
    /**
     * The movie is DEALT well before it plays, not at the transition.
     *
     * Three things need it decided early: the sidebar schedule can only show
     * what has been chosen, a feature-length file needs a real head start to
     * convert, and a movie appearing with no warning is a surprise rather than
     * an event. `movieLeadBlocks` counts the block boundaries still to pass.
     */
    pendingMovie: null,
    movieLeadBlocks: 0,
    /**
     * Locks, earned side. `unlocked` is written once when a prerequisite is
     * first satisfied and never expires; `moviesPlayed` is what a movie
     * prerequisite reads, since the decks only remember the LAST one dealt.
     */
    unlocked: {},
    moviesPlayed: {},
    episodesSincePromo: 0,    // drives promoEvery
    /**
     * Library mode's own watch record, kept apart from the cursors above on
     * purpose — see src/shared/browse.js. Declared here so a state loaded from
     * an older save gets the shape rather than undefined, since the renderer
     * hydrates with { ...createState(), ...saved }.
     */
    library: { shows: {}, movies: {}, seeded: false },
    settings: { ...DEFAULT_SETTINGS },
  };
}

/** Fisher-Yates, using the injected rng so tests can pin the order. */
function shuffle(items, rng) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Re-anchor saved progress against a freshly scanned library.
 *
 * Cursors are stored as an index PLUS the path of the last episode played. If
 * the library gains or loses a file, the index alone would silently point at
 * the wrong episode, so the path wins whenever it still resolves.
 *
 * 🚨 Starts from the EXISTING cursors rather than an empty object. Rebuilding
 * from scratch keeps only the shows in the current scan — and "missing from
 * this scan" is very often "not readable at this instant" rather than "gone":
 * the scanner skips folders it cannot read, so a drive still spinning up, a
 * sleeping network share or a momentarily locked folder silently drops those
 * shows. Since loadLibrary persists straight afterwards, that wiped real
 * progress permanently. A stale cursor for a show that never returns costs a
 * few bytes; a deleted one costs someone their place in a series.
 */
function reconcileCursors(shows, state) {
  const cursors = { ...(state.cursors || {}) };

  /**
   * History is a SECOND record of the same truth, and it survives things the
   * cursor does not.
   *
   * A cursor can end up at zero with no anchor — that is what an earlier bug
   * here wrote whenever a show went missing from one scan. History still holds
   * what actually played, with the file path, so it can put the show back where
   * it belongs instead of restarting a series someone is part-way through.
   * Most recent first, so the first entry per show is the latest.
   */
  const lastPlayed = new Map();
  for (const entry of state.history || []) {
    if (entry && entry.showId && !lastPlayed.has(entry.showId)) lastPlayed.set(entry.showId, entry);
  }

  for (const show of shows) {
    const saved = state.cursors ? state.cursors[show.id] : null;
    const played = lastPlayed.get(show.id);

    // Prefer the cursor's own anchor; fall back to the last thing history saw.
    const anchor = (saved && saved.lastRelPath) || (played && played.relPath) || null;

    let index = saved && Number.isInteger(saved.index) ? saved.index : 0;
    if ((!saved || !saved.lastRelPath) && played && Number.isInteger(played.episodeIndex)) {
      index = played.episodeIndex + 1;
    }

    // The path wins whenever it still resolves: an index alone silently points
    // at the wrong episode as soon as the library gains or loses a file.
    if (anchor) {
      const found = show.episodes.findIndex((ep) => ep.relPath === anchor);
      if (found !== -1) index = found + 1; // resume AFTER the last one played
    }

    cursors[show.id] = {
      index: Math.max(0, Math.min(index, show.episodes.length)),
      lastRelPath: anchor,
    };
  }
  return cursors;
}

/** Drop queue entries that no longer resolve to a real file after a rescan. */
function pruneQueue(shows, queue) {
  const byId = new Map(shows.map((s) => [s.id, s]));
  return (queue || []).filter((item) => {
    const show = byId.get(item.showId);
    if (!show) return false;
    const ep = show.episodes[item.episodeIndex];
    return Boolean(ep) && ep.relPath === item.relPath;
  });
}

/**
 * Marathon mode deliberately OVERRIDES the disabled list rather than
 * intersecting with it: explicitly choosing a show to marathon is a stronger
 * statement than having switched it off at some point in the past, and an empty
 * channel would be the only other outcome.
 *
 * Putting it here rather than at each call site means every rotation mode, the
 * deck, the queue and the bumper all inherit it from one place.
 */
function isEnabled(show, settings, lockedIds) {
  // Marathon is checked FIRST, which is also what makes it an override: asking
  // for one show by name is an explicit instruction, and a lock is a default.
  if (settings.marathonShowId) return show.id === settings.marathonShowId;

  /**
   * A set schedule is the same kind of statement, so it overrides the same
   * things. Naming a show in a schedule you built by hand outranks having
   * switched it off at some point, and outranks a lock — which is a default
   * for a rotation nobody has specified, not a veto over one you have.
   *
   * It also NARROWS: under a schedule the only shows that play are the ones on
   * it, so a show left out is out whether or not it is switched on.
   */
  const schedule = activeSchedule(settings);
  if (schedule) return (schedule.items || []).includes(show.id);

  if (lockedIds && lockedIds.has(show.id)) return false;
  return !(settings.disabledShows || []).includes(show.id);
}

/**
 * The schedule currently selected, or null.
 *
 * Resolves the id every time rather than caching a reference, and returns null
 * for an id that no longer matches anything — deleting the active schedule
 * must fall back to shuffling rather than emptying the channel.
 */
function activeSchedule(settings) {
  const id = settings && settings.activeScheduleId;
  if (!id) return null;
  const found = (settings.schedules || []).find((s) => s && s.id === id);
  return found || null;
}

/** Episodes per block for whichever running order is in force. */
function blockSizeFor(settings) {
  const schedule = activeSchedule(settings);
  const raw = schedule ? schedule.blockSize : settings.blockSize;
  return Math.max(1, Number(raw) || 1);
}

/**
 * Grow `state.queue` until it holds at least `target` items.
 *
 * Returns { queue, deck } — both NEW arrays; does not mutate state.
 *
 * The deck has to be carried in state and handed back. Rebuilding it on every
 * call looks harmless but quietly destroys the whole guarantee: the queue is
 * topped up one item at a time, so each new item would be the first card of a
 * fresh shuffle — i.e. pure random, with shows clumping and starving exactly
 * like the naive approach this design exists to avoid.
 *
 * Cursors are tracked virtually while building, because the queue commits
 * episodes that have not been played yet — reading the real cursor here would
 * deal the same episode over and over.
 */
function refillQueue(shows, state, options = {}) {
  const rng = options.rng || Math.random;
  const target = options.target || QUEUE_TARGET;
  const settings = { ...DEFAULT_SETTINGS, ...(state.settings || {}) };

  const byId = new Map(shows.map((s) => [s.id, s]));
  const queue = [...(state.queue || [])];
  let deck = [...(state.deck || [])].filter((id) => byId.has(id));

  // Virtual cursor: real progress, advanced past anything already queued.
  const cursor = {};
  for (const show of shows) {
    const saved = (state.cursors || {})[show.id];
    cursor[show.id] = saved && Number.isInteger(saved.index) ? saved.index : 0;
  }
  // Last write wins rather than max(): when a show loops back to episode one the
  // queue reads ...10, 11, 0, 1, and max() would freeze the cursor at 12 and
  // re-deal episode 0 a second time.
  for (const item of queue) {
    if (cursor[item.showId] !== undefined) {
      cursor[item.showId] = item.episodeIndex + 1;
    }
  }

  // Computed here rather than passed in: refillQueue is reached from a dozen
  // places, and a lock that depends on every caller remembering to hand it over
  // is a lock that silently stops working the first time one of them forgets.
  const lockedIds = lockedShowIds(state);

  /**
   * Resolved once: a set schedule replaces the shuffled deck, overrides the
   * rotation mode, and supplies its own block size.
   *
   * A marathon suppresses it outright rather than layering on top. Without
   * this the deck refills from the schedule's shows, isEnabled rejects every
   * one of them because a marathon admits only its own show, the deck comes
   * back empty and the channel deals NOTHING — a marathon started while a
   * schedule happened to be selected would simply stop dead.
   */
  const schedule = settings.marathonShowId ? null : activeSchedule(settings);

  const hasEpisodesLeft = (show) => {
    if (!isEnabled(show, settings, lockedIds)) return false;
    if (show.episodes.length === 0) return false;
    if (cursor[show.id] < show.episodes.length) return true;
    return Boolean(settings.loopWhenExhausted);
  };

  const lastQueuedShow = () => (
    queue.length ? queue[queue.length - 1].showId : (state.history?.[0]?.showId ?? null)
  );

  /** Take the next chronological episode for a show, wrapping if allowed. */
  const dealFrom = (show) => {
    if (cursor[show.id] >= show.episodes.length) {
      if (!settings.loopWhenExhausted) return null;
      cursor[show.id] = 0;
    }
    const episode = show.episodes[cursor[show.id]];
    if (!episode) return null;
    const item = {
      showId: show.id,
      showName: show.name,
      episodeIndex: cursor[show.id],
      relPath: episode.relPath,
    };
    cursor[show.id] += 1;
    return item;
  };

  let guard = 0;
  const guardLimit = target * 50 + 500;

  while (queue.length < target) {
    guard += 1;
    if (guard > guardLimit) break; // belt and braces against a pathological library

    // A set schedule outranks the rotation mode entirely: it IS the order, so
    // 'random' must not get to deal over the top of it.
    if (settings.mode === 'random' && !schedule) {
      const eligible = shows.filter(hasEpisodesLeft);
      if (eligible.length === 0) break;
      // Avoid a back-to-back repeat unless there is genuinely nothing else.
      const last = lastQueuedShow();
      const pool = eligible.length > 1 ? eligible.filter((s) => s.id !== last) : eligible;
      const picked = pool[Math.floor(rng() * pool.length)];
      const item = dealFrom(picked);
      if (item) queue.push(item); else break;
      continue;
    }

    if (deck.length === 0) {
      if (schedule) {
        /**
         * The schedule IS the deck, in its own order, and refilling here is
         * what makes it loop: run off the end and the next pass deals the same
         * order again, each show picking up where it left off.
         *
         * Deliberately NOT shuffled and deliberately NOT head-swapped. Two of
         * the same show back to back is an instruction in a hand-built
         * schedule, not the clumping the shuffle exists to break up.
         */
        deck = (schedule.items || []).filter((id) => {
          const show = byId.get(id);
          return show && hasEpisodesLeft(show);
        });
        // Every show on the schedule is gone or exhausted; nothing left to deal.
        if (deck.length === 0) break;
      } else {
        const eligible = shows.filter(hasEpisodesLeft);
        if (eligible.length === 0) break;
        deck = shuffle(eligible.map((s) => s.id), rng);

        // Across a deck boundary the same show could land twice in a row. Swap
        // the head with a random other entry so the channel never stutters.
        const last = lastQueuedShow();
        if (deck.length > 1 && deck[0] === last) {
          const swapWith = 1 + Math.floor(rng() * (deck.length - 1));
          [deck[0], deck[swapWith]] = [deck[swapWith], deck[0]];
        }
      }
    }

    const show = byId.get(deck.shift());
    if (!show || !hasEpisodesLeft(show)) continue;

    /**
     * A schedule always runs in blocks — a card on the column is a block, and
     * its size comes from the schedule rather than the global setting, so two
     * saved schedules can run two different block lengths.
     */
    const take = schedule
      ? blockSizeFor(settings)
      : (settings.mode === 'blocks' ? Math.max(1, settings.blockSize) : 1);
    for (let i = 0; i < take; i += 1) {
      const item = dealFrom(show);
      if (!item) break;
      queue.push(item);
      if (cursor[show.id] >= show.episodes.length && !settings.loopWhenExhausted) break;
    }
  }

  return { queue, deck };
}

/**
 * Look at what is coming without consuming it. Item 0 is what plays next.
 * Each entry is decorated with display fields for the bumper.
 */
function peek(shows, state, count = 3) {
  const byId = new Map(shows.map((s) => [s.id, s]));
  return (state.queue || []).slice(0, count).map((item) => {
    const show = byId.get(item.showId);
    const episode = show ? show.episodes[item.episodeIndex] : null;
    return decorate(item, show, episode);
  }).filter((entry) => entry.episode);
}

/** Attach the fields the UI renders, so the renderer never re-derives labels. */
function decorate(item, show, episode) {
  if (!show || !episode) return { ...item, show: null, episode: null };
  return {
    ...item,
    show,
    episode,
    showName: show.name,
    title: episode.title || '',
    label: formatEpisodeLabel(episode),
    absPath: episode.absPath,
  };
}

/** "S02E04", or "Ep 4", or the filename when we could not parse anything. */
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

/**
 * Pop the head of the queue and commit it as played.
 *
 * Returns { state, item } with a new state object. The cursor is advanced to
 * the episode AFTER the one dealt, recorded by path so a rescan can re-anchor.
 */
function advance(shows, state, options = {}) {
  const rng = options.rng || Math.random;
  const next = { ...state, queue: [...(state.queue || [])], deck: [...(state.deck || [])] };

  if (next.queue.length === 0) {
    const filled = refillQueue(shows, next, { rng });
    next.queue = filled.queue;
    next.deck = filled.deck;
  }
  const item = next.queue.shift();
  if (!item) return { state: next, item: null };

  const byId = new Map(shows.map((s) => [s.id, s]));
  const show = byId.get(item.showId);
  const episode = show ? show.episodes[item.episodeIndex] : null;

  next.cursors = { ...(next.cursors || {}) };
  next.cursors[item.showId] = {
    index: item.episodeIndex + 1,
    lastRelPath: item.relPath,
  };

  // `at` is what makes a progress complaint answerable. Without it the history
  // is an ordered list with no dates, so "it was showing an older episode when
  // I logged on" cannot be checked against anything — there is no way to tell a
  // save that never happened from one that happened and was later overwritten.
  next.history = [
    {
      showId: item.showId,
      episodeIndex: item.episodeIndex,
      relPath: item.relPath,
      at: options.now || Date.now(),
    },
    ...(next.history || []),
  ].slice(0, 100);

  const refilled = refillQueue(shows, next, { rng });
  next.queue = refilled.queue;
  next.deck = refilled.deck;
  next.resume = null;

  return { state: next, item: decorate(item, show, episode) };
}

/**
 * Push a specific episode to the front of the queue without disturbing the
 * committed order behind it — used by "play this now" in the library panel.
 */
function playNow(shows, state, showIdValue, episodeIndex) {
  const byId = new Map(shows.map((s) => [s.id, s]));
  const show = byId.get(showIdValue);
  if (!show) return state;
  const episode = show.episodes[episodeIndex];
  if (!episode) return state;
  return {
    ...state,
    queue: [
      { showId: show.id, showName: show.name, episodeIndex, relPath: episode.relPath },
      ...(state.queue || []),
    ],
  };
}

/**
 * Deal the next interstitial clip.
 *
 * Same deck shuffle as the shows, and for the same reason: rolling a die each
 * time would repeat clips back to back and leave others unseen for hours. A
 * deck plays every clip once, in a fresh random order each round — which is
 * what "shuffled, never the same order" actually has to mean once you have more
 * than a handful of them.
 *
 * Returns { state, bumper }. `bumper` is null when there are no clips, so the
 * caller can carry straight on to the next episode.
 */
function dealInterstitial(clips, savedDeck, lastRelPath, rng) {
  const known = new Set(clips.map((clip) => clip.relPath));
  // Filter first: a clip deleted since the deck was dealt would otherwise be
  // handed to the player as a missing file.
  let deck = [...(savedDeck || [])].filter((relPath) => known.has(relPath));

  if (deck.length === 0) {
    deck = shuffle(clips.map((clip) => clip.relPath), rng);
    // Across a deck boundary the same clip could land twice in a row — the one
    // repeat a shuffle is supposed to rule out, and the most noticeable one.
    if (deck.length > 1 && deck[0] === lastRelPath) {
      const swapWith = 1 + Math.floor(rng() * (deck.length - 1));
      [deck[0], deck[swapWith]] = [deck[swapWith], deck[0]];
    }
  }

  const relPath = deck.shift();
  return { relPath, clip: clips.find((c) => c.relPath === relPath) || null, deck };
}

function nextBumper(bumpers, state, options = {}) {
  const rng = options.rng || Math.random;
  const clips = bumpers || [];
  if (clips.length === 0) return { state, bumper: null };

  const dealt = dealInterstitial(clips, state.bumperDeck, state.lastBumperRelPath, rng);
  return {
    state: { ...state, bumperDeck: dealt.deck, lastBumperRelPath: dealt.relPath },
    bumper: dealt.clip,
  };
}

/**
 * Deal the next promo — the longer interstitial that runs after the bumper.
 *
 * Its own deck, so promos and bumpers never fall into step with each other and
 * start arriving as the same pair every time.
 */
/**
 * Is a movie due?
 *
 * `now` is injected so this is testable without waiting three hours.
 *
 * A null `lastMovieAt` means one is due immediately. Starting the clock
 * silently instead would leave someone who has just switched the feature on
 * with no way to tell whether it works short of waiting out the interval.
 */
function shouldPlayMovie(state, movies, options = {}) {
  const now = options.now || Date.now();
  const settings = { ...DEFAULT_SETTINGS, ...(state.settings || {}) };
  if (!settings.moviesEnabled) return false;
  const hours = Number(settings.movieEvery) || 0;
  if (hours <= 0) return false;
  if (!movies || movies.length === 0) return false;
  if (!state.lastMovieAt) return true;
  return now - Number(state.lastMovieAt) >= hours * 3600 * 1000;
}

/** Deal the next movie, on its own deck so none repeats until all have run. */
function nextMovie(movies, state, options = {}) {
  const rng = options.rng || Math.random;
  const clips = movies || [];
  if (clips.length === 0) return { state, movie: null };

  const dealt = dealInterstitial(clips, state.movieDeck, state.lastMovieRelPath, rng);
  return {
    state: { ...state, movieDeck: dealt.deck, lastMovieRelPath: dealt.relPath },
    movie: dealt.clip,
  };
}

/** Restart the clock. Called when a movie actually STARTS, not when it is due. */
function markMoviePlayed(state, options = {}) {
  // Recorded by path, because that is what a movie prerequisite waits on. The
  // decks only remember the LAST clip dealt, which cannot answer "has this one
  // ever played" — the question a sequel's lock actually asks.
  const played = state.pendingMovie
    ? recordMoviePlayed(state, state.pendingMovie.relPath, options)
    : state;

  return {
    ...played,
    lastMovieAt: options.now || Date.now(),
    pendingMovie: null,
    movieLeadBlocks: 0,
  };
}

/** How many blocks of warning a movie gets. Kept here so tests can pin it. */
const MOVIE_LEAD_MIN = 1;
const MOVIE_LEAD_MAX = 3;

/**
 * Choose the next movie NOW and put it a few blocks out.
 *
 * Announcing it early is the whole point. A feature-length file is the longest
 * conversion this app ever does, so it needs a real head start rather than the
 * few seconds an up-next card provides; the sidebar can only list something
 * that has actually been chosen; and a movie that arrives with no warning
 * reads as the channel misbehaving rather than as an event.
 *
 * The lead is counted in BLOCKS, not episodes, so it means the same thing in
 * every rotation — and it is only ever spent at a block boundary, so a movie
 * never cuts into the middle of a show's run.
 */
function scheduleMovie(movies, state, options = {}) {
  const rng = options.rng || Math.random;
  const settings = { ...DEFAULT_SETTINGS, ...(state.settings || {}) };
  if (!settings.moviesEnabled) return { state, movie: null };
  if (!movies || movies.length === 0) return { state, movie: null };
  if (state.pendingMovie) return { state, movie: state.pendingMovie };

  // Filtered before dealing, not after: a locked sequel that reached the front
  // of the deck would otherwise block the slot rather than be passed over.
  const eligible = unlockedMovies(movies, state);
  if (eligible.length === 0) return { state, movie: null };

  const dealt = nextMovie(eligible, state, { rng });
  if (!dealt.movie) return { state, movie: null };

  const span = MOVIE_LEAD_MAX - MOVIE_LEAD_MIN + 1;
  const lead = Number.isInteger(options.leadBlocks)
    ? options.leadBlocks
    : MOVIE_LEAD_MIN + Math.floor(rng() * span);

  return {
    state: { ...dealt.state, pendingMovie: dealt.movie, movieLeadBlocks: Math.max(1, lead) },
    movie: dealt.movie,
  };
}

/**
 * Spend one block of the pending movie's lead, at a real block boundary.
 *
 * A boundary is the seam where the show changes — the same seam the promo rule
 * uses. Inside a block the lead does not move, which is what stops a movie
 * landing between two episodes of the same show.
 */
function tickMovieLead(state, options = {}) {
  if (!state.pendingMovie) return state;
  const { finishedShowId, nextShowId } = options;
  const boundary = !nextShowId || finishedShowId !== nextShowId;
  if (!boundary) return state;
  return { ...state, movieLeadBlocks: Math.max(0, (Number(state.movieLeadBlocks) || 0) - 1) };
}

/** Has the pending movie's lead run out? */
function movieIsDue(state) {
  return Boolean(state.pendingMovie) && (Number(state.movieLeadBlocks) || 0) <= 0;
}

/** Drop a scheduled movie — the folder went away, or movies were switched off. */
function clearPendingMovie(state) {
  if (!state.pendingMovie) return state;
  return { ...state, pendingMovie: null, movieLeadBlocks: 0 };
}

function nextPromo(promos, state, options = {}) {
  const rng = options.rng || Math.random;
  const clips = promos || [];
  if (clips.length === 0) return { state, promo: null };

  const dealt = dealInterstitial(clips, state.promoDeck, state.lastPromoRelPath, rng);
  return {
    state: { ...state, promoDeck: dealt.deck, lastPromoRelPath: dealt.relPath },
    promo: dealt.clip,
  };
}

/**
 * Is a promo due?
 *
 * Two ways of asking, because they answer different questions.
 *
 * `promoEvery` is a gap in EPISODES: 1 means between every episode, 5 means
 * after every fifth. The counter is compared BEFORE it is reset, so the setting
 * reads the way it is written on the slider rather than being off by one.
 *
 * `promoBetweenShows` ignores the count and puts a promo on the SEAM between
 * one show and the next. That one rule covers every rotation without having to
 * know which is selected: in blocks mode consecutive episodes share a show, so
 * the seam is the end of the block; in deck or random mode the show changes
 * every turn, so the seam is every turn. It follows the rotation instead of
 * describing it.
 */
function shouldPlayPromo(state, promos, options = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...(state.settings || {}) };
  if (!settings.promosEnabled) return false;
  if (!promos || promos.length === 0) return false;

  if (settings.promoBetweenShows) {
    const { finishedShowId, nextShowId } = options;
    // Nothing queued after this one: the seam is here whatever comes next.
    if (!nextShowId) return true;
    return finishedShowId !== nextShowId;
  }

  const every = Math.max(1, Number(settings.promoEvery) || 1);
  return (Number(state.episodesSincePromo) || 0) + 1 >= every;
}

/**
 * Drop anything the locks now forbid, then top the queue back up.
 *
 * The queue is COMMITTED, and refillQueue only ever ADDS to it — so a show
 * locked after its episodes were already dealt would go on playing for several
 * turns. That reads exactly like the lock not working, which is worse than not
 * having one. Cursors are untouched: the show keeps its place for whenever it
 * is unlocked again.
 *
 * A marathon is left alone, because a marathon overrides locks by design.
 */
function applyLocksToQueue(shows, state, options = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...(state.settings || {}) };
  if (settings.marathonShowId) return state;

  const locked = lockedShowIds(state);
  const queue = (state.queue || []).filter((item) => !locked.has(item.showId));

  // A locked film that was already booked has to go too, or it plays anyway at
  // the end of its lead.
  const pending = state.pendingMovie
    && unlockedMovies([state.pendingMovie], state).length === 0
    ? null
    : state.pendingMovie;

  const next = {
    ...state,
    queue,
    pendingMovie: pending,
    movieLeadBlocks: pending ? state.movieLeadBlocks : 0,
  };
  const filled = refillQueue(shows, next, options);
  return { ...next, queue: filled.queue, deck: filled.deck };
}

/**
 * Deal a completely new running order.
 *
 * Order only: cursors are untouched, so every show keeps its own place in its
 * own run and nobody loses their spot in a series. The DECK is cleared as well
 * as the queue, which is what makes this a real reshuffle — refilling from a
 * half-dealt deck would reproduce most of the order it was meant to replace,
 * since the deck is exactly the shows that have not had their turn yet.
 */
function reshuffle(shows, state, options = {}) {
  const rng = options.rng || Math.random;
  const cleared = { ...state, queue: [], deck: [] };
  const filled = refillQueue(shows, cleared, { rng });
  return { ...cleared, queue: filled.queue, deck: filled.deck };
}

/** Record that an episode finished, and whether a promo ran after it. */
function countEpisodeForPromo(state, promoPlayed) {
  return {
    ...state,
    episodesSincePromo: promoPlayed ? 0 : (Number(state.episodesSincePromo) || 0) + 1,
  };
}

/**
 * Move one show's position by `delta` episodes, without playing anything.
 *
 * This is the "pass this one" control: a show sitting on an episode you do not
 * want moves on by itself, and the channel picks it up there next time round.
 *
 * The show's QUEUED entries have to be discarded, not just the cursor changed —
 * the queue is committed ahead, so leaving it alone would keep the old episode
 * scheduled and make the button look like it did nothing.
 */
function nudgeCursor(shows, state, showIdValue, delta, options = {}) {
  const rng = options.rng || Math.random;
  const show = shows.find((s) => s.id === showIdValue);
  if (!show || show.episodes.length === 0) return state;

  const count = show.episodes.length;
  const saved = (state.cursors || {})[showIdValue] || { index: 0 };
  // Wrap both ways, so stepping back from the pilot lands on the finale rather
  // than sticking at zero.
  const index = ((((saved.index || 0) + delta) % count) + count) % count;

  const next = { ...state, cursors: { ...(state.cursors || {}) } };
  next.cursors[showIdValue] = {
    index,
    // Recorded as the episode BEFORE the new position, because that is what
    // reconcileCursors re-anchors from after a rescan (it resumes at found + 1).
    lastRelPath: index > 0 ? show.episodes[index - 1].relPath : null,
  };

  next.queue = (state.queue || []).filter((item) => item.showId !== showIdValue);
  const refilled = refillQueue(shows, next, { rng });
  next.queue = refilled.queue;
  next.deck = refilled.deck;
  return next;
}

/**
 * Send a show — or the whole channel — back to episode one.
 *
 * History is only cleared on a full reset. Clearing it for a single show would
 * silently rewrite what the channel says it has already played, and `previous`
 * reads that history to step backwards.
 */
function resetProgress(shows, state, showIdValue = null, options = {}) {
  const rng = options.rng || Math.random;
  const next = { ...state, cursors: { ...(state.cursors || {}) } };
  const byId = new Map(shows.map((s) => [s.id, s]));

  if (showIdValue) {
    if (!byId.has(showIdValue)) return state;
    next.cursors[showIdValue] = { index: 0, lastRelPath: null };
    next.queue = (state.queue || []).filter((item) => item.showId !== showIdValue);

    // A saved mid-episode position inside the show we just rewound would drop
    // the viewer back into an episode the show no longer considers played.
    const show = byId.get(showIdValue);
    if (next.resume && show.episodes.some((ep) => ep.relPath === next.resume.relPath)) {
      next.resume = null;
    }
  } else {
    // Start empty rather than overwriting in place. reconcileCursors keeps
    // cursors for shows a scan did not find, and "reset everything" has to mean
    // everything — otherwise a show that reappears later brings back progress
    // the viewer explicitly cleared.
    next.cursors = {};
    for (const show of shows) next.cursors[show.id] = { index: 0, lastRelPath: null };
    next.queue = [];
    next.deck = [];
    next.history = [];
    next.resume = null;
  }

  const refilled = refillQueue(shows, next, { rng });
  next.queue = refilled.queue;
  next.deck = refilled.deck;
  return next;
}

/**
 * Step the channel back to the episode that played before this one.
 *
 * Pulls from history rather than decrementing a cursor, because the previous
 * episode belonged to a DIFFERENT show than the current one in every rotation
 * mode except marathon — a cursor walk would rewind the wrong show.
 */
function previous(shows, state) {
  const history = [...(state.history || [])];
  const last = history.shift();
  if (!last) return state;

  const show = shows.find((s) => s.id === last.showId);
  if (!show) return state;

  const next = { ...state, history, cursors: { ...(state.cursors || {}) } };
  next.queue = [
    {
      showId: last.showId,
      showName: show.name,
      episodeIndex: last.episodeIndex,
      relPath: last.relPath,
    },
    ...(state.queue || []),
  ];
  next.cursors[last.showId] = {
    index: last.episodeIndex,
    lastRelPath: last.episodeIndex > 0 ? show.episodes[last.episodeIndex - 1].relPath : null,
  };
  next.resume = null;
  return next;
}

/**
 * Skip the episode currently on screen.
 *
 * Three genuinely different intentions, which is why the caller has to say
 * which:
 *
 *   'episode' — "Just this one." The episode counts as done and the block
 *               carries on, so the next episode of the SAME show follows. Used
 *               for a broken file or an episode you have already seen.
 *   'count'   — "I am done with this show for now." It stays advanced past the
 *               episode and the rest of its block is dropped, so the channel
 *               moves on to something else.
 *   'block'   — "Not now." The show goes back to this episode, so the whole
 *               block returns later, in order, as if unwatched.
 *
 * 'count' and 'block' both drop the rest of the block: skipping one episode
 * only to have the next of the same show start immediately is not what those
 * mean. Episodes further back in the queue belong to a later turn and are left
 * alone. `countIt` is still accepted for callers written before 'episode'
 * existed.
 */
function skipCurrent(shows, state, playing, options = {}) {
  const rng = options.rng || Math.random;
  if (!playing || !playing.showId) return { state, dropped: 0 };
  const show = shows.find((s) => s.id === playing.showId);
  if (!show) return { state, dropped: 0 };

  const mode = options.mode || (options.countIt ? 'count' : 'block');

  // Just this episode: advance() already moved the cursor past it and recorded
  // it, which IS the progress being asked for, and the queue in front of us is
  // the rest of the block that should still play. So there is nothing to undo
  // and nothing to drop — the caller simply moves to the next item.
  if (mode === 'episode') return { state, dropped: 0 };

  const next = { ...state, cursors: { ...(state.cursors || {}) } };
  const countIt = mode === 'count';

  let queue = [...(state.queue || [])];
  let dropped = 0;
  while (queue.length > 0 && queue[0].showId === playing.showId) {
    queue.shift();
    dropped += 1;
  }

  if (!countIt) {
    // Everything else this show has queued goes too, not just the block in
    // front. Those entries are for LATER episodes, and leaving them would pin
    // the refill's cursor past the one being skipped — stranding it behind its
    // own future, so "play it later" would quietly mean never.
    queue = queue.filter((item) => item.showId !== playing.showId);
  }
  next.queue = queue;

  if (!countIt) {
    // Put the show back to the episode that was skipped. advance() moved the
    // cursor past it the moment it started playing, so this is what makes
    // "play it later" actually mean later rather than never.
    const index = Math.max(0, Math.min(playing.episodeIndex, show.episodes.length));
    next.cursors[playing.showId] = {
      index,
      lastRelPath: index > 0 ? show.episodes[index - 1].relPath : null,
    };
    // History said it played. It did not, so take that back — otherwise the
    // record disagrees with the counter about the same episode.
    const history = [...(state.history || [])];
    if (history[0] && history[0].showId === playing.showId && history[0].relPath === playing.relPath) {
      history.shift();
    }
    next.history = history;
  }

  const refilled = refillQueue(shows, next, { rng });
  next.queue = refilled.queue;
  next.deck = refilled.deck;
  return { state: next, dropped };
}

/** How many of this show's episodes sit together at the head of the queue. */
function blockAhead(state, showIdValue) {
  let n = 0;
  for (const item of state.queue || []) {
    if (item.showId !== showIdValue) break;
    n += 1;
  }
  return n;
}

/** Drop the head of the queue without marking it played. */
function skip(shows, state, options = {}) {
  const rng = options.rng || Math.random;
  const queue = [...(state.queue || [])];
  queue.shift();
  const next = { ...state, queue };
  const refilled = refillQueue(shows, next, { rng });
  next.queue = refilled.queue;
  next.deck = refilled.deck;
  return next;
}

/**
 * Settings that change the shape of the schedule invalidate the committed
 * queue — otherwise switching to "blocks" would not take effect until a dozen
 * episodes later, which reads as the toggle being broken.
 */
function applySettings(shows, state, patch, options = {}) {
  const rng = options.rng || Math.random;
  const settings = { ...DEFAULT_SETTINGS, ...(state.settings || {}), ...patch };
  // marathonShowId belongs here: without it, starting a marathon would keep
  // dealing the old mixed rotation for a dozen episodes before taking effect.
  // activeScheduleId and schedules both belong here: selecting a schedule, or
  // editing the one already running, must show up in Up next immediately
  // rather than a dozen episodes later.
  const reshapes = ['mode', 'blockSize', 'loopWhenExhausted', 'disabledShows',
    'marathonShowId', 'activeScheduleId', 'schedules'];
  const changed = reshapes.some((key) => JSON.stringify(settings[key]) !== JSON.stringify((state.settings || {})[key]));

  const next = { ...state, settings };
  if (changed) {
    // Both queue AND deck are discarded: a stale deck would keep dealing the
    // old rotation (including a show that was just switched off) for a full
    // round, which reads as the toggle simply not working.
    const rebuilt = refillQueue(shows, { ...next, queue: [], deck: [] }, { rng });
    next.queue = rebuilt.queue;
    next.deck = rebuilt.deck;
  }
  return next;
}

module.exports = {
  DEFAULT_SETTINGS,
  activeSchedule,
  blockSizeFor,
  QUEUE_TARGET,
  createState,
  shuffle,
  reconcileCursors,
  pruneQueue,
  refillQueue,
  peek,
  decorate,
  formatEpisodeLabel,
  advance,
  playNow,
  skip,
  skipCurrent,
  blockAhead,
  previous,
  nudgeCursor,
  resetProgress,
  nextBumper,
  nextPromo,
  nextMovie,
  shouldPlayMovie,
  markMoviePlayed,
  scheduleMovie,
  tickMovieLead,
  movieIsDue,
  clearPendingMovie,
  reshuffle,
  applyLocksToQueue,
  shouldPlayPromo,
  countEpisodeForPromo,
  applySettings,
};
