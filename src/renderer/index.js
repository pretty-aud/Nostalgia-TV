import {
  DEFAULT_SETTINGS,
  createState,
  reconcileCursors,
  pruneQueue,
  reshuffle,
  applyLocksToQueue,
  refillQueue,
  peek,
  advance,
  skip,
  skipCurrent,
  blockAhead,
  previous,
  nudgeCursor,
  resetProgress,
  nextBumper,
  nextPromo,
  shouldPlayMovie,
  scheduleMovie,
  tickMovieLead,
  movieIsDue,
  clearPendingMovie,
  markMoviePlayed,
  shouldPlayPromo,
  countEpisodeForPromo,
  playNow,
  applySettings,
  formatEpisodeLabel,
  activeSchedule,
  showsInSchedule,
} from '../shared/scheduler.js';
import {
  readyCopy,
  seedFromCursors,
  markEpisode,
  markMovie,
  forgetAll,
  forgetShow,
  resumePoint,
  movieResumePoint,
  episodeStatus,
  watchedCount,
  continueWatching,
} from '../shared/browse.js';
import {
  SHOW,
  MOVIE,
  lockableItems,
  earnUnlocks,
  isLocked,
  lockLabel,
  wouldCycle,
  setLock,
  resetUnlocks,
} from '../shared/locks.js';
import { createMpvFacade } from './mpvBridge.js';
import { pickAudioTrackId, pickSubtitleTrackId, audioMenuFrom, subtitleMenuFrom } from '../shared/mpvTracks.js';
import { subStyleProperties } from '../shared/mpvSubStyle.js';
import { cropSpecFor } from '../shared/mpvCrop.js';
import { FONT_CHOICES, DEFAULT_FONTS, fontStackFor } from '../shared/fonts.js';
import {
  tagsFor, withTags, allTags, tagsInUse, matchesGenres, narrowTags, offersCreate,
  withCustomTag, withoutTag, countTagged, cleanTag, keyFor, hasTag,
} from '../shared/genres.js';

// ---------------------------------------------------------------------------
// module state
// ---------------------------------------------------------------------------

const el = (id) => document.getElementById(id);
const app = el('app');

/**
 * THE PLAYER IS MPV, WEARING THE ELEMENT'S FACE.
 *
 * Every permanent listener, every currentTime read for a save, every paused
 * check in the transport keeps working against the same surface — the
 * facade mirrors mpv's property stream and translates writes into the typed
 * IPC. What used to be <video id="player"> in the markup is now the video
 * PLANE behind this whole window: a separate native window mpv renders
 * into, with this entire document floating transparently above it
 * (electron/planeManager.js). `el('playerSurface')` is the transparent
 * region you see the picture through — the click-and-hover target the
 * element used to be.
 */
const player = createMpvFacade(window.tv);

let state = createState(null);
let shows = [];
let bumperClips = [];      // clips from the BUMPERS folder, played between episodes
let promoClips = [];       // clips from the PROMOS folder, played after the bumper
let movieFiles = [];       // features from the MOVIES folder
let presentationClips = [];// idents from the MOVIE PRESENTATION folder

// The chosen movie lives in `state.pendingMovie` rather than a local: it is
// dealt blocks ahead of time, has to survive a restart, and is read by the
// sidebar schedule and the prepare-ahead loop as well as by playback.
let presentationLast = null;
let currentCrop = null;    // detected content box of the episode on screen

/** Bounds the skip-on-failure path, which re-enters loadAndPlay. */
let failedInARow = 0;
const MAX_FAILURES_IN_A_ROW = 5;
let current = null;        // decorated item currently on screen

/**
 * True while an interstitial clip is on screen.
 *
 * The player's `ended`, `error` and `timeupdate` listeners are attached once at
 * boot and cannot tell an episode from a clip. Without this flag a clip ending
 * would run the whole end-of-episode sequence a second time, and `timeupdate`
 * would save a resume position for the FINISHED episode using the CLIP's
 * timestamp — dropping the viewer 4 seconds into the wrong thing on next launch.
 */
let playingBumperClip = false;
let bumperClipCleanup = null;
let bumperTimer = null;
let bumperCleanup = null;
let chromeTimer = null;
// (the old debounce timer is gone: every change writes immediately now)

/** Which checkpoint a backwards Load has been warned about, and its timeout. */
let loadArmedFor = null;
let loadArmTimer = null;

const thumbCache = new Map();

const MODE_NOTES = {
  deck: 'Every show gets a turn before any show comes back around.',
  blocks: 'Two episodes of a show in a row, then move on. Like a TV block.',
  random: 'Straight random pick each time. Shows can clump.',
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Views where the sidebar sits translated off-screen (styles.css hides it for
 * exactly these two). Rebuilding its DOM there is pure waste — and it happened
 * on EVERY transition, all session: each episode advance rebuilt a list nobody
 * could see. The flag remembers that a rebuild is owed, and setView pays the
 * debt the moment the sidebar comes back.
 */
const SIDEBAR_HIDDEN_VIEWS = new Set(['playing', 'bumper']);
let sidebarDirty = false;

function sidebarVisible() {
  return !SIDEBAR_HIDDEN_VIEWS.has(app.dataset.view);
}

function setView(view) {
  const wasHidden = !sidebarVisible();
  app.dataset.view = view;
  if (wasHidden && sidebarVisible() && sidebarDirty) renderSidebar();
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function initialsOf(name) {
  return String(name)
    .split(/\s+/)
    .filter((w) => /[a-z0-9]/i.test(w))
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
}

let toastTimer = null;
function toast(message, ms = 3200) {
  const node = el('toast');
  node.textContent = message;
  node.dataset.show = 'true';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.dataset.show = 'false'; }, ms);
}

/**
 * Dismiss immediately. A "Preparing…" message is shown with a long timeout
 * because we do not know how long the job will take, so finishing early has to
 * take it down explicitly or it hangs around over the episode it announced.
 */
/**
 * Saving.
 *
 * Two rules, both learned the hard way:
 *
 *   1. EVERY change writes immediately. The old 800 ms debounce existed to
 *      avoid hammering the disk, but it meant the last thing you did before
 *      closing the app was the thing most likely to be lost — and the last
 *      thing you did is exactly the episode you were on.
 *   2. A save that failed must never look like one that worked. `state:save`
 *      catches its own errors and RESOLVES with `{ ok: false }`, so the
 *      original fire-and-forget call treated every failure as a success.
 *
 * Failures retry rather than announce themselves. Whatever went wrong is
 * usually transient — a file momentarily held open, a directory being indexed
 * — and a retry a moment later is what the viewer actually wants. The journal
 * in the main process keeps the dated record; the screen stays out of it.
 */
const SAVE_RETRY_MS = [150, 500, 1500, 4000];

let saveInFlight = false;
let saveQueued = false;
let saveRetry = 0;
let saveRetryTimer = null;

/** Resolves true when the state on disk matches what we last handed over. */
async function writeStateOnce() {
  try {
    // A structured-clone failure throws here rather than rejecting.
    const result = await window.tv.saveState(state);
    if (result && result.ok === false) {
      console.error('[state] save failed:', result.error || 'unknown error');
      return false;
    }
    return true;
  } catch (error) {
    console.error('[state] save threw:', error && error.message ? error.message : error);
    return false;
  }
}

function persist() {
  // Coalesce rather than queue up: a second change while a write is in flight
  // only needs ONE more write, because the writer always sends current state.
  if (saveInFlight) { saveQueued = true; return; }

  clearTimeout(saveRetryTimer);
  saveInFlight = true;

  writeStateOnce().then((ok) => {
    saveInFlight = false;

    if (ok) {
      saveRetry = 0;
      if (saveQueued) { saveQueued = false; persist(); }
      return;
    }

    // Keep trying. Backs off, but never gives up while the app is open —
    // stopping would put us back to losing progress silently.
    const wait = SAVE_RETRY_MS[Math.min(saveRetry, SAVE_RETRY_MS.length - 1)];
    saveRetry += 1;
    saveQueued = false;
    saveRetryTimer = setTimeout(persist, wait);
  });
}

/**
 * Write, and confirm the file on disk really changed.
 *
 * Used at the two moments where being wrong is most expensive: opening the app
 * and choosing a folder. Everything after those points depends on saving
 * working, so it is worth one round trip to find out rather than discovering it
 * an hour of viewing later.
 */
let warnedNotSaving = false;

async function verifySaving(where) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await writeStateOnce()) {
      // Guarded: a missing bridge method throws synchronously, which .catch()
      // on the call would never see — and this whole function exists because
      // an unchecked call is how the last failure stayed invisible.
      const ask = typeof window.tv.saveStatus === 'function'
        ? window.tv.saveStatus().catch(() => null)
        : Promise.resolve({ ok: true, note: 'no status bridge in this build' });
      // eslint-disable-next-line no-await-in-loop
      const check = await ask;
      if (check && check.ok) return true;
      console.error(`[state] ${where}: save reported success but the file did not land`, check);
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => { setTimeout(resolve, SAVE_RETRY_MS[attempt]); });
  }
  console.error(`[state] ${where}: progress is not being saved after 4 attempts`);
  // Said once, plainly, and never repeated. persist() goes on retrying in the
  // background, so this is a heads-up rather than a running commentary.
  if (!warnedNotSaving) {
    warnedNotSaving = true;
    toast('Progress is not saving. Your place may not be kept.', 9000);
  }
  return false;
}

/** Top up the committed schedule, always carrying the deck with the queue. */
function topUp() {
  const filled = refillQueue(shows, state, {});
  state.queue = filled.queue;
  state.deck = filled.deck;
}

// ---------------------------------------------------------------------------
// thumbnails
// ---------------------------------------------------------------------------

function waitFor(node, event, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, ms);
    const onOk = () => { cleanup(); resolve(); };
    const onErr = () => { cleanup(); reject(new Error('media error')); };
    function cleanup() {
      clearTimeout(timer);
      node.removeEventListener(event, onOk);
      node.removeEventListener('error', onErr);
    }
    node.addEventListener(event, onOk, { once: true });
    node.addEventListener('error', onErr, { once: true });
  });
}

/**
 * Grab a frame ~20% into an episode for the bumper.
 *
 * Cached on disk by absolute path, because decoding a frame out of a multi-GB
 * file is not something to repeat every time a show comes back around.
 */
async function ensureThumb(episode) {
  if (!episode || !episode.absPath) return null;
  if (thumbCache.has(episode.absPath)) return thumbCache.get(episode.absPath);

  const cached = await window.tv.getThumb(episode.absPath);
  if (cached) { thumbCache.set(episode.absPath, cached); return cached; }

  const probe = document.createElement('video');
  probe.muted = true;
  probe.preload = 'metadata';
  probe.crossOrigin = 'anonymous';   // matches the CORS header from media://
  probe.src = episode.mediaUrl;

  try {
    await waitFor(probe, 'loadedmetadata', 9000);
    const target = Number.isFinite(probe.duration) && probe.duration > 30
      ? Math.min(probe.duration * 0.2, 480)
      : 2;
    probe.currentTime = target;
    await waitFor(probe, 'seeked', 9000);

    const width = 480;
    const height = Math.round(width * (probe.videoHeight / probe.videoWidth || 0.5625));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(probe, 0, 0, width, height);

    const dataUrl = canvas.toDataURL('image/jpeg', 0.72);
    thumbCache.set(episode.absPath, dataUrl);
    window.tv.putThumb(episode.absPath, dataUrl);
    return dataUrl;
  } catch {
    thumbCache.set(episode.absPath, null); // do not retry a file that will not decode
    return null;
  } finally {
    probe.removeAttribute('src');
    probe.load();
  }
}

// ---------------------------------------------------------------------------
// rendering: sidebar
// ---------------------------------------------------------------------------

/**
 * The frequencies the menu actually offers.
 *
 * Kept as data because two separate things depend on it: the select can only
 * display a value that matches one of its options, and a state file written
 * before this list existed holds 0 — the old "Never" entry — which would
 * select nothing at all and leave the control looking empty.
 */
const MOVIE_INTERVALS = [3, 6, 12, 24, 48];

function movieIntervalHours(settings) {
  const saved = Number((settings || {}).movieEvery);
  return MOVIE_INTERVALS.includes(saved) ? saved : 24;
}

/**
 * The movie switch that sits beside the settings gear.
 *
 * Hidden without a MOVIES folder: a switch for something the library does not
 * contain is a control with nothing behind it. Off is drawn as a legible
 * state rather than an absence — a control that disappears when you switch it
 * off cannot be switched back on.
 */
function renderMovieToggle() {
  const button = el('btnMovies');
  const on = state.settings.moviesEnabled !== false;
  const hours = movieIntervalHours(state.settings);

  button.hidden = movieFiles.length === 0;
  button.setAttribute('aria-pressed', String(on));
  const label = on ? `Movies on — one every ${hours} hours` : 'Movies off';
  button.title = label;
  button.setAttribute('aria-label', label);
}

function renderSidebar() {
  // Off-screen means invisible AND untouchable (pointer-events: none), so
  // deferring loses nothing a person could notice — the rebuild happens once,
  // when the sidebar next appears, instead of once per transition behind it.
  if (!sidebarVisible()) { sidebarDirty = true; return; }
  sidebarDirty = false;

  el('rootLabel').textContent = state.rootPath || 'No folder chosen';

  const episodeCount = shows.reduce((n, s) => n + s.episodes.length, 0);
  el('libraryStats').textContent = shows.length
    ? `${shows.length} shows · ${episodeCount} episodes`
    : '';
  /**
   * The list follows the schedule picker above it.
   *
   * With a schedule in force the sidebar shows THAT schedule's shows and
   * nothing else — the question "what is on this channel" has a different
   * answer once a running order is fixed, and scrolling the whole library to
   * find out was answering the wrong one. "All Shows" is the way back.
   *
   * Library order, not schedule order: the membership changes, the place a
   * show sits does not, so finding one by eye still works the same way. A
   * schedule may list the same show twice — that is how it gets two blocks —
   * so the set is deduped by construction.
   */
  const running = activeSchedule(state.settings);
  const visible = showsInSchedule(shows, running);

  /**
   * The switch-off checkbox belongs to the whole library, not to a schedule.
   *
   * Inside a schedule the running order already decides what plays, so a tick
   * box there would be a second, quieter answer to the same question — and
   * switching a show off from a list that only exists because a schedule
   * named it reads as removing it FROM the schedule, which it does not do.
   * The card still plays on click; only the toggle goes.
   */
  const showToggles = !running;

  /**
   * "31 shows", with the NUMBER carrying the accent.
   *
   * The schedule's name used to head this line and was simply the picker
   * above repeated. What the picker cannot tell you is how many shows the
   * choice leaves, and that count is the part that moves when you change
   * schedules — so it is coloured and the noun is not.
   */
  const count = el('showCount');
  count.textContent = '';
  const n = document.createElement('b');
  n.className = 'sectionhead__n';
  n.textContent = String(visible.length);
  count.append(n, document.createTextNode(` show${visible.length === 1 ? '' : 's'}`));

  const list = el('showList');
  list.textContent = '';
  // The card is a two-column grid built around the toggle, so dropping the
  // toggle has to drop the column with it — otherwise the meta line
  // auto-places into the empty second column and sits BESIDE the show's name
  // instead of under it.
  list.dataset.toggles = String(showToggles);
  const disabled = new Set(state.settings.disabledShows || []);
  const marathonId = state.settings.marathonShowId || null;

  const empty = el('showsEmpty');
  if (running && visible.length === 0) {
    empty.hidden = false;
    empty.textContent = (running.items || []).length
      ? 'The shows in this schedule are not in the library any more.'
      : 'This schedule has no shows in it yet.';
  } else {
    empty.hidden = true;
  }

  for (const show of visible) {
    const cursor = state.cursors[show.id] || { index: 0 };
    const position = Math.min(cursor.index, show.episodes.length);
    const nextEpisode = show.episodes[position % show.episodes.length];
    const off = disabled.has(show.id);

    const li = document.createElement('li');
    li.className = 'show';
    li.dataset.off = String(off);
    li.dataset.showId = show.id;
    li.title = showToggles
      ? (off ? 'Switched off — click to include' : 'Click to switch off')
      : 'Click to play this show now';

    const name = document.createElement('div');
    name.className = 'show__name';
    name.textContent = show.name;

    const toggle = document.createElement('div');
    toggle.className = 'show__toggle';
    toggle.textContent = off ? '' : '✓';

    /**
     * Both numbers on this row are labelled, because they disagree by one BY
     * DESIGN and neither used to say which it was.
     *
     * The code is the episode coming NEXT; the count is how many are already
     * DONE. Read as "S01E04 · 3 of 26" it looks like the app is an episode
     * behind whichever number your eye lands on second, and that misread got
     * reported as lost progress more than once.
     */
    const meta = document.createElement('div');
    meta.className = 'show__meta';
    meta.append(document.createTextNode('Next '));
    const upNext = document.createElement('b');
    upNext.textContent = nextEpisode ? formatEpisodeLabel(nextEpisode) : '—';
    meta.append(upNext, document.createTextNode(` · ${position} watched of ${show.episodes.length}`));
    if (show.needsReview) {
      const warn = document.createElement('span');
      warn.className = 'show__warn';
      warn.textContent = ' · check naming';
      warn.title = 'Some files here had no readable episode number, so they are ordered by filename.';
      meta.append(warn);
    }

    // Marked, not hidden: a show that silently never comes up is indist-
    // inguishable from a bug, and the row is the only place that can say why.
    const waitingFor = lockLabel(`${SHOW}:${show.id}`, state, shows, movieFiles);
    if (waitingFor) {
      li.dataset.locked = 'true';
      const held = document.createElement('span');
      held.className = 'show__lock';
      held.textContent = ` · after ${waitingFor}`;
      held.title = `Held back until ${waitingFor} has played. Marathon and ▶ play it anyway.`;
      meta.append(held);
    }


    const bar = document.createElement('div');
    bar.className = 'show__bar';
    const fill = document.createElement('i');
    fill.style.width = `${show.episodes.length ? (position / show.episodes.length) * 100 : 0}%`;
    bar.append(fill);

    li.append(name);
    if (showToggles) li.append(toggle);
    li.append(meta, bar, showControls(show, marathonId === show.id));
    list.append(li);
  }

  renderSchedule();
  renderSettings();
}

/**
 * Per-show controls: step its position, reset it, or marathon it.
 *
 * The labels name the actual episode rather than saying "back" and "forward",
 * because the useful question at this moment is "which episode am I moving to",
 * and the row already shows where the show currently sits.
 */
function showControls(show, isMarathon) {
  const wrap = document.createElement('div');
  wrap.className = 'show__ctls';

  const cursor = state.cursors[show.id] || { index: 0 };
  const count = show.episodes.length;
  const at = Math.min(cursor.index, count);
  const nextEp = count ? show.episodes[at % count] : null;
  const prevEp = count ? show.episodes[(at - 1 + count) % count] : null;

  const make = (act, label, title, extraClass) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `showctl${extraClass ? ` ${extraClass}` : ''}`;
    button.dataset.act = act;
    button.textContent = label;
    button.title = title;
    return button;
  };


  wrap.append(
    make('back', '◄', prevEp ? `Back to ${formatEpisodeLabel(prevEp)}` : 'Back one episode'),
    make('pass', '►', nextEp ? `Pass ${formatEpisodeLabel(nextEp)}` : 'Pass this episode'),
    make('reset', '⟲', `Send ${show.name} back to episode 1`),
    make(
      'marathon',
      isMarathon ? '■' : '▶',
      isMarathon ? 'End the marathon' : `Marathon — play only ${show.name}`,
      isMarathon ? 'showctl--on' : '',
    ),
  );
  return wrap;
}

const SCHEDULE_ROWS = 4;

/**
 * The booked movie, on its own line under the schedule.
 *
 * Deliberately NOT a row in the list: a movie interrupts the rotation rather
 * than taking a turn in it, and giving it one of the four slots pushed a real
 * upcoming episode off the end to show something that is not next. Its lead is
 * counted in block boundaries, which is also the only honest way to say how far
 * off it is — the queue positions between here and there are episodes, not
 * blocks.
 */
function renderScheduleMovie() {
  const line = el('scheduleMovie');
  const movie = state.pendingMovie;

  line.hidden = !movie;
  if (!movie) return;

  const lead = Math.max(0, Number(state.movieLeadBlocks) || 0);
  el('scheduleMovieName').textContent = movie.name;
  el('scheduleMovieWhen').textContent = lead > 0
    ? `in ${lead} block${lead === 1 ? '' : 's'}`
    : 'up next';
  line.title = movie.year ? `${movie.name} (${movie.year})` : movie.name;
}

/**
 * Where the booked movie falls among the episodes on screen, or null.
 *
 * The lead is counted in block boundaries, so this walks the upcoming items
 * looking for the seam where the show changes for the Nth time. Null means the
 * seam is further out than these four rows reach — in which case the movie
 * belongs only on the line underneath. Showing it anyway, pinned to the end,
 * is what made it look like the fifth item was in a list of four.
 */
function movieInsertIndex(upcoming) {
  if (!state.pendingMovie) return null;

  const lead = Math.max(0, Number(state.movieLeadBlocks) || 0);
  let boundaries = 0;
  let previousShowId = current ? current.showId : null;

  for (let i = 0; i < upcoming.length; i += 1) {
    const showId = upcoming[i].showId;
    if (previousShowId !== null && showId !== previousShowId) boundaries += 1;
    previousShowId = showId;
    if (boundaries >= lead) return i;
  }

  return null;
}

/** The movie's row, numbered like every other position in the running order. */
function movieScheduleRow(position) {
  const li = document.createElement('li');
  li.className = 'sched sched--movie';

  const n = document.createElement('span');
  n.className = 'sched__n';
  n.textContent = String(position).padStart(2, '0');

  const wrap = document.createElement('span');
  wrap.className = 'sched__body';
  const tag = document.createElement('span');
  tag.className = 'sched__tag mono';
  tag.textContent = 'Movie';
  const name = document.createElement('span');
  name.className = 'sched__name';
  name.textContent = state.pendingMovie.name;
  wrap.append(tag, name);

  li.append(n, wrap);
  li.title = state.pendingMovie.year
    ? `${state.pendingMovie.name} (${state.pendingMovie.year})`
    : state.pendingMovie.name;
  return li;
}

function renderSchedule() {
  const list = el('scheduleList');
  list.textContent = '';

  const upcoming = peek(shows, state, SCHEDULE_ROWS);
  const rows = upcoming.map((item) => ({ kind: 'episode', item }));

  // Only when it genuinely falls inside these four. A movie that is fifth in
  // the running order is not in a list of the next four, so it is announced on
  // the line underneath instead — and when it IS in here it takes a position
  // like anything else, because it really does occupy that place.
  const at = movieInsertIndex(upcoming);
  if (at !== null && at < SCHEDULE_ROWS) rows.splice(at, 0, { kind: 'movie' });

  const visible = rows.slice(0, SCHEDULE_ROWS);
  let dropOffered = false;

  for (let i = 0; i < visible.length; i += 1) {
    if (visible[i].kind === 'movie') {
      list.append(movieScheduleRow(i + 1));
      continue;
    }

    const item = visible[i].item;
    const li = document.createElement('li');
    li.className = 'sched';

    const n = document.createElement('span');
    n.className = 'sched__n';
    n.textContent = String(i + 1).padStart(2, '0');

    // Its own class, NOT the movie row's: .sched__body stretches the name so
    // the code right-aligns, which is right for one highlighted row and wrong
    // for a list of four. This one only ever gets a truncation rule, and only
    // in the theme that needs it.
    const wrap = document.createElement('span');
    wrap.className = 'sched__line';
    const name = document.createElement('span');
    name.className = 'sched__name';
    name.textContent = item.showName;
    const code = document.createElement('span');
    code.className = 'sched__code';
    code.textContent = ` ${item.label}`;
    wrap.append(name, code);

    li.append(n, wrap);
    // Offered on the first EPISODE, wherever it sits: the control bumps the
    // next queued show, and a movie is not in the queue to be bumped.
    if (!dropOffered) {
      dropOffered = true;
      const drop = document.createElement('button');
      drop.className = 'sched__drop';
      drop.type = 'button';
      drop.textContent = '✕';
      drop.title = 'Not that one — bump it and pick something else';
      li.append(drop);
    }
    list.append(li);
  }

  renderScheduleMovie();
  renderScheduleField();
}

/**
 * The sidebar's running-order control.
 *
 * One picker for "what decides the order", rather than two that can disagree.
 * While a marathon runs it stands down and says so, because during a marathon
 * the schedule genuinely is not deciding anything — but it stays usable, since
 * picking a schedule from it is how the marathon ends.
 */
function renderScheduleField() {
  const select = el('scheduleSelect');
  const field = el('scheduleField');
  const marathonId = state.settings.marathonShowId || null;
  const marathonShow = marathonId ? shows.find((s) => s.id === marathonId) : null;
  const running = activeSchedule(state.settings);

  select.textContent = '';

  if (marathonShow) {
    // A disabled <select> cannot be opened, and this one has to be — so it is
    // dimmed by the field, not disabled.
    const status = document.createElement('option');
    status.value = '__marathon__';
    status.textContent = `${marathonShow.name} — marathon playing`;
    select.append(status);
  }

  /**
   * "All Shows" is the same choice the "Off — shuffle the rotation" entry
   * was: no schedule in force. The label changed because this control now
   * decides the LIST as well as the order, and from the list's side the
   * honest name for "no schedule" is "everything". It is never "No schedules
   * yet" any more either — with nothing saved, All Shows is still exactly
   * what you are looking at, and Create new… below says what to do next.
   */
  const all = document.createElement('option');
  all.value = '';
  all.textContent = 'All Shows';
  select.append(all);

  for (const sc of savedSchedules()) {
    const option = document.createElement('option');
    option.value = sc.id;
    const blocks = (sc.items || []).length;
    option.textContent = `${sc.name} · ${blocks} block${blocks === 1 ? '' : 's'}`;
    select.append(option);
  }

  /**
   * An ACTION in a list of states, which a <select> is not really for — but
   * it belongs here: "make another one" is the same question as "which one",
   * asked when the answer is none of these. It never becomes the value; the
   * change handler opens the editor and puts the selection straight back.
   */
  const create = document.createElement('option');
  create.value = '__create__';
  create.textContent = savedSchedules().length ? 'Create new…' : 'Create a schedule…';
  select.append(create);

  select.value = marathonShow ? '__marathon__' : (running ? running.id : '');
  select.disabled = shows.length === 0;
  field.dataset.on = String(Boolean(running) && !marathonShow);
  field.dataset.muted = String(Boolean(marathonShow));

  /**
   * Shuffle is stood down rather than disabled while a fixed order runs.
   *
   * It still does something — it turns the schedule off and goes back to a
   * rotation — so a control that could not be pressed would be a lie. Dimmed
   * says "not what is in force"; disabled would say "unavailable".
   */
  el('btnShuffle').dataset.standdown = String(Boolean(running) || Boolean(marathonShow));
}

function renderSettings() {
  const marathonId = state.settings.marathonShowId || null;
  const marathonShow = marathonId ? shows.find((s) => s.id === marathonId) : null;

  renderLockSummary();

  /**
   * Rotation governs which show comes next, which is exactly what a marathon
   * takes over — so the buttons are dimmed rather than left looking broken.
   * A set schedule takes it over just as completely, and for the same reason.
   */
  const scheduleOn = Boolean(activeSchedule(state.settings));
  el('modeGroup').dataset.muted = String(Boolean(marathonShow) || scheduleOn);

  for (const button of document.querySelectorAll('.mode')) {
    button.setAttribute('aria-pressed', String(button.dataset.mode === state.settings.mode));
  }
  const runningSchedule = activeSchedule(state.settings);
  el('modeNote').textContent = marathonShow
    ? `Paused while the ${marathonShow.name} marathon runs.`
    : (runningSchedule
      ? `Paused while the “${runningSchedule.name}” schedule runs. Shuffle to go back to a rotation.`
      : (MODE_NOTES[state.settings.mode] || ''));

  el('bumperRange').value = String(state.settings.bumperEnabled ? state.settings.bumperSeconds : 0);
  el('bumperOut').textContent = state.settings.bumperEnabled && state.settings.bumperSeconds > 0
    ? `${state.settings.bumperSeconds}s`
    : 'Off';

  el('loopToggle').checked = Boolean(state.settings.loopWhenExhausted);

  const blockSize = Math.max(2, Number(state.settings.blockSize) || 2);
  el('blockSizeRange').value = String(blockSize);
  el('blockSizeOut').textContent = `${blockSize} episodes`;
  // Dimmed rather than hidden while another rotation is selected: it still
  // says what Blocks would do if you picked it.
  el('blockSizeField').dataset.muted = String(state.settings.mode !== 'blocks');

  // Hidden entirely when there is no BUMPERS folder — a toggle for something
  // the library does not contain is just a question the user cannot answer.
  el('bumperClipRow').hidden = bumperClips.length === 0;
  el('bumperClipToggle').checked = Boolean(state.settings.bumperClipsEnabled);
  el('bumperClipCount').textContent = bumperClips.length ? `${bumperClips.length} clip${bumperClips.length === 1 ? '' : 's'}` : '';

  // The whole group goes, not just the on/off row: a heading followed by a
  // frequency for something the library does not contain is three questions
  // with no answers.
  el('promoGroup').hidden = promoClips.length === 0;
  el('promoToggle').checked = Boolean(state.settings.promosEnabled);
  el('promoCount').textContent = promoClips.length ? `${promoClips.length} clip${promoClips.length === 1 ? '' : 's'}` : '';

  const every = Math.max(1, Number(state.settings.promoEvery) || 1);
  el('promoEveryRange').value = String(every);
  el('promoEveryOut').textContent = every === 1 ? 'Every episode' : `Every ${every} episodes`;
  // "Between shows" overrides the count, so the episode gap is dimmed rather
  // than hidden: it still says what it would do if you switched back.
  const betweenShows = Boolean(state.settings.promoBetweenShows);
  el('promoBetweenToggle').checked = betweenShows;
  // Hidden rather than emptied: .modes__note reserves 32px so the panel does
  // not jump as its text changes, which on a note that is blank half the time
  // just leaves a hole above the next control.
  el('promoBetweenNote').hidden = !betweenShows;
  el('promoBetweenNote').textContent = betweenShows
    ? 'One promo at each change of show — the end of a block in Blocks, every turn in Deck and Random.'
    : '';
  el('promoEveryField').dataset.muted = String(
    !state.settings.promosEnabled || promoClips.length === 0 || betweenShows,
  );

  // Hidden entirely without a MOVIES folder: a frequency for something the
  // library does not contain is a question with no useful answer.
  el('movieGroup').hidden = movieFiles.length === 0;
  const moviesOn = state.settings.moviesEnabled !== false;
  el('movieEvery').value = String(movieIntervalHours(state.settings));
  // Dimmed rather than hidden while movies are off: it still says how often
  // they would play if you switched them back on.
  el('movieEveryField').dataset.muted = String(!moviesOn);
  el('movieNote').textContent = moviesOn
    ? `${movieFiles.length} in the library, shuffled. A movie interrupts the rotation; it is not part of a block.`
    : `${movieFiles.length} in the library. Switched off — the film button beside the settings gear turns them back on.`;
  renderMovieToggle();

  el('presentationRow').hidden = presentationClips.length === 0;
  el('presentationToggle').checked = state.settings.moviePresentationEnabled !== false;
  el('presentationCount').textContent = presentationClips.length
    ? `${presentationClips.length} clip${presentationClips.length === 1 ? '' : 's'}`
    : '';

  const theme = resolveTheme(state.settings.theme);
  el('themeSelect').value = theme;

  // Built from FONT_CHOICES rather than written into the markup, so a face is
  // added in one place and cannot drift out of step with what applyFonts can
  // actually resolve.
  const fonts = state.settings.fonts || {};
  for (const [id, chosen, fallback] of [
    ['fontDisplaySelect', fonts.display, DEFAULT_FONTS.display],
    ['fontBodySelect', fonts.body, DEFAULT_FONTS.body],
  ]) {
    const select = el(id);
    if (!select.options.length) {
      for (const font of FONT_CHOICES) {
        const option = document.createElement('option');
        option.value = font.id;
        option.textContent = font.label;
        // Show each choice IN itself: the label is the only preview there is,
        // and reading "handwritten" in Inter tells you nothing.
        option.style.fontFamily = font.stack;
        select.append(option);
      }
    }
    select.value = FONT_CHOICES.some((f) => f.id === chosen) ? chosen : fallback;
  }
  el('themeNote').textContent = LIGHT_THEMES.includes(theme)
    ? 'Panels take the theme; over the picture the type stays legible against the video.'
    : '';

  el('autoCropToggle').checked = state.settings.autoCrop !== false;
  el('autoCropNote').textContent = currentCrop && currentCrop.worthCropping
    ? `This episode: ${currentCrop.detected} inside ${currentCrop.frame}.`
    : 'For releases that encode 4:3 inside a 16:9 frame. Detected per episode.';

  const zoom = Math.max(100, Number(state.settings.interstitialZoom) || 100);
  el('interZoomRange').value = String(zoom);
  el('interZoomOut').textContent = zoom === 100 ? 'Off' : `${zoom}%`;


  const uiScale = Math.min(160, Math.max(80, Number(state.settings.uiScale) || 100));
  el('uiScaleRange').value = String(uiScale);
  el('uiScaleOut').textContent = `${uiScale}%`;

  renderCueControls();
}

// ---------------------------------------------------------------------------
// rendering: bumper
// ---------------------------------------------------------------------------

async function showBumper(onDone, leadOverride) {
  const upcoming = peek(shows, state, 3);
  if (upcoming.length === 0 && !leadOverride) { onDone(); return; }

  // A movie takes the headline; the episodes behind it still list underneath,
  // because they are genuinely what follows it.
  const lead = leadOverride || upcoming[0];
  const leadNode = el('bumperLead');
  leadNode.textContent = '';

  const thumb = document.createElement('div');
  thumb.className = 'lead__thumb';
  thumb.dataset.empty = 'true';
  thumb.dataset.initials = initialsOf(lead.showName);

  const info = document.createElement('div');
  const showName = document.createElement('div');
  showName.className = 'lead__show';
  showName.textContent = lead.showName;
  const code = document.createElement('div');
  code.className = 'lead__code';
  code.textContent = lead.label;
  info.append(showName, code);
  if (lead.title) {
    const title = document.createElement('div');
    title.className = 'lead__title';
    title.textContent = lead.title;
    info.append(title);
  }

  leadNode.append(thumb, info);

  const then = el('bumperThen');
  then.textContent = '';
  for (let i = leadOverride ? 0 : 1; i < upcoming.length; i += 1) {
    const item = upcoming[i];
    const li = document.createElement('li');
    li.className = 'then';

    const n = document.createElement('span');
    n.className = 'then__n';
    n.textContent = String(i + 1).padStart(2, '0');

    const mid = document.createElement('span');
    const name = document.createElement('span');
    name.className = 'then__show';
    name.textContent = item.showName;
    mid.append(name);
    if (item.title) {
      const t = document.createElement('span');
      t.className = 'then__title';
      t.textContent = item.title;
      mid.append(t);
    }

    const c = document.createElement('span');
    c.className = 'then__code';
    c.textContent = item.label;

    li.append(n, mid, c);
    then.append(li);
  }

  setView('bumper');
  // Start transparent, then let the browser paint one frame before animating —
  // set to 'in' in the same tick and there is no starting value to move from,
  // so it snaps. Two frames is what reliably survives a heavy layout.
  app.dataset.bumperFade = 'out';
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (app.dataset.view === 'bumper') app.dataset.bumperFade = 'in';
  }));

  // Thumbnail arrives late if at all; the bumper never waits on it.
  ensureThumb(lead.episode).then((dataUrl) => {
    if (!dataUrl || app.dataset.view !== 'bumper') return;
    const img = document.createElement('img');
    img.src = dataUrl;
    img.alt = '';
    thumb.dataset.empty = 'false';
    thumb.append(img);
  });

  /**
   * A pure countdown. The card used to start the next episode's conversion
   * here and HOLD past its own timer until the file was ready — sometimes
   * minutes, with progress copy and promo filler to spend the wait on. mpv
   * plays the library directly, so the card is back to being what it looks
   * like: a breath between programmes, skippable by any key.
   */
  const seconds = Math.max(1, state.settings.bumperSeconds);
  const startedAt = performance.now();
  const fill = el('bumperTimerFill');
  const countLabel = el('bumperCount');

  // Tear down any bumper still wired up before standing a new one up, or its
  // key and click handlers survive and fire a second advance.
  if (bumperCleanup) bumperCleanup();

  const teardown = () => {
    clearInterval(bumperTimer);
    bumperTimer = null;
    bumperCleanup = null;
    document.removeEventListener('keydown', onKey, true);
    el('bumper').removeEventListener('click', onClick);
  };
  bumperCleanup = teardown;

  const finish = () => {
    teardown();
    // The card DOES fade out — it dissolves into the episode that follows it,
    // and unlike the clip there is something on screen to dissolve away from.
    app.dataset.bumperFade = 'out';
    setTimeout(onDone, FADE_MS);
  };
  const onKey = (event) => {
    if (event.key === 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    finish();
  };
  const onClick = () => finish();

  document.addEventListener('keydown', onKey, true);
  el('bumper').addEventListener('click', onClick);

  const tick = () => {
    const elapsed = (performance.now() - startedAt) / 1000;
    const remaining = Math.max(0, seconds - elapsed);
    fill.style.transform = `scaleX(${remaining / seconds})`;
    countLabel.textContent = `${Math.ceil(remaining)}`;
    if (remaining <= 0) finish();
  };
  tick();
  bumperTimer = setInterval(tick, 100);
}

// ---------------------------------------------------------------------------
// playback
// ---------------------------------------------------------------------------

function renderNowPlaying(item) {
  el('npShow').textContent = item.showName;
  el('npCode').textContent = item.label;
  el('npTitle').textContent = item.title || '';
  const upcoming = peek(shows, state, 1)[0];
  el('chromeUpNext').textContent = upcoming ? `Next: ${upcoming.showName} ${upcoming.label}` : '';
}

/**
 * THE CONVERSION WORLD IS GONE.
 *
 * This region used to hold ~500 lines of choreography that existed because
 * Chromium could not play the library: the playable-URL cache and its
 * generation gating, the measured decode verdicts, the wanted-audio ffprobe
 * cache, prepare-ahead and its disk-yielding priority dance, the preparing
 * panel. mpv decodes everything the library holds and switches tracks live,
 * so playing an episode is now: open the file, from the resume point, and
 * apply the show's preferences when metadata lands. The planner, the cache,
 * the tiers — all of it main-process machinery the player simply no longer
 * asks for.
 *
 * `playToken` SURVIVES: opens are near-instant but still async, and a rapid
 * Next during one must discard the stragglers of the one it replaced.
 */
let playToken = 0;

async function loadAndPlay(item, seekTo = 0) {
  // Tear down a clip still on screen (the user pressed Next through it) without
  // running its onDone, which would advance the queue a second time.
  if (bumperClipCleanup) bumperClipCleanup();

  const token = ++playToken;
  current = item;
  setView('playing');
  toggleTrackMenu(false);

  /**
   * The episode opens with NO interface over it. This used to call
   * showChrome(), so every episode began with the transport fading in and
   * out across the first couple of seconds of the picture — chrome is one
   * hover or one press away, and the title is on the card that just played.
   * (The old flow delayed the title too, because a conversion could hold the
   * previous picture on screen for minutes; nothing holds anything any more.)
   */
  renderNowPlaying(item);
  clearTimeout(chromeTimer);
  app.dataset.chrome = 'off';
  renderSidebar();
  persist();

  /**
   * Registered BEFORE the open, not after it.
   *
   * mpv can report the new file's duration before `open()`'s own IPC reply
   * gets back to us, and this is a ONE-SHOT event: attaching afterwards
   * meant it had already fired into an empty room. Nothing then applied the
   * show's audio and subtitle preferences, nothing filled the track menus
   * (a viewer with dual-audio anime opened the menu to find NOTHING to
   * pick), nothing ran the auto-crop, and the failure breaker never reset.
   * The <video> element never showed this because src=/load() could not
   * outrun the next line of code; an IPC player can.
   *
   * Still token-guarded, and now for two reasons: a rapid Next must not land
   * the old show's language on the new file, and moving the registration
   * earlier means a stale firing is possible from THIS side of the open too.
   */
  player.addEventListener('loadedmetadata', () => {
    if (token !== playToken) return;
    /**
     * REAL progress is what resets the failure breaker — not the open call,
     * which resolves even for a missing file (mpv accepts the command and
     * reports the failure later as an error event). Resetting on open made
     * an unplugged drive an infinite skip loop that churned every cursor in
     * the library at one episode per one-and-a-half seconds.
     */
    failedInARow = 0;
    /**
     * Both calls are async and neither is awaited — this handler must not
     * hold anything up. So each carries its OWN catch, because an unawaited
     * rejection in a renderer is INVISIBLE, and that is not hypothetical: a
     * helper deleted by an unrelated cleanup (prefFor) made the first call
     * throw a ReferenceError on every single episode. The menus opened
     * empty, the show's language preference never applied, the crop never
     * ran, and nothing anywhere said a word about it.
     */
    applyTrackPrefs(item).catch((error) => console.error('track preferences failed:', error));
    loadCropForCurrent().catch((error) => console.error('auto-crop failed:', error));
  }, { once: true });

  try {
    await player.open(item.episode.absPath, { startSeconds: seekTo > 0 ? seekTo : 0 });
  } catch {
    // Refused outright — mpv mid-restart, or a path outside the roots. The
    // decode-failure path is onPlaybackError; this one never started.
    if (token !== playToken) return;
    failedInARow += 1;
    if (failedInARow >= MAX_FAILURES_IN_A_ROW) {
      failedInARow = 0;
      toast('Several episodes in a row could not be played. Stopping here.', 6000);
      setView('ready');
      renderReady();
      renderSidebar();
      return;
    }
    playNext();
    return;
  }
  if (token !== playToken) return;      // the user moved on while we opened
  player.play();

  // Warm the next bumper's thumbnail while this episode plays, so the
  // interstitial has a picture the moment it appears.
  const upcoming = peek(shows, state, 1)[0];
  if (upcoming) setTimeout(() => ensureThumb(upcoming.episode), 4000);
}

/**
 * Ask what "skip" should mean here, then do it.
 *
 * Three genuinely different answers and none of them is a safe default:
 *
 *   episode — this one is done, carry on with the block
 *   count   — done with this show for now, drop the rest of its block
 *   block   — not now, the whole block comes round again later
 *
 * Guessing silently loses an episode, silently repeats one, or silently drops
 * the rest of a block someone wanted.
 */
function askSkip() {
  if (!current || playingBumperClip) { playNext(); return; }

  const item = current;
  const inBlock = blockAhead(state, item.showId) + 1;   // +1 for the one on screen
  const ask = el('skipAsk');

  el('skipAskTitle').textContent = `${item.showName} ${item.label}`;
  el('skipAskBody').textContent = inBlock > 1
    ? `${inBlock} episodes of this show are queued together.`
    : 'Should this count as watched, or come round again later?';

  // With nothing else of this show queued, "just this episode" and "the rest of
  // the block" are the same act, so only the meaningful pair is offered.
  el('skipEpisode').hidden = inBlock <= 1;
  el('skipEpisode').textContent = `Skip just this episode, keep the block`;
  el('skipCount').textContent = inBlock > 1
    ? `Skip all ${inBlock} — move on to another show`
    : 'Skip it on the counter';
  el('skipBlock').textContent = inBlock > 1 ? 'Play the block later' : 'Just skip it for now';

  const close = () => {
    ask.hidden = true;
    document.removeEventListener('keydown', onKey, true);
  };
  const choose = (mode) => {
    close();
    const result = skipCurrent(shows, state, item, { mode });
    state = result.state;
    persist();
    renderSidebar();
    const said = {
      // advance() already moved the cursor past it, which is the progress the
      // viewer asked to keep — so this one really is just "next".
      episode: `Skipped ${item.label} — ${item.showName} continues.`,
      count: `Skipped — ${item.showName} moves on.`,
      block: `${item.showName} will come back to ${item.label}.`,
    };
    toast(said[mode], 2600);
    playNext();
  };
  const onKey = (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };

  el('skipEpisode').onclick = () => choose('episode');
  el('skipCount').onclick = () => choose('count');
  el('skipBlock').onclick = () => choose('block');
  el('skipCancel').onclick = close;
  document.addEventListener('keydown', onKey, true);

  ask.hidden = false;
  showChrome();
  (inBlock > 1 ? el('skipEpisode') : el('skipCount')).focus();
}

function playNext() {
  // Anything that comes through advance() is the channel playing. Library mode
  // has to end here as well as at its own button: the sidebar's Resume also
  // lands here, and leaving the flag set would send the end of a CHANNEL
  // episode into the library's next-episode handler.
  if (browsing()) { app.dataset.browsing = 'false'; browseItem = null; }

  const result = advance(shows, state, {});
  state = result.state;
  // An episode starting is the main way progress moves, so it is the main way
  // a prerequisite gets satisfied.
  refreshLocks();
  if (!result.item) {
    toast('Nothing left to play. Switch a show back on, or enable restarting.');
    setView('ready');
    renderReady();
    renderSidebar();
    return;
  }
  loadAndPlay(result.item);
}

/**
 * Watchdogs for interstitial playback.
 *
 * These exist so a clip that never starts, or wedges, cannot strand the
 * channel. They must NEVER cut short a clip that is playing fine — which a
 * single fixed timeout did: it was sized for a few-second bumper, and promos
 * run to three minutes, so every long promo was chopped off mid-play and the
 * up-next card appeared over it.
 *
 * So the real bound comes from the clip's own duration once metadata says what
 * that is. The short one only covers "it never got going at all".
 */
const CLIP_START_TIMEOUT_MS = 20000;
const CLIP_DURATION_GRACE_MS = 15000;
/** Backstop for a file reporting a nonsense or infinite duration. */
const CLIP_MAX_MS = 20 * 60 * 1000;

/** Must match --fade in styles.css, or the card is cut away mid-dissolve. */
const FADE_MS = 340;

/**
 * Play one interstitial clip, then call `onDone`.
 *
 * Every exit path leads to `finish`: it ended, it errored, it never started, or
 * it overran the watchdog. A clip is decoration — the one thing it must never
 * do is strand the channel, so there is no path where `onDone` is not called.
 */
async function playClip(clip, onDone, kind = 'Bumper') {
  if (!clip) { onDone(); return; }

  // A clip is a file like any other now: mpv opens it directly — no cache,
  // no conversion, no language question. The OPEN happens at the very END of
  // this function, after the flag and the listeners stand: the permanent
  // ended/timeupdate handlers read `playingBumperClip` to stand down, and an
  // open that runs before the flag is set lets the clip's first moments save
  // a resume point for the FINISHED episode at the clip's timestamp — the
  // exact bug the flag was built for.
  const token = ++playToken;

  let done = false;
  let watchdog = null;

  const teardown = () => {
    clearTimeout(watchdog);
    player.removeEventListener('ended', finish);
    player.removeEventListener('error', failed);
    player.removeEventListener('loadedmetadata', armFullWatchdog);
    bumperClipCleanup = null;
    // Cleared LAST: the permanent `ended`/`error` listeners were registered
    // before ours and fire first, and they read this flag to stand down.
    playingBumperClip = false;
  };
  const finish = () => {
    if (done) return;
    done = true;
    teardown();
    // Straight through. A delay here is 340ms of nothing between the clip
    // ending and the next thing starting — which is dead black on screen,
    // because the clip is over and the card has not begun.
    onDone();
  };

  const failed = () => finish();   // a clip that errors just moves the channel on

  /**
   * Once the clip says how long it is, give it that long plus a margin.
   *
   * Until then all we can safely bound is "did it start at all", because a
   * three-minute promo and a broken file are indistinguishable before metadata
   * arrives — and guessing short cuts the promo off in front of the viewer.
   */
  function armFullWatchdog() {
    clearTimeout(watchdog);
    const seconds = player.duration;
    const bound = Number.isFinite(seconds) && seconds > 0
      ? Math.min(seconds * 1000 + CLIP_DURATION_GRACE_MS, CLIP_MAX_MS)
      : CLIP_MAX_MS;
    watchdog = setTimeout(finish, bound);
  }

  /**
   * The clip names itself while it is on screen.
   *
   * The top-left kept showing the episode that just FINISHED, so a promo looked
   * like part of the previous programme — and if you opened the library during
   * one, the header disagreed with the picture behind it.
   */
  el('npShow').textContent = kind;
  el('npCode').textContent = clip.name || '';
  el('npTitle').textContent = '';

  watchdog = setTimeout(finish, CLIP_START_TIMEOUT_MS);
  player.addEventListener('loadedmetadata', armFullWatchdog, { once: true });

  // Cancelling (the user hit Next) must NOT call onDone — the caller is already
  // starting something else, and running the queue forward twice would skip an
  // episode nobody asked to skip.
  bumperClipCleanup = () => { if (!done) { done = true; teardown(); } };

  playingBumperClip = true;
  setView('playing');
  // No transport over a clip: it is a few seconds long and the controls would
  // be acting on an episode that is no longer on screen.
  clearTimeout(chromeTimer);
  app.dataset.chrome = 'off';
  applyPicture(true);

  player.addEventListener('ended', finish, { once: true });
  player.addEventListener('error', failed, { once: true });

  // LAST, with everything above already standing (see the note at the top).
  try {
    await player.open(clip.absPath);
  } catch {
    failed();                       // refused outright: move the channel on
    return;
  }
  if (token !== playToken) return;  // superseded while opening; cleanup ran
  player.play();
}

/** Deal and play a bumper, or pass straight through when there is none. */
function playBumperClip(onDone) {
  if (!state.settings.bumperClipsEnabled || bumperClips.length === 0) { onDone(); return; }
  const picked = nextBumper(bumperClips, state, {});
  state = picked.state;
  playClip(picked.bumper, onDone, 'Bumper');
}

/**
 * Deal and play a promo, if one is due.
 *
 * The counter is advanced here rather than at the end of an episode, so that
 * turning promos off and on again does not leave a stale count deciding when
 * the next one appears.
 */
function playPromoClip(onDone) {
  // The "between shows" rule needs to see both sides of the seam. `current` is
  // the episode that just finished and the queue head is what follows it, so
  // the comparison covers blocks mode (same show repeats until the block ends)
  // and deck or random mode (the show changes every turn) with one rule.
  const upcoming = peek(shows, state, 1)[0];
  const seam = {
    finishedShowId: current ? current.showId : null,
    nextShowId: upcoming ? upcoming.showId : null,
  };

  if (!shouldPlayPromo(state, promoClips, seam)) {
    state = countEpisodeForPromo(state, false);
    onDone();
    return;
  }
  const picked = nextPromo(promoClips, state, {});
  state = countEpisodeForPromo(picked.state, true);
  playClip(picked.promo, onDone, 'Promo');
}

/*
 * The filler-promo machinery lived here: promos spent covering a conversion
 * that outran the up-next card. Nothing converts any more, so the card's
 * countdown is the whole wait and the machinery went with the pipeline.
 */

/**
 * Dress a movie up as something loadAndPlay understands.
 *
 * A movie is not an episode of anything — it has no show, no season and no
 * place in the rotation — but the player only knows how to play one shape, so
 * it borrows that shape and carries `isMovie` for the handful of places where
 * the difference matters.
 */
function movieItem(movie) {
  return {
    showId: '__movie__',
    showName: movie.name,
    label: movie.year ? String(movie.year) : 'Movie',
    title: '',
    relPath: movie.relPath,
    episodeIndex: 0,
    isMovie: true,
    episode: {
      absPath: movie.absPath,
      mediaUrl: movie.mediaUrl,
      relPath: movie.relPath,
      fileName: movie.fileName,
    },
  };
}

/**
 * Pick the ident that runs before a movie.
 *
 * Most libraries will hold exactly one of these, so this stays a simple
 * random pick that avoids an immediate repeat rather than a full shuffled
 * deck — the deck would be machinery with nothing to do.
 */
function pickPresentation() {
  if (presentationClips.length === 0) return null;
  if (presentationClips.length === 1) return presentationClips[0];
  const pool = presentationClips.filter((clip) => clip.relPath !== presentationLast);
  const picked = pool[Math.floor(Math.random() * pool.length)] || presentationClips[0];
  presentationLast = picked.relPath;
  return picked;
}

/**
 * Roll the presentation, then the feature.
 *
 * The clock restarts when the movie STARTS rather than when it was due, so a
 * long film does not immediately qualify for another one the moment it ends.
 */
function startMovie() {
  const movie = state.pendingMovie;
  if (!movie) { playNext(); return; }

  // markMoviePlayed clears the pending slot and restarts the clock together,
  // so the movie cannot be dealt a second time on the next transition.
  state = markMoviePlayed(state, {});
  // A film starting can satisfy a sequel's prerequisite.
  refreshLocks();
  persist();
  renderSidebar();

  const roll = () => loadAndPlay(movieItem(movie));
  const presentation = state.settings.moviePresentationEnabled === false ? null : pickPresentation();
  if (presentation) playClip(presentation, roll, 'Coming up'); else roll();
}

function onEpisodeEnded() {
  // The clip's own handler owns this event; see playingBumperClip.
  if (playingBumperClip) return;

  // Library mode ends an episode its own way: the next one in the show, with
  // no bumper, no promo and no movie lead. Returning here rather than adding a
  // branch further down keeps the channel's transition in one piece.
  if (browsing() && browseItem) { browseEpisodeEnded(); return; }

  state.resume = null;

  // The seam between this show and the next drives both the promo rule and the
  // movie's lead, so it is computed once here.
  const upcoming = peek(shows, state, 1)[0];
  const finishedShowId = current ? current.showId : null;
  const nextShowId = upcoming ? upcoming.showId : null;

  // Spend one block of the movie's lead, if this is a boundary.
  state = tickMovieLead(state, { finishedShowId, nextShowId });

  // Choose the NEXT movie as soon as the clock says one is owed, rather than at
  // the transition it plays on. That is what puts it in the sidebar schedule
  // and gives the conversion a few blocks of head start instead of a few
  // seconds of up-next card.
  if (!state.pendingMovie && shouldPlayMovie(state, movieFiles, {})) {
    const picked = scheduleMovie(movieFiles, state, {});
    state = picked.state;
    if (picked.movie) renderSidebar();
  }

  /**
   * Write everything down the moment the episode is over.
   *
   * The cursor already moved when this episode STARTED, so the count was
   * safe — but the resume position, the movie's lead and any unlock earned by
   * finishing this episode are all settled right here, and the next few
   * minutes are interstitials. Closing the app during a promo should not lose
   * the fact that the episode before it finished.
   */
  refreshLocks();
  renderSidebar();
  persist();

  // Broadcast order: sting, promo, continuity card, then the next programme —
  // or, when the lead has run out, the movie presentation and the movie.
  // Each step passes through instantly when it has nothing to play.
  playBumperClip(() => {
    playPromoClip(() => {
      const movieNow = movieIsDue(state);
      const leadOverride = movieNow ? movieItem(state.pendingMovie) : null;
      const after = () => (movieNow ? startMovie() : playNext());
      if (state.settings.bumperEnabled && state.settings.bumperSeconds > 0) {
        showBumper(after, leadOverride);
      } else {
        after();
      }
    });
  });
}

// ---------------------------------------------------------------------------
// chrome auto-hide
// ---------------------------------------------------------------------------

/**
 * Show the transport, and start its countdown to hiding again.
 *
 * Only ever called from something the VIEWER did — a press, a hover, a key.
 * It is deliberately not wired to the <video> 'play' event: that event cannot
 * tell "the viewer pressed play" from "the app started the next thing", so
 * hanging chrome off it made the interface flash up over the first second of
 * every episode and every bumper.
 */
function showChrome() {
  // A clip never gets chrome, not even on hover. It runs for a few seconds and
  // the transport would be acting on an episode that is no longer on screen.
  if (playingBumperClip) return;
  app.dataset.chrome = 'on';
  clearTimeout(chromeTimer);
  chromeTimer = setTimeout(() => {
    if (!player.paused) app.dataset.chrome = 'off';
  }, 2500);
}

// ---------------------------------------------------------------------------
// ready / welcome screens
// ---------------------------------------------------------------------------

/**
 * Rebuild the first-run screen. Needed because renderReady() reuses the same
 * container, so a later "folder had no videos" would otherwise leave the ready
 * screen's markup on show with a dead button attached to it.
 */
function renderWelcome() {
  const inner = document.querySelector('.welcome__inner');
  inner.textContent = '';

  const eyebrow = document.createElement('p');
  eyebrow.className = 'eyebrow mono';
  eyebrow.textContent = 'Your own channel';

  const title = document.createElement('h1');
  title.className = 'welcome__title';
  title.append('Shows shuffle.', document.createElement('br'), "Episodes don't.");

  const body = document.createElement('p');
  body.className = 'welcome__body';
  body.textContent = 'Point this at the folder holding your shows. It plays them in a '
    + 'random order, but every show always picks up on its next episode — and tells you '
    + "what's coming.";

  const button = document.createElement('button');
  button.className = 'btn btn--signal';
  button.type = 'button';
  button.textContent = 'Choose your TV folder';
  button.addEventListener('click', pickFolder);

  const hint = document.createElement('p');
  hint.className = 'welcome__hint mono';
  hint.textContent = 'One subfolder per show works best';

  inner.append(eyebrow, title, body, button, hint);
  setView('welcome');
}

function renderReady() {
  const inner = document.querySelector('.welcome__inner');
  inner.textContent = '';

  const resumable = state.resume ? findEpisode(state.resume) : null;
  const upcoming = peek(shows, state, 1)[0];

  /**
   * What is actually loaded, whatever kind of thing it is.
   *
   * The screen used to describe state.resume and nothing else, and state.resume
   * only ever holds a CHANNEL EPISODE — never a movie, never anything watched
   * in library mode. So opening the library over a playing movie showed "Start
   * the channel / First up: <something else>" while the button underneath said
   * Resume and did the right thing. The screen was describing a different
   * programme from the one it was covering.
   */
  const onScreen = canResumeInPlace() && current
    ? {
      title: current.showName,
      detail: current.isMovie
        ? formatTime(player.currentTime) + ' in.'
        : `${current.label}${current.title ? ' · ' + current.title : ''} — ${formatTime(player.currentTime)} in.`,
    }
    : null;

  const copy = readyCopy(
    onScreen,
    resumable ? {
      title: resumable.show.name,
      detail: `${formatEpisodeLabel(resumable.episode)}${resumable.episode.title ? ` · ${resumable.episode.title}` : ''} — ${formatTime(state.resume.position)} in.`,
    } : null,
    upcoming ? `${upcoming.showName} ${upcoming.label}${upcoming.title ? ` · ${upcoming.title}` : ''}` : null,
  );

  const eyebrow = document.createElement('p');
  eyebrow.className = 'eyebrow mono';
  eyebrow.textContent = copy.eyebrow;

  const title = document.createElement('h1');
  title.className = 'welcome__title';
  title.textContent = copy.title;

  const body = document.createElement('p');
  body.className = 'welcome__body';
  body.textContent = copy.body;

  const button = document.createElement('button');
  button.className = 'btn btn--signal';
  button.type = 'button';
  button.textContent = copy.button;
  button.addEventListener('click', () => {
    // Prefer the episode still sitting loaded in the player: it resumes at the
    // exact frame with no reload, where the saved position reloads the file and
    // seeks to wherever the last five-second write happened to land.
    if (canResumeInPlace()) { resumeInPlace(); return; }
    if (resumable) {
      loadAndPlay(
        { ...state.resume, show: resumable.show, episode: resumable.episode, showName: resumable.show.name, label: formatEpisodeLabel(resumable.episode), title: resumable.episode.title },
        state.resume.position,
      );
      return;
    }
    playNext();
  });

  const hint = document.createElement('p');
  hint.className = 'welcome__hint mono';
  hint.textContent = 'Space play/pause · ← → seek · N next · L library · F fullscreen';

  inner.append(eyebrow, title, body, button, hint);
  // Same condition as the button above: whenever it offers to resume, there has
  // to be a way to decline, or the only route to a different episode is Next.
  if (canResumeInPlace() || resumable) {
    const fresh = document.createElement('button');
    fresh.className = 'btn btn--quiet';
    fresh.type = 'button';
    fresh.textContent = 'Skip it, play something else';
    fresh.style.marginLeft = '12px';
    fresh.addEventListener('click', () => { state.resume = null; playNext(); });
    button.after(fresh);
  }
}

function findEpisode(ref) {
  const show = shows.find((s) => s.id === ref.showId);
  if (!show) return null;
  const episode = show.episodes.find((e) => e.relPath === ref.relPath)
    || show.episodes[ref.episodeIndex];
  return episode ? { show, episode } : null;
}

// ---------------------------------------------------------------------------
// library loading
// ---------------------------------------------------------------------------

async function loadLibrary(rootPath) {
  setView('scanning');
  el('scanningPath').textContent = rootPath;

  /**
   * Follow the library if its drive letter changed.
   *
   * An external disk is not promised the same letter twice, so a saved root of
   * `F:\TVandFilms` quietly becomes unreachable when the same disk returns as
   * `I:`. The scan then found nothing and the app fell back to the welcome
   * screen, which looks exactly like it forgot every show — progress was never
   * lost, it just had no library to attach to. Show ids come from folder names
   * and episode anchors are stored relative to the root, so the same folder on
   * another drive lines up with saved progress exactly.
   */
  let scanPath = rootPath;
  if (window.tv.locateLibrary) {
    const found = await window.tv.locateLibrary(rootPath).catch(() => null);
    if (found && found.ok && found.moved) {
      scanPath = found.rootPath;
      el('scanningPath').textContent = scanPath;
      toast(`Your library moved to ${scanPath} — following it. Nothing was lost.`, 6000);
    }
  }

  const result = await window.tv.scan(scanPath);
  if (!result.ok) {
    toast(result.error || 'Could not read that folder.', 5000);
    if (shows.length) { setView('ready'); renderReady(); } else renderWelcome();
    return;
  }

  /**
   * A scan that found nothing must change NOTHING.
   *
   * Below this point the decks are pruned against what was found and the root
   * is repointed — harmless after a real scan, but after an empty one it throws
   * away the schedule and rewrites the saved root to a folder with no shows in
   * it. An empty result is far more often an unplugged drive than an emptied
   * library, and the difference is somebody's place in every series.
   */
  if (!result.shows || result.shows.length === 0) {
    toast(shows.length
      ? 'That folder has no video files in it — keeping the library already loaded.'
      : 'No video files found. If your drive is unplugged, plug it in and press Rescan — nothing has been lost.', 7000);
    if (shows.length) { setView('ready'); renderReady(); } else renderWelcome();
    renderSidebar();
    return;
  }

  shows = result.shows;
  bumperClips = result.bumpers || [];
  promoClips = result.promos || [];
  movieFiles = result.movies || [];
  presentationClips = result.presentations || [];
  state.rootPath = result.rootPath;

  /**
   * A scan is exactly when "anything new?" changes its answer — and it is
   * every scan, so this covers the automatic one at boot, the Rescan button
   * and picking a folder for the first time, without any of them knowing
   * about ingest.
   *
   * NOT awaited. Capturing artwork for a whole new show is real minutes of
   * one-at-a-time disk work, and the library must finish loading and start
   * playing while that happens in the background.
   */
  autoIngest().catch((error) => console.error('artwork capture failed:', error));
  // A scan can mean a different library entirely — cached art from the old
  // one must not paint the new one's cards.
  artworkCache.clear();

  // The decks hold paths from the previous scan; anything no longer present is
  // dropped so a deleted clip is never handed to the player as a missing file.
  const bumperPaths = new Set(bumperClips.map((clip) => clip.relPath));
  state.bumperDeck = (state.bumperDeck || []).filter((relPath) => bumperPaths.has(relPath));
  const promoPaths = new Set(promoClips.map((clip) => clip.relPath));
  state.promoDeck = (state.promoDeck || []).filter((relPath) => promoPaths.has(relPath));
  const moviePaths = new Set(movieFiles.map((movie) => movie.relPath));
  state.movieDeck = (state.movieDeck || []).filter((relPath) => moviePaths.has(relPath));

  // A booked movie whose file this scan did not find would be announced in the
  // schedule and then fail to play. Re-point it at the freshly scanned entry so
  // it carries this scan's absPath and mediaUrl, or drop it.
  if (state.pendingMovie) {
    const still = movieFiles.find((movie) => movie.relPath === state.pendingMovie.relPath);
    state = still
      ? { ...state, pendingMovie: still }
      : clearPendingMovie(state);
  }

  // A marathon pinned to a show that this scan did not find would empty the
  // channel completely — isEnabled matches only that id, so nothing is eligible
  // and the queue silently refills with nothing. Drop it rather than dead-end.
  if (state.settings.marathonShowId && !shows.some((s) => s.id === state.settings.marathonShowId)) {
    state.settings = { ...state.settings, marathonShowId: null };
    toast('The marathon show is no longer in this folder — back to the full rotation.', 5000);
  }

  // (an empty scan already returned above, before anything was changed)

  // Re-anchor saved progress, drop anything stale, then top the schedule up.
  state.cursors = reconcileCursors(shows, state);
  state.queue = pruneQueue(shows, state.queue);
  topUp();

  // Re-evaluated against the library as it stands now: a prerequisite may
  // have been satisfied while the app was closed, or by a rescan that moved a
  // cursor.
  state = earnUnlocks(state, shows, {});

  renderSidebar();
  setView('ready');
  renderReady();
  // Confirmed, not fired and forgotten: this is the write that carries a newly
  // chosen folder and the re-anchored cursors, and everything watched from here
  // is built on top of it.
  await verifySaving('library');

  const { showCount, episodeCount, bumperCount, promoCount, skippedCount } = result.stats;
  /** "1 bumpers" is the kind of detail that makes a app feel unfinished. */
  const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  toast([
    count(showCount, 'show', 'shows'),
    count(episodeCount, 'episode', 'episodes'),
    bumperCount ? count(bumperCount, 'bumper', 'bumpers') : null,
    promoCount ? count(promoCount, 'promo', 'promos') : null,
    result.stats.movieCount ? count(result.stats.movieCount, 'movie', 'movies') : null,
    skippedCount ? `${count(skippedCount, 'file', 'files')} ignored` : null,
  ].filter(Boolean).join(' · '), 4200);

}

async function pickFolder() {
  const picked = await window.tv.pickFolder();
  if (!picked) return;
  await loadLibrary(picked);
}

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// settings modal
// ---------------------------------------------------------------------------

/** Subtitle colours worth having: high contrast, and distinct from each other. */
const CUE_COLORS = [
  ['#ffffff', 'White'],
  ['#ffe066', 'Yellow'],
  ['#8ce0ff', 'Blue'],
  ['#a8f0a0', 'Green'],
  ['#ffb3c6', 'Pink'],
  ['#b9b3c7', 'Grey'],
];

/**
 * Written out in full rather than as var(--grotesque): ::cue lives inside the
 * video element's shadow DOM, and a custom property that fails to resolve there
 * does not error — it silently falls back to the browser's default face, which
 * would look like the font setting simply doing nothing.
 */
const CUE_FONTS = {
  sans: '"Segoe UI Variable Display", "Segoe UI", Inter, system-ui, sans-serif',
  serif: 'Georgia, "Times New Roman", Times, serif',
  mono: '"Cascadia Mono", Consolas, ui-monospace, "SF Mono", Menlo, monospace',
};

/** Current subtitle settings, with every default filled in. */
function cueSettings() {
  return { ...DEFAULT_SETTINGS.subtitles, ...(state.settings.subtitles || {}) };
}

function rgba(hex, alpha) {
  const value = String(hex).replace('#', '');
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Push subtitle appearance onto the RENDERER THAT DRAWS THEM — mpv.
 *
 * The settings object is unchanged; the ::cue stylesheet it used to rewrite
 * is gone with the <video> element. mpv's model is an upgrade underneath:
 * the box is a real border-style mode, image subs render, and ASS tracks
 * deliberately keep their authored look (subStyleProperties documents the
 * mapping and its earned traps). Fire-and-forget: a failed style write must
 * not break playback, and the next settings change re-asserts everything.
 */
function applySubtitleStyle() {
  if (!window.tv.mpvSetSubStyle) return;   // preview harness has no player
  window.tv.mpvSetSubStyle(subStyleProperties(cueSettings())).catch(() => {});
}

/** The sample line in settings, styled the same way the real cues will be. */
function renderCuePreview() {
  const cue = cueSettings();
  const text = el('cuePreviewText');
  text.style.color = cue.color;
  text.style.fontFamily = CUE_FONTS[cue.font] || CUE_FONTS.sans;
  text.style.fontSize = `${Math.round((15 * cue.size) / 100)}px`;
  text.style.backgroundColor = cue.background ? rgba('#000000', cue.backgroundOpacity / 100) : 'transparent';
  text.style.textShadow = cue.background ? 'none' : '0 2px 4px rgba(0,0,0,0.95), 0 0 3px rgba(0,0,0,1)';
  el('cuePreview').dataset.pos = cue.position;
}

function renderCueControls() {
  const cue = cueSettings();

  const swatches = el('cueColors');
  swatches.textContent = '';
  for (const [value, name] of CUE_COLORS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'swatch';
    button.style.background = value;
    button.title = name;
    button.setAttribute('aria-label', name);
    button.setAttribute('aria-pressed', String(cue.color.toLowerCase() === value));
    button.addEventListener('click', () => patchSubtitles({ color: value }));
    swatches.append(button);
  }

  el('cueFont').value = cue.font;
  el('cueSize').value = String(cue.size);
  el('cueSizeOut').textContent = `${cue.size}%`;
  el('cueBackground').checked = Boolean(cue.background);
  el('cueOpacity').value = String(cue.backgroundOpacity);
  el('cueOpacityOut').textContent = `${cue.backgroundOpacity}%`;
  // Opacity of a box that is switched off is not a question worth asking.
  el('cueOpacityField').dataset.muted = String(!cue.background);
  el('cueOpacity').disabled = !cue.background;

  for (const button of el('cuePosition').querySelectorAll('.mode')) {
    button.setAttribute('aria-pressed', String(button.dataset.pos === cue.position));
  }

  renderCuePreview();
}

function patchSubtitles(patch) {
  const next = { ...cueSettings(), ...patch };
  state = applySettings(shows, state, { subtitles: next }, {});
  applySubtitleStyle();
  renderCueControls();
  persist();
}

/**
 * Picture geometry, spoken to mpv.
 *
 * Episodes: the auto-crop. detectCrop's cached, unioned fractions become a
 * video-crop PIXEL BOX against the coded frame, and mpv re-fits the real
 * picture at every window size — the CSS transform this replaces had to
 * re-derive scale and translation from the window on every resize, which is
 * why a resize listener no longer exists here.
 *
 * Interstitials: never cropped (detection belongs to episodes), but they
 * keep her interstitial ZOOM — bars baked into a bumper are not detected,
 * they are zoomed past by hand, and that setting predates the crop.
 */
function applyPicture(isInterstitial) {
  if (!window.tv.mpvSetVideoCrop) return;   // preview harness has no player
  const settings = state.settings || {};

  if (isInterstitial) {
    const zoom = Math.max(100, Number(settings.interstitialZoom) || 100);
    window.tv.mpvSetVideoCrop(null).catch(() => {});
    window.tv.mpvSetVideoZoom(zoom > 100 ? Math.log2(zoom / 100) : 0).catch(() => {});
    return;
  }

  window.tv.mpvSetVideoZoom(0).catch(() => {});
  const crop = settings.autoCrop !== false ? currentCrop : null;
  const spec = crop ? cropSpecFor(crop, player.codedWidth, player.codedHeight) : null;
  window.tv.mpvSetVideoCrop(spec).catch(() => {});
}

/**
 * How long a fresh crop detection waits after an episode starts.
 *
 * The courtesy survives the player swap: detection is one ffprobe plus four
 * ffmpeg sampling passes against the drive the episode is PLAYING from. A
 * KNOWN crop skips the wait entirely — it comes from the cache and touches
 * no tools.
 */
const CROP_DETECT_DELAY_MS = 2000;

async function loadCropForCurrent(immediate = false) {
  currentCrop = null;
  applyPicture(playingBumperClip);

  const absPath = current && current.episode ? current.episode.absPath : null;
  if (!absPath || !window.tv.detectCrop || state.settings.autoCrop === false) return;

  let crop = await window.tv.detectCrop(absPath, { cachedOnly: true }).catch(() => null);
  if (!current || current.episode.absPath !== absPath) return;

  if (!crop) {
    if (!immediate) {
      await new Promise((resolve) => setTimeout(resolve, CROP_DETECT_DELAY_MS));
      if (!current || current.episode.absPath !== absPath) return;
    }
    crop = await window.tv.detectCrop(absPath).catch(() => null);
    if (!current || current.episode.absPath !== absPath) return;
  }

  currentCrop = crop;
  applyPicture(playingBumperClip);
}

/**
 * Push the saved sound settings onto the player and the controls.
 *
 * The element is the source of truth for playback, settings are the source of
 * truth across restarts, and this is the one place they are reconciled — so
 * there is never a moment where the icon says one thing and the audio does
 * another.
 */
/**
 * The speaker is an inline SVG rather than an emoji.
 *
 * An emoji is a colour bitmap in most fonts, so `color` does nothing to it —
 * the glyph arrived in the system's own palette next to an amber slider and
 * could not be made to match. A stroked path inherits currentColor, which is
 * the only way these can be the one accent colour in both states.
 */
const SPEAKER_CONE = '<path d="M4.2 9.4h3.1L11.8 5.6v12.8L7.3 14.6H4.2z" fill="currentColor" />';
const MUTE_ICONS = {
  muted: `${SPEAKER_CONE}<path d="M15.6 9.8l4.6 4.4M20.2 9.8l-4.6 4.4" />`,
  low: `${SPEAKER_CONE}<path d="M15.2 9.9a3 3 0 0 1 0 4.2" />`,
  high: `${SPEAKER_CONE}<path d="M15.2 9.9a3 3 0 0 1 0 4.2" /><path d="M17.9 7.5a6.6 6.6 0 0 1 0 9" />`,
};

/** Only redrawn when the state changes — applyVolume runs on every drag tick. */
let muteIconState = null;
function setMuteIcon(name) {
  if (muteIconState === name) return;
  muteIconState = name;
  el('btnMute').innerHTML =
    '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" '
    + 'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + MUTE_ICONS[name] + '</svg>';
}

function applyVolume() {
  const settings = state.settings || {};
  const level = Math.min(100, Math.max(0, Number(settings.volume) ?? 100));
  const muted = Boolean(settings.muted);

  player.volume = level / 100;
  player.muted = muted;

  // Three states, not two: muted, audible, and turned all the way down — which
  // sounds identical to muted, so it must not look like it is playing.
  const silent = muted || level === 0;
  setMuteIcon(silent ? 'muted' : (level < 50 ? 'low' : 'high'));
  el('btnMute').setAttribute('aria-label', silent ? 'Unmute' : 'Mute');
  el('btnMute').setAttribute('aria-pressed', String(silent));
  el('volume').dataset.silent = String(silent);

  const range = el('volumeRange');
  if (document.activeElement !== range) range.value = String(level);
  range.setAttribute('aria-valuetext', silent ? 'Muted' : `${level}%`);
  // The track is painted from this, not by accent-color: Chromium tints the
  // thumb and leaves the bar itself a flat colour, so "full bar at full
  // volume" has to be drawn. Muted reads as empty rather than as a level,
  // because a bar still showing 70% while nothing can be heard is a lie.
  range.style.setProperty('--fill', `${silent ? 0 : level}%`);
}

const THEMES = [
  // Grouped by colour family, five to a row — the order the menu shows them
  // in. A theme appended to the end lands next to whatever happened to be
  // last, which is how a grey-and-green ended up beside Kawaii.
  'midnight', 'signal', 'foundry', 'siren', 'mono',
  'teletext',
  'slate', 'bone', 'clay', 'arctic', '78',
  'sage',
  'ember', 'searchlight', 'nitrate', 'crimson', 'marigold',
  'wilson', '02', 'bordeaux',
  'greenbox', 'forest', 'mint', 'bench', 'patina',
  'oceanic', 'orbital', 'cobalt',
  '01', 'neon', 'vhs', 'sunset', 'lilac',
  'kawaii', 'iris',
];

/**
 * Names that have been retired, and where they land now.
 *
 * A saved theme that is no longer in THEMES falls back to midnight, which is
 * right for one that was deleted and wrong for one that was merely renamed:
 * picking a palette and finding yourself back on the default is indistinguish-
 * able from the setting not having saved, which is the exact complaint this
 * app has already been through once.
 */
const THEME_ALIASES = { grape: '01', unit02: '02' };

/**
 * Themes whose panels are LIGHT.
 *
 * Adding a palette here is all it takes: applyTheme puts data-light on the
 * root, and the stylesheet hangs everything a light theme needs off that one
 * attribute — inverted type over the picture, outlines on cards that would
 * otherwise be tone on tone.
 */
const LIGHT_THEMES = ['marigold', 'kawaii', 'arctic', 'mint', 'lilac', 'bone', '78', 'clay', 'sage'];

/** The theme actually in force, following any rename, falling back to midnight. */
function resolveTheme(wanted) {
  const name = THEME_ALIASES[wanted] || wanted;
  return THEMES.includes(name) ? name : 'midnight';
}

/**
 * Put the theme on <html>, not on #app.
 *
 * The settings sheet and the play-order table are rendered outside #app, so
 * anchoring the theme there would leave every dialog wearing the old palette.
 */
function applyTheme() {
  const theme = resolveTheme(String((state.settings || {}).theme || 'midnight'));
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.light = String(LIGHT_THEMES.includes(theme));
}


/**
 * Set the two families the whole interface is drawn in.
 *
 * `--display` is the wordmark and headings; `--grotesque` is everything else
 * that is prose. `--mono` is deliberately NOT settable: it carries episode
 * codes, counts and timecodes, where columns lining up is the whole job, and
 * a proportional face there would be a downgrade dressed as a preference.
 *
 * Written as inline custom properties on the root so they beat the :root
 * defaults in the stylesheet while leaving every rule that reads the tokens
 * untouched — the same trick applyUiScale uses for --ui-scale.
 */
function applyFonts() {
  const fonts = (state.settings || {}).fonts || {};
  document.documentElement.style.setProperty('--display', fontStackFor(fonts.display, DEFAULT_FONTS.display));
  document.documentElement.style.setProperty('--grotesque', fontStackFor(fonts.body, DEFAULT_FONTS.body));
}

/** Player text and controls, for people who want them larger than the default. */
function applyUiScale() {
  const scale = Math.min(160, Math.max(80, Number(state.settings.uiScale) || 100));
  app.style.setProperty('--ui-scale', String(scale / 100));
}

/**
 * When the checkpoint was made, and what is in it.
 *
 * Async and therefore separate from renderSettings, which runs on every
 * keystroke of every slider — reading a file that often would be silly.
 */
/**
 * Everything the ingest ledger tracks, in its keying: shows by id, episodes
 * and movies by relPath — the same identities the artwork store uses, so a
 * drive-letter change never makes the library read as new.
 */
function ingestItems() {
  const items = [];
  for (const show of shows) {
    const first = show.episodes[0];
    const preferLanguage = prefFor(show.id).audio || undefined;
    items.push({ kind: 'show', id: show.id, absPath: first ? first.absPath : null });
    for (const episode of show.episodes) {
      // The verdict must be computed under the show's language preference, or
      // a subbed show's episodes are recorded as needing no conversion.
      items.push({
        kind: 'episode', id: episode.relPath, absPath: episode.absPath,
        preferLanguage, size: episode.size,
      });
    }
  }
  for (const movie of movieFiles) {
    items.push({ kind: 'movie', id: movie.relPath, absPath: movie.absPath, size: movie.size });
  }
  return items;
}

/**
 * Is an ingest already in flight? Scans can arrive close together — boot,
 * then a Rescan, then a folder change — and two runs against the same drive
 * is exactly what the pause gate exists to avoid.
 */
let ingesting = false;

/**
 * Check for new titles after a scan, and capture their artwork if there are
 * any. No button, and no asking.
 *
 * Ingest used to be a decision worth putting to the viewer, because it also
 * measured which files needed converting and that could mean minutes of
 * ffmpeg. Conversion is gone; what is left is grabbing a frame per new title
 * for the library cards. That is a chore, not a choice, so the app does it
 * itself — but only when a scan actually turned up something the ledger has
 * not seen, which is what keeps it off the drive the rest of the time.
 *
 * It runs in the BACKGROUND: nothing awaits this, the note reports progress,
 * and ingest.run stands down on its own while anything is playing.
 */
async function autoIngest() {
  const note = el('ingestNote');
  if (!window.tv.ingestStatus || !window.tv.ingestRun) { note.textContent = ''; return; }

  /**
   * Claimed BEFORE the first await, and released in a finally.
   *
   * Checking the flag and then awaiting the status round-trip left a window
   * wide enough for a second scan to walk straight through — boot followed
   * by a Rescan is exactly that — and the loser would then clear the
   * winner's flag on its way out, so a third could start on top of a running
   * one. Two ingests against the same drive is precisely what the pause gate
   * exists to prevent.
   */
  if (ingesting) return;
  ingesting = true;
  try {
    await runIngest(note);
  } finally {
    ingesting = false;
  }
}

/**
 * Write the note WITHOUT starting anything.
 *
 * autoIngest is the only writer of this line, and it only runs off a scan —
 * so with no folder chosen, or a scan that found nothing because the drive is
 * unplugged, the line sat on its HTML placeholder ("Checking for new
 * titles…") forever. A status line that is permanently mid-sentence is worse
 * than no line. Reading the status is a ledger comparison; it touches no
 * media and spawns nothing.
 */
async function refreshIngestNote() {
  const note = el('ingestNote');
  if (!window.tv.ingestStatus) { note.textContent = ''; return; }
  if (ingesting) return;                       // a run is already narrating it
  const status = await window.tv.ingestStatus(ingestItems()).catch(() => null);
  if (!status) { note.textContent = 'Could not check for new titles.'; return; }
  note.textContent = status.newCount === 0
    ? 'Nothing new — artwork is up to date.'
    : 'New titles found — artwork is captured in the background after a scan.';
}

async function runIngest(note) {
  const status = await window.tv.ingestStatus(ingestItems()).catch(() => null);
  if (!status) { note.textContent = 'Could not check for new titles.'; return; }
  if (status.newCount === 0) { note.textContent = 'Nothing new — artwork is up to date.'; return; }

  const bits = [];
  if (status.newShows) bits.push(`${status.newShows} show${status.newShows === 1 ? '' : 's'}`);
  if (status.newEpisodes) bits.push(`${status.newEpisodes} episode${status.newEpisodes === 1 ? '' : 's'}`);
  if (status.newMovies) bits.push(`${status.newMovies} movie${status.newMovies === 1 ? '' : 's'}`);
  note.textContent = `Found ${bits.join(', ')} — capturing artwork…`;

  // The run stands down while anything plays; a note that says so is the
  // difference between patience and a bug report.
  const stopProgress = window.tv.onIngestProgress
    ? window.tv.onIngestProgress(({ done, total, waiting }) => {
      note.textContent = waiting
        ? `Paused while something is playing — ${done} of ${total} done.`
        : `Capturing artwork… ${done} of ${total}.`;
    })
    : null;

  const result = await window.tv.ingestRun(ingestItems()).catch(() => null);
  if (stopProgress) stopProgress();

  if (result && result.busy) return;               // another run had it
  if (!result || result.ok === false) {
    note.textContent = 'Could not capture artwork for the new titles.';
    return;
  }
  // New artwork exists now; cached misses would hide it until a restart.
  artworkCache.clear();
  note.textContent = result.captured
    ? `Artwork captured for ${result.captured} new title${result.captured === 1 ? '' : 's'}.`
    : 'Nothing new — artwork is up to date.';
  // The gallery and the cards are the things the new art actually appears on.
  if (!el('mediaModal').hidden) renderMediaTable();
  renderSidebar();
}

async function renderManualSaveInfo() {
  const note = el('manualSaveNote');
  const info = await window.tv.manualInfo().catch(() => ({ exists: false }));

  el('btnManualLoad').disabled = !info.exists;
  note.textContent = info.exists
    ? `Saved ${new Date(info.savedAt).toLocaleString()} — ${info.shows} shows. Loading it puts every show back where it was then.`
    : 'No saved progress yet. This keeps a copy you can come back to after a skip or a reset.';
}

/**
 * Build the settings nav from the section headings themselves.
 *
 * Reading the headings rather than listing them here means the rail cannot
 * drift out of step with the sheet — a section added, renamed or hidden is
 * reflected without anyone remembering to update a second list. Hidden groups
 * (Movies with no MOVIES folder, Promos with no clips) are skipped, so the rail
 * never offers a destination that is not there.
 */
function renderSettingsNav() {
  const nav = el('setNav');
  const body = el('settingsBody');
  nav.textContent = '';

  const groups = [...body.querySelectorAll('.setgroup')].filter((group) => !group.hidden);

  groups.forEach((group, index) => {
    const heading = group.querySelector('.setgroup__head');
    if (!heading) return;
    if (!group.id) group.id = `setgroup-${index}`;

    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'setnav__item';
    item.textContent = heading.textContent;
    item.dataset.target = group.id;
    item.addEventListener('click', () => {
      group.scrollIntoView({ behavior: 'smooth', block: 'start' });
      markSettingsNav(group.id);
    });
    nav.append(item);
  });

  markSettingsNav(groups.length ? groups[0].id : null);
}

function markSettingsNav(id) {
  for (const item of el('setNav').querySelectorAll('.setnav__item')) {
    item.setAttribute('aria-current', String(item.dataset.target === id));
  }
}

/**
 * Follow the scroll, so the rail says where you ARE rather than only where you
 * last clicked. The topmost section still in the upper half of the sheet wins.
 */
function watchSettingsScroll() {
  const body = el('settingsBody');
  body.addEventListener('scroll', () => {
    // Just below the top edge, not a third of the way down: with a deep
    // threshold the section BELOW the one you jumped to also qualifies, and
    // being later in the list it won — clicking "Interface" lit "Play order".
    const top = body.getBoundingClientRect().top + 24;
    let active = null;
    for (const group of body.querySelectorAll('.setgroup')) {
      if (group.hidden) continue;
      if (group.getBoundingClientRect().top <= top) active = group.id;
    }
    if (active) markSettingsNav(active);
  }, { passive: true });
}

function openSettings() {
  el('settingsModal').hidden = false;
  renderSettings();
  renderSettingsNav();
  renderManualSaveInfo();
  // Not autoIngest: opening a settings sheet must not start disk work.
  refreshIngestNote();
  el('btnCloseSettings').focus();
}

function closeSettings() {
  el('settingsModal').hidden = true;
  el('btnSettings').focus();
}

function settingsOpen() {
  return !el('settingsModal').hidden;
}

// ---------------------------------------------------------------------------
// play order
// ---------------------------------------------------------------------------

/**
 * One row per show and per movie, with its prerequisite editable in place.
 *
 * Rebuilt wholesale on every change rather than patched: the table is at most a
 * few dozen rows, and a partial update is how a row ends up showing an episode
 * picker for a prerequisite that is no longer a show.
 */
/**
 * Which tab the table is on.
 *
 * Shows and films are browsed separately, but the "plays after" list stays
 * WHOLE on both — the whole point is that a film can wait on a series and a
 * series can wait on a film, so filtering the choices to match the tab would
 * remove the cases this feature exists for.
 */
let lockTab = SHOW;

function renderLockTable() {
  const body = el('lockRows');
  const query = el('lockSearch').value.trim().toLowerCase();
  const items = lockableItems(shows, movieFiles);
  const locks = (state.settings.locks) || {};

  for (const tab of el('lockTabs').querySelectorAll('.mode')) {
    tab.setAttribute('aria-pressed', String(tab.dataset.kind === lockTab));
  }

  const onTab = items.filter((item) => item.type === lockTab);
  const matching = query
    ? onTab.filter((item) => item.name.toLowerCase().includes(query))
    : onTab;

  body.textContent = '';
  el('lockEmpty').hidden = matching.length > 0;
  el('lockEmpty').textContent = query
    ? 'Nothing matches that search.'
    : `No ${lockTab === MOVIE ? 'movies' : 'shows'} in this library.`;

  // Counted across BOTH tabs: a rule set on the other one still applies, and a
  // count that changed with the tab would read as rules disappearing.
  const waiting = items.filter((item) => isLocked(item.key, state)).length;
  const rules = Object.keys(locks).length;
  el('lockCount').textContent = rules
    ? `${rules} rule${rules === 1 ? '' : 's'} · ${waiting} waiting`
    : `${matching.length} of ${items.length} titles`;

  for (const item of matching) {
    body.append(lockRow(item, items, locks));
  }
}

function lockRow(item, items, locks) {
  const lock = locks[item.key] || null;
  const tr = document.createElement('tr');
  tr.className = 'lockrow';
  if (isLocked(item.key, state)) tr.classList.add('lockrow--locked');

  // ── title ──
  const title = document.createElement('td');
  const name = document.createElement('span');
  name.className = 'lockrow__name';
  name.textContent = item.name;
  const kind = document.createElement('span');
  kind.className = 'lockrow__kind mono';
  kind.textContent = item.type === MOVIE
    ? (item.year ? `Movie · ${item.year}` : 'Movie')
    : `${item.episodes.length} eps`;
  title.append(name, kind);

  // ── plays after ──
  const afterCell = document.createElement('td');
  const after = document.createElement('select');
  after.className = 'select select--slim';
  after.setAttribute('aria-label', `What must play before ${item.name}`);
  after.append(new Option('Nothing — plays freely', ''));
  for (const other of items) {
    // Itself and anything that already waits on it are left out entirely: a
    // loop can never unlock, and both sides would vanish from the channel with
    // no explanation of why.
    if (other.key === item.key) continue;
    if (wouldCycle(locks, item.key, other.key)) continue;
    const option = new Option(other.name, other.key);
    option.selected = lock && lock.after === other.key;
    after.append(option);
  }
  afterCell.append(after);

  const targetIsShow = lock && lock.after && lock.after.startsWith(`${SHOW}:`);
  const targetShow = targetIsShow
    ? shows.find((s) => `${SHOW}:${s.id}` === lock.after)
    : null;

  // ── whole show ──
  // Only drawn when the prerequisite is a show. A film has no episodes, so a
  // ticked-but-greyed box there is a control answering a question nobody asked
  // — and on a row with no prerequisite at all it means nothing whatsoever.
  const wholeCell = document.createElement('td');
  let whole = null;
  if (targetShow) {
    whole = document.createElement('input');
    whole.type = 'checkbox';
    whole.checked = lock.wholeShow !== false;
    whole.setAttribute('aria-label', `The whole show must play before ${item.name}`);
    wholeCell.append(whole);
  } else {
    wholeCell.classList.add('lockrow--na');
    wholeCell.textContent = '—';
  }

  // ── up to which episode ──
  const epCell = document.createElement('td');
  if (targetShow && lock && lock.wholeShow === false) {
    const picker = document.createElement('select');
    picker.className = 'select select--slim';
    picker.setAttribute('aria-label', `Which episode of ${targetShow.name} must play`);
    targetShow.episodes.forEach((episode, index) => {
      const label = `${formatEpisodeLabel(episode)}${episode.title ? ` · ${episode.title}` : ''}`;
      const option = new Option(label || `Episode ${index + 1}`, String(index));
      option.selected = Number(lock.episodeIndex) === index;
      picker.append(option);
    });
    picker.addEventListener('change', () => {
      applyLock(item.key, { after: lock.after, wholeShow: false, episodeIndex: Number(picker.value) });
    });
    epCell.append(picker);
  } else {
    epCell.classList.add('lockrow--na');
    epCell.textContent = targetShow ? 'The whole show' : '—';
  }

  // ── status ──
  const status = document.createElement('td');
  status.className = 'lockrow__status';
  if (!lock || !lock.after) {
    status.textContent = '';
  } else if (isLocked(item.key, state)) {
    status.textContent = `Waiting for ${lockLabel(item.key, state, shows, movieFiles)}`;
    status.classList.add('is-locked');
  } else {
    status.textContent = 'Unlocked';
    status.classList.add('is-open');
  }

  after.addEventListener('change', () => {
    if (!after.value) { applyLock(item.key, null); return; }
    // Defaults to the whole show, which is the common case and the answer that
    // needs no follow-up question.
    applyLock(item.key, { after: after.value, wholeShow: true, episodeIndex: null });
  });

  if (whole) whole.addEventListener('change', () => {
    if (!lock || !lock.after) return;

    /**
     * Switching off "whole show" defaults to the LAST episode, not the first.
     *
     * The first is almost always already watched, and an unlock is permanent —
     * so defaulting there silently spent the unlock the instant the toggle was
     * clicked, before the viewer had chosen which episode they actually meant.
     * The last episode means the same thing as the whole show, so the default
     * changes nothing until a real choice is made.
     */
    const lastEpisode = Math.max(0, (targetShow ? targetShow.episodes.length : 1) - 1);
    applyLock(item.key, {
      after: lock.after,
      wholeShow: whole.checked,
      episodeIndex: whole.checked
        ? null
        : (Number.isInteger(lock.episodeIndex) ? lock.episodeIndex : lastEpisode),
    });
  });

  tr.append(title, afterCell, wholeCell, epCell, status);
  return tr;
}

/**
 * Write one lock, then re-evaluate: the prerequisite may ALREADY be satisfied,
 * in which case the new rule should unlock immediately rather than hold
 * something back for a condition that was met last week.
 */
function applyLock(key, lock) {
  const before = JSON.stringify(state.settings.locks || {});
  state = { ...state, settings: setLock(state.settings, key, lock) };

  if (JSON.stringify(state.settings.locks || {}) === before && lock && lock.after) {
    toast('That would make two titles wait for each other.', 3600);
    renderLockTable();
    return;
  }

  state = earnUnlocks(state, shows, {});
  // Evicts anything the new rule forbids AND tops the queue back up; a lock
  // that only applies to future refills looks broken for the next few turns.
  state = applyLocksToQueue(shows, state, {});
  persist();
  renderLockTable();
  renderSidebar();
}

/**
 * Turn any newly satisfied prerequisite into a permanent unlock.
 *
 * Called wherever progress moves. When something does unlock, the committed
 * queue is rebuilt as well: every refill up to now skipped that show, so
 * nothing would ever pick it up on its own.
 */
function refreshLocks() {
  const before = state;
  state = earnUnlocks(state, shows, {});
  if (state === before) return false;

  state = applyLocksToQueue(shows, state, {});
  renderSidebar();
  if (locksOpen()) renderLockTable();
  return true;
}

function renderLockSummary() {
  const items = lockableItems(shows, movieFiles);
  const rules = Object.keys(state.settings.locks || {}).length;
  const waiting = items.filter((item) => isLocked(item.key, state)).length;

  el('lockSummary').textContent = rules
    ? `${rules} rule${rules === 1 ? '' : 's'} set · ${waiting} title${waiting === 1 ? '' : 's'} still waiting. Marathon and the ▶ button ignore locks.`
    : 'Hold a sequel back until the film or series before it has played.';
}

// ---------------------------------------------------------------------------
// set schedules
// ---------------------------------------------------------------------------

/**
 * The schedule being EDITED, which is not necessarily the one running.
 *
 * Kept apart deliberately: opening the window to rearrange next week's running
 * order must not change what is on screen now. Nothing reaches the channel
 * until "Save & use".
 */
let editingId = null;
let draft = null;            // { id, name, blockSize, items: [showId] }
let dragFrom = null;         // { source: 'order'|'pool', index, showId }

const savedSchedules = () => (state.settings.schedules || []);

/** Ids are only ever compared, never parsed — uniqueness is the whole job. */
function newScheduleId() {
  return `sched-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function blankSchedule() {
  return {
    id: newScheduleId(),
    name: `Schedule ${savedSchedules().length + 1}`,
    blockSize: Math.max(1, Number(state.settings.blockSize) || 2),
    items: [],
  };
}

/** Load one saved schedule into the editor, or start a fresh blank one. */
function loadDraft(id) {
  const found = savedSchedules().find((sc) => sc.id === id);
  draft = found
    ? { ...found, items: [...(found.items || [])] }   // a copy: the editor mutates
    : blankSchedule();
  editingId = draft.id;
}

/**
 * Write the draft back into settings.
 *
 * `activate` is separate from saving because they are different intentions:
 * editing a schedule you are not currently running must not hijack the channel.
 * applySettings rebuilds the queue whenever `schedules` changes, so the running
 * one updates in place either way.
 */
function commitDraft({ activate = false } = {}) {
  if (!draft) return;
  draft.name = (el('schedName').value || '').trim() || 'Untitled schedule';
  draft.blockSize = Math.min(12, Math.max(1, Number(el('schedBlock').value) || 1));

  const rest = savedSchedules().filter((sc) => sc.id !== draft.id);
  const schedules = [...rest, { ...draft, items: [...draft.items] }]
    .sort((a, b) => a.name.localeCompare(b.name));

  const patch = { schedules };
  if (activate) {
    patch.activeScheduleId = draft.id;
    // A schedule and a marathon cannot both decide the order. Choosing one is
    // choosing against the other.
    patch.marathonShowId = null;
  }
  state = applySettings(shows, state, patch, {});
  persist();
  renderSidebar();
}

function openSchedule() {
  if (!draft || !savedSchedules().some((sc) => sc.id === editingId)) {
    // Prefer the one already running, so the window opens on what you can see.
    const running = activeSchedule(state.settings);
    if (running) loadDraft(running.id);
    else if (savedSchedules().length) loadDraft(savedSchedules()[0].id);
    else loadDraft(null);
  }
  el('scheduleModal').hidden = false;
  renderScheduleEditor();
}

function closeSchedule() {
  el('scheduleModal').hidden = true;
}

function scheduleOpen() {
  return !el('scheduleModal').hidden;
}

function renderScheduleEditor() {
  if (!draft) return;

  const pick = el('schedPick');
  pick.textContent = '';
  for (const sc of savedSchedules()) {
    const option = document.createElement('option');
    option.value = sc.id;
    option.textContent = sc.name;
    pick.append(option);
  }
  // An unsaved draft is offered as itself, so the picker never reads as empty
  // or, worse, as some OTHER schedule while you are editing this one.
  if (!savedSchedules().some((sc) => sc.id === draft.id)) {
    const option = document.createElement('option');
    option.value = draft.id;
    option.textContent = `${draft.name} (unsaved)`;
    pick.append(option);
  }
  pick.value = draft.id;

  el('schedName').value = draft.name;
  el('schedBlock').value = String(draft.blockSize);
  el('schedDelete').disabled = !savedSchedules().some((sc) => sc.id === draft.id);

  renderSchedOrder();
  renderSchedPool();

  const running = activeSchedule(state.settings);
  el('schedStatus').textContent = running
    ? (running.id === draft.id ? 'Running now.' : `Running: ${running.name}`)
    : 'No schedule running — the channel is shuffling.';
}

/** One card. `source` decides what dragging it means. */
function scheduleCard(show, source, index) {
  const li = document.createElement('li');
  li.className = 'setsched__card';
  li.draggable = true;
  li.tabIndex = 0;

  if (source === 'order') {
    const pos = document.createElement('span');
    pos.className = 'setsched__pos';
    pos.textContent = String(index + 1).padStart(2, '0');
    li.append(pos);
  }

  const name = document.createElement('span');
  name.className = 'setsched__name';
  name.textContent = show.name;
  li.append(name);

  if (source === 'order') {
    const eps = document.createElement('span');
    eps.className = 'setsched__eps';
    eps.textContent = `${draft.blockSize} ep${draft.blockSize === 1 ? '' : 's'}`;
    li.append(eps);

    const drop = document.createElement('button');
    drop.className = 'setsched__drop';
    drop.type = 'button';
    drop.textContent = '✕';
    drop.setAttribute('aria-label', `Remove ${show.name} from position ${index + 1}`);
    drop.addEventListener('click', (event) => {
      event.stopPropagation();
      draft.items.splice(index, 1);
      renderScheduleEditor();
    });
    li.append(drop);
  } else {
    /**
     * Click and keyboard both add to the end of the running order.
     *
     * Dragging is the point of the two columns, but it cannot be done without a
     * pointer and it is slow when you want the same show four times. A plain
     * click doing the obvious thing costs nothing and makes the feature usable
     * without a mouse at all.
     */
    const add = () => {
      draft.items.push(show.id);
      renderScheduleEditor();
    };
    li.addEventListener('click', add);
    li.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      add();
    });
  }

  wireCardDrag(li, source, index, show.id);
  return li;
}

function renderSchedOrder() {
  const list = el('schedOrder');
  list.textContent = '';
  const byId = new Map(shows.map((s) => [s.id, s]));

  // A show can leave the folder while a schedule still names it. Drop those
  // rather than rendering a card with no title behind it.
  draft.items = draft.items.filter((id) => byId.has(id));

  draft.items.forEach((id, index) => {
    list.append(scheduleCard(byId.get(id), 'order', index));
  });

  el('schedEmpty').hidden = draft.items.length > 0;
  const blocks = draft.items.length;
  el('schedCount').textContent = blocks
    ? `${blocks} block${blocks === 1 ? '' : 's'} · ${blocks * draft.blockSize} episodes`
    : '';
}

function renderSchedPool() {
  const list = el('schedPool');
  list.textContent = '';
  for (const show of shows) list.append(scheduleCard(show, 'pool'));
  el('schedPoolCount').textContent = shows.length ? String(shows.length) : '';
}

/** Drag handlers shared by both columns. */
function wireCardDrag(li, source, index, showId) {
  li.addEventListener('dragstart', (event) => {
    dragFrom = { source, index, showId };
    li.dataset.dragging = 'true';
    event.dataTransfer.effectAllowed = 'move';
    // Firefox refuses to begin a drag with nothing on the transfer.
    event.dataTransfer.setData('text/plain', showId);
  });
  li.addEventListener('dragend', () => {
    delete li.dataset.dragging;
    dragFrom = null;
    clearDropMarks();
  });

  if (source !== 'order') return;

  li.addEventListener('dragover', (event) => {
    if (!dragFrom) return;
    event.preventDefault();
    const box = li.getBoundingClientRect();
    clearDropMarks();
    li.dataset.drop = event.clientY < box.top + box.height / 2 ? 'before' : 'after';
  });
  li.addEventListener('drop', (event) => {
    if (!dragFrom) return;
    event.preventDefault();
    event.stopPropagation();     // the column's own handler must not also fire
    const box = li.getBoundingClientRect();
    const before = event.clientY < box.top + box.height / 2;
    let target = index + (before ? 0 : 1);
    if (dragFrom.source === 'order') {
      // Remove FIRST, then correct the target: after the splice every index
      // above the one removed has shifted down by one, and dropping an item
      // below its old position would otherwise land one place too far.
      const [moved] = draft.items.splice(dragFrom.index, 1);
      if (dragFrom.index < target) target -= 1;
      draft.items.splice(target, 0, moved);
    } else {
      draft.items.splice(target, 0, dragFrom.showId);
    }
    dragFrom = null;
    renderScheduleEditor();
  });
}

function clearDropMarks() {
  for (const node of document.querySelectorAll('.setsched__card[data-drop]')) delete node.dataset.drop;
}

/** The columns themselves are targets, so an EMPTY list still accepts a drop. */
function wireColumnDrops() {
  const order = el('schedOrder');
  order.addEventListener('dragover', (event) => {
    if (!dragFrom) return;
    event.preventDefault();
    order.dataset.over = 'true';
  });
  order.addEventListener('dragleave', () => { delete order.dataset.over; });
  order.addEventListener('drop', (event) => {
    delete order.dataset.over;
    if (!dragFrom) return;
    event.preventDefault();
    // Landing on the container rather than on a card means "the end".
    if (dragFrom.source === 'pool') draft.items.push(dragFrom.showId);
    else {
      const [moved] = draft.items.splice(dragFrom.index, 1);
      draft.items.push(moved);
    }
    dragFrom = null;
    renderScheduleEditor();
  });

  // Dragging a card back to the pool removes it — the mirror of dragging in.
  const pool = el('schedPool');
  pool.addEventListener('dragover', (event) => {
    if (!dragFrom || dragFrom.source !== 'order') return;
    event.preventDefault();
    pool.dataset.over = 'true';
  });
  pool.addEventListener('dragleave', () => { delete pool.dataset.over; });
  pool.addEventListener('drop', (event) => {
    delete pool.dataset.over;
    if (!dragFrom || dragFrom.source !== 'order') return;
    event.preventDefault();
    draft.items.splice(dragFrom.index, 1);
    dragFrom = null;
    renderScheduleEditor();
  });
}

// ---------------------------------------------------------------------------
// the library table
// ---------------------------------------------------------------------------

/**
 * Everything the table needs, fetched once per open: the ingest ledger and a
 * has-artwork boolean per title. No file is ever probed from here — a title
 * the ingest has not judged says "not checked", which is the honest answer
 * and also the pointer back to the Ingest button.
 */
let mediaKind = 'show';
let mediaData = null;   // { art: Map('kind\nid' -> bool) }

async function openMedia() {
  el('mediaModal').hidden = false;
  el('mediaSearch').value = '';
  mediaData = null;
  renderMediaTable();          // paints the "loading" shell immediately

  const items = ingestItems();
  /**
   * Artwork only.
   *
   * The ingest LEDGER was fetched alongside this, for one purpose: telling
   * the table whether each title needed converting. Nothing converts, that
   * column is gone, and the read went with it — along with the only reason
   * this window ever waited on two round trips instead of one.
   */
  const flags = await window.tv.artworkStats(items).catch(() => []);
  if (el('mediaModal').hidden) return;   // closed while loading

  const art = new Map();
  items.forEach((item, i) => art.set(`${item.kind}\n${item.id}`, Boolean(flags[i])));
  mediaData = { art };
  renderMediaTable();
  el('mediaSearch').focus();
}

function closeMedia() {
  el('mediaModal').hidden = true;
  // The popover floats OVER this sheet rather than inside it, so hiding the
  // sheet leaves it on screen and still writing to state. Closing from the
  // keyboard produces a click with no mousedown, so the outside-click guard
  // never fires — this is the only thing that catches that path.
  closeTagPop();
  mediaData = null;
}

function mediaOpen() {
  return !el('mediaModal').hidden;
}

const hasArt = (kind, id) => Boolean(mediaData && mediaData.art.get(`${kind}\n${id}`));

function artCell(present, label) {
  const td = document.createElement('td');
  td.className = 'mediarow__art';
  td.textContent = label !== undefined ? label : (present ? '✓' : '—');
  return td;
}

/* --- genre tags ----------------------------------------------------------- */

/**
 * One title's genres, as a cell you click to edit.
 *
 * The whole cell is the target, not a button beside the chips (Fitts) — and
 * an untagged title still needs something to aim at, which is what the em
 * dash is for. Chips are rendered by the same builder the popover uses, so
 * the cell and the editor can never drift apart.
 */
function genreCell(kind, id, label) {
  const td = document.createElement('td');
  td.className = 'mediarow__genres';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'genrecell';
  button.setAttribute('aria-haspopup', 'dialog');
  paintGenreCell(button, kind, id);

  // Stamped so the cell can be found again after the table rebuilds — see
  // liveGenreCell.
  button.dataset.genreKind = kind;
  button.dataset.genreId = id;

  button.addEventListener('click', () => openTagPop(button, kind, id, label));
  td.append(button);
  return td;
}

/**
 * Find the cell for a title in the table as it stands NOW.
 *
 * renderMediaTable wipes #mediaRows and rebuilds every row, so any button
 * captured before it ran is a detached node. Painting one is completely
 * silent — the store is correct, the save has happened, the popover's own
 * chips update — and the row inches away simply stops changing, which reads
 * exactly like tags not saving.
 *
 * Matched by walking the cells rather than by a CSS attribute selector: a
 * movie's id is a relative path and can contain quotes and brackets that
 * would need escaping into a selector, and getting that wrong is another
 * silent miss.
 */
function liveGenreCell(kind, id) {
  return [...el('mediaRows').querySelectorAll('.genrecell')]
    .find((cell) => cell.dataset.genreKind === kind && cell.dataset.genreId === id) || null;
}

/** Repaint a cell in place, so setting tags never re-renders the whole table. */
function paintGenreCell(button, kind, id) {
  button.textContent = '';
  const tags = tagsFor(state, kind, id);
  button.setAttribute('aria-label', tags.length
    ? `Genres: ${tags.join(', ')}. Edit.`
    : 'Add genres');
  if (!tags.length) {
    const empty = document.createElement('span');
    empty.className = 'genrecell__empty';
    empty.textContent = '—';
    button.append(empty);
    return;
  }
  for (const tag of tags) button.append(chipFor(tag));
}

/**
 * A tag chip.
 *
 * Deliberately ONE look for every tag, with no per-genre colour.
 *
 * Notion and Airtable give each option its own hue, and it is genuinely good
 * for scanning — but this app is three inks by design, it ships twelve themes
 * including four light ones and one (02) whose whole identity is black hairs
 * between panels, and a generated palette would have to survive all of them.
 * The alternatives were a user-picked colour per tag, which is a colour
 * picker nobody asked for, or an auto-assigned hue, which is arbitrary and
 * clashes somewhere. So tags are told apart by their WORD, which is the thing
 * that actually carries the meaning, and they all look alike because they all
 * ARE alike (Law of Similarity). The signal colour stays reserved for what it
 * already means here: this one is selected.
 */
function chipFor(tag) {
  const chip = document.createElement('span');
  chip.className = 'chip';
  chip.textContent = tag;
  return chip;
}

/* --- the tag picker ------------------------------------------------------- */

/** What the popover is editing, or null when it is closed. */
let tagPopTarget = null;
/** The row button it was opened from, repainted in place when tags change. */
let tagPopAnchor = null;
/** Index of the highlighted row, for arrow keys and Enter. */
let tagPopActive = 0;

function tagPopOpen() {
  return !el('tagPop').hidden;
}

/**
 * Open under the cell that was clicked, flipping up when there is no room.
 *
 * Fixed positioning rather than absolute: the table scrolls inside
 * .modal__body, and an absolutely positioned popover inside a scroll
 * container is clipped by it — the classic version of this bug, where the
 * menu simply cannot be seen for rows near the bottom.
 */
function openTagPop(anchor, kind, id, label) {
  tagPopTarget = { kind, id, label };
  tagPopAnchor = anchor;
  tagPopActive = 0;

  const pop = el('tagPop');
  pop.hidden = false;
  el('tagPopInput').value = '';
  renderTagPop();

  positionTagPop();
  el('tagPopInput').focus();
}

/**
 * Put the popover under its row, flipping above when there is no room below.
 *
 * Re-run on scroll and resize, not just on open. position:fixed escapes the
 * table's scroll clipping, but it also means the popover stays nailed to the
 * viewport while the row it is editing travels away underneath — so it ended
 * up captioning an unrelated title while still writing to the original one.
 * With 32 shows the table always scrolls, so this was not an edge case.
 */
function positionTagPop() {
  if (!tagPopOpen() || !tagPopAnchor) return;

  /**
   * A DETACHED anchor first, before anything reads geometry off it.
   *
   * This was a regression the first time round. A detached node has no
   * ancestors, so `closest('.modal__body')` returns null and the scrollport
   * check below was skipped in exactly the state it exists for; execution
   * then fell through to the maths with an all-zero rect, and the popover
   * teleported to the top-left corner of the window and stayed there, still
   * writing to the original title. Measured: closest() null, rect 0,0,0,0,
   * computed position 12,6.
   *
   * Recover if the row is still in the table under a rebuilt node; close if
   * it is genuinely gone.
   */
  if (!tagPopAnchor.isConnected) {
    tagPopAnchor = tagPopTarget ? liveGenreCell(tagPopTarget.kind, tagPopTarget.id) : null;
    if (!tagPopAnchor) { closeTagPop(); return; }
  }

  const pop = el('tagPop');
  const box = tagPopAnchor.getBoundingClientRect();

  /**
   * Scrolled out of its own scrollport: close rather than follow.
   *
   * Following would pin the popover to the edge of the screen with nothing
   * under it, which is a menu pointing at nothing. The scrollport, not the
   * window — a row hidden behind the modal's own overflow is gone as far as
   * the person is concerned even though it is still inside the viewport.
   *
   * Measured from the sticky HEADER's bottom edge, not the scrollport's top.
   * `.locktable th` is position:sticky and 33px tall, so the top band of the
   * scrollport is permanently covered — a row fully hidden behind the column
   * headings is out of sight while still, on paper, inside the box.
   */
  const scroller = tagPopAnchor.closest('.modal__body');
  if (scroller) {
    const view = scroller.getBoundingClientRect();
    /**
     * The TH, not the THEAD. `position: sticky` is on the cells
     * (styles.css .locktable th), so the thead's own rect scrolls away with
     * the flow while the cells stay pinned — measuring the thead made
     * Math.max collapse straight back to view.top and the guard did nothing
     * at all. Caught by the probe, which is the only reason it is not still
     * sitting here looking like a fix.
     */
    const head = scroller.querySelector('th');
    const topEdge = head ? Math.max(view.top, head.getBoundingClientRect().bottom) : view.top;
    if (box.bottom < topEdge + 4 || box.top > view.bottom - 4) { closeTagPop(); return; }
  }

  const height = pop.offsetHeight;
  const below = window.innerHeight - box.bottom - 12;
  pop.style.left = `${Math.max(12, Math.min(box.left, window.innerWidth - pop.offsetWidth - 12))}px`;
  pop.style.top = below >= height
    ? `${box.bottom + 6}px`
    : `${Math.max(12, box.top - height - 6)}px`;
}

function closeTagPop() {
  el('tagPop').hidden = true;
  tagPopTarget = null;
  tagPopAnchor = null;
}

/** Write a title's tags, repaint everything that shows them, and save. */
function setTagsFor(kind, id, list) {
  state.tags = withTags(state, kind, id, list);
  persist();
  /**
   * Re-acquired whenever the held node has left the document, so a table
   * rebuild underneath an open popover cannot quietly stop the row updating.
   *
   * And if it cannot be found at all, CLOSE. A null anchor used to mean "skip
   * the paint", which is the same silent failure by another route — the row
   * is not on screen (the tab was switched, the search narrowed it away), so
   * the popover is editing something nobody can see.
   */
  if (!tagPopAnchor || !tagPopAnchor.isConnected) tagPopAnchor = liveGenreCell(kind, id);
  if (!tagPopAnchor) { closeTagPop(); return; }
  paintGenreCell(tagPopAnchor, kind, id);
  renderGenreFilter();
  if (browseOpen()) renderBrowse();
}

function renderTagPop() {
  if (!tagPopTarget) return;
  const { kind, id } = tagPopTarget;
  const current = tagsFor(state, kind, id);
  const typed = cleanTag(el('tagPopInput').value);

  // --- the chips already on this title, each removable
  const chips = el('tagPopChips');
  chips.textContent = '';
  if (!current.length) {
    const none = document.createElement('span');
    none.className = 'tagpop__none';
    none.textContent = 'No genres yet';
    chips.append(none);
  }
  for (const tag of current) {
    const chip = chipFor(tag);
    chip.classList.add('chip--removable');
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'chip__x';
    x.setAttribute('aria-label', `Remove ${tag}`);
    x.textContent = '✕';
    x.addEventListener('click', (event) => {
      event.stopPropagation();
      setTagsFor(kind, id, current.filter((entry) => keyFor(entry) !== keyFor(tag)));
      renderTagPop();
      // renderTagPop destroys the button that was just clicked, dropping
      // focus to <body> — which silently kills arrows, Enter and Backspace
      // for the rest of the session. Every path that re-renders must put it
      // back on the field.
      el('tagPopInput').focus();
    });
    chip.append(x);
    chips.append(chip);
  }

  // --- the options, narrowed by whatever has been typed
  const list = el('tagPopList');
  list.textContent = '';

  // Both predicates live in src/shared/genres.js so the suite can pin the
  // SHIPPED behaviour rather than a copy of it that drifts.
  const vocabulary = allTags(state);
  const matches = narrowTags(vocabulary, typed);

  const rows = [];
  for (const tag of matches) {
    const on = hasTag(current, tag);
    const row = document.createElement('div');
    row.className = 'tagopt';
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(on));
    row.dataset.on = String(on);

    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'tagopt__pick';
    name.textContent = tag;
    name.addEventListener('click', () => {
      setTagsFor(kind, id, on
        ? current.filter((entry) => keyFor(entry) !== keyFor(tag))
        : [...current, tag]);
      renderTagPop();
      el('tagPopInput').focus();      // see the chip ✕ handler above
    });

    /**
     * Deleting a genre is a library-wide act, not a row-level one, so it
     * says how many titles it will strip it from before doing it. window
     * .confirm is the house pattern for this (three other sites use it) and
     * a bare `confirm` would fail the free-identifier suite.
     */
    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'tagopt__drop';
    drop.setAttribute('aria-label', `Delete the ${tag} genre everywhere`);
    drop.textContent = '✕';
    drop.addEventListener('click', (event) => {
      event.stopPropagation();
      const used = countTagged(state, shows, movieFiles, tag);
      const warning = used
        ? `Delete the "${tag}" genre? It will be removed from ${used} title${used === 1 ? '' : 's'}.`
        : `Delete the "${tag}" genre?`;
      if (!window.confirm(warning)) return;
      state.tags = withoutTag(state, tag);
      persist();
      renderGenreFilter();
      // The whole table is rebuilt — every row could have carried this tag —
      // so the anchor must be re-acquired AFTER it, not painted before it.
      renderMediaTable();
      tagPopAnchor = liveGenreCell(kind, id);
      if (tagPopAnchor) paintGenreCell(tagPopAnchor, kind, id);
      if (browseOpen()) renderBrowse();
      renderTagPop();
      el('tagPopInput').focus();
    });

    row.append(name, drop);
    rows.push(row);
    list.append(row);
  }

  // The create row, last, and only for something genuinely new AND storable.
  if (offersCreate(vocabulary, typed)) {
    const row = document.createElement('div');
    row.className = 'tagopt tagopt--create';
    const make = document.createElement('button');
    make.type = 'button';
    make.className = 'tagopt__pick';
    make.textContent = `Create "${typed}"`;
    make.addEventListener('click', () => {
      state.tags = withCustomTag(state, typed);
      setTagsFor(kind, id, [...current, typed]);
      el('tagPopInput').value = '';
      renderTagPop();
      el('tagPopInput').focus();
    });
    row.append(make);
    rows.push(row);
    list.append(row);
  }

  /**
   * The hint has to be true for the reason the list is empty.
   *
   * "Type a new name to create it" was advice that could not be followed
   * whenever the reason was that the name has no key — typing more of it
   * keeps producing nothing. Now the only way to an empty list is a tag with
   * no letters or digits at all, and it says so.
   */
  const hint = el('tagPopHint');
  if (typed && !keyFor(typed)) {
    hint.textContent = 'A genre needs at least one letter or number.';
    hint.hidden = false;
  } else if (!rows.length) {
    hint.textContent = 'Nothing matches. Type a new name to create it.';
    hint.hidden = false;
  } else {
    hint.hidden = true;
  }

  tagPopActive = Math.max(0, Math.min(tagPopActive, rows.length - 1));
  rows.forEach((row, index) => {
    row.dataset.active = String(index === tagPopActive);
  });

  /**
   * Re-anchor, because THIS is what changes the popover's height.
   *
   * Positioning was hooked to scroll and resize and not to the render that
   * actually resizes it. Every keystroke, chip toggle, chip removal and
   * genre deletion rebuilds the option list — and in the flip-above branch
   * the top edge is computed FROM the height, so the popover drifts away
   * from its row while sitting perfectly still. Measured at 178px adrift.
   */
  positionTagPop();
}

/** Enter picks, arrows move, Escape closes, Backspace on empty removes. */
function tagPopKeydown(event) {
  const rows = [...el('tagPopList').querySelectorAll('.tagopt')];
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (!rows.length) return;
    tagPopActive = (tagPopActive + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length;
    renderTagPop();
    const row = el('tagPopList').querySelectorAll('.tagopt')[tagPopActive];
    if (row) row.scrollIntoView({ block: 'nearest' });
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    const row = rows[tagPopActive];
    const pick = row && row.querySelector('.tagopt__pick');
    if (pick) pick.click();
    return;
  }
  if (event.key === 'Backspace' && !el('tagPopInput').value && tagPopTarget) {
    // The standard gesture: an empty field plus Backspace peels the last chip.
    const current = tagsFor(state, tagPopTarget.kind, tagPopTarget.id);
    if (!current.length) return;
    event.preventDefault();
    setTagsFor(tagPopTarget.kind, tagPopTarget.id, current.slice(0, -1));
    renderTagPop();
  }
}

function renderMediaTable() {
  const head = el('mediaHead');
  const rows = el('mediaRows');
  head.textContent = '';
  rows.textContent = '';

  const th = (label) => {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = label;
    head.append(cell);
  };

  for (const button of el('mediaTabs').querySelectorAll('.mode')) {
    button.setAttribute('aria-pressed', String(button.dataset.kind === mediaKind));
  }

  if (!mediaData) {
    th('Title');
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.className = 'mediarow__unknown';
    td.textContent = 'Reading the ledger…';
    tr.append(td);
    rows.append(tr);
    el('mediaEmpty').hidden = true;
    el('mediaCount').textContent = '';
    return;
  }

  const query = el('mediaSearch').value.trim().toLowerCase();
  let shown = 0;

  /**
   * The header list is the single source of truth for the column count.
   *
   * The expanded episode row spans the whole table, and its colSpan used to
   * be a hand-written number — which is a value that must be edited every
   * time a column is added and gives no sign when it was not. Adding the
   * Card image column already broke it once.
   */
  let columnCount = 0;
  const header = (labels) => { columnCount = labels.length; labels.forEach(th); };

  if (mediaKind === 'show') {
    header(['Title', 'Episodes', 'Genres', 'Artwork', 'Card image', 'Details']);

    for (const show of shows) {
      if (query && !show.name.toLowerCase().includes(query)) continue;
      shown += 1;

      const artCount = show.episodes.reduce(
        (n, e) => n + (hasArt('episode', e.relPath) ? 1 : 0), 0,
      );

      const tr = document.createElement('tr');
      const name = document.createElement('td');
      name.className = 'mediarow__name';
      name.textContent = show.name;
      const eps = document.createElement('td');
      eps.className = 'mediarow__meta';
      eps.textContent = String(show.episodes.length);

      const genres = genreCell('show', show.id, show.name);

      const art = artCell(hasArt('show', show.id),
        `${hasArt('show', show.id) ? '✓ card' : '— card'} · ${artCount}/${show.episodes.length} eps`);

      const setTd = document.createElement('td');
      const set = document.createElement('button');
      set.type = 'button';
      set.className = 'btn btn--quiet';
      set.textContent = 'Set image…';
      set.addEventListener('click', () => {
        openArtPicker('show', show.id, show.name, () => {
          // The cell also carries the per-episode tally, so only the card half
          // of its label is the part this just changed.
          art.textContent = `✓ card · ${artCount}/${show.episodes.length} eps`;
          if (browseOpen()) renderBrowse();
        });
      });
      setTd.append(set);

      const detailTd = document.createElement('td');
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'btn btn--quiet';
      toggle.textContent = 'Episodes';
      detailTd.append(toggle);

      tr.append(name, eps, genres, art, setTd, detailTd);
      rows.append(tr);

      /**
       * Details expand IN PLACE, built only when asked for: thirty shows'
       * worth of episode rows up front is a wall; one show's on request is
       * an answer.
       */
      let detailRow = null;
      toggle.addEventListener('click', () => {
        if (detailRow) {
          detailRow.remove();
          detailRow = null;
          toggle.textContent = 'Episodes';
          return;
        }
        detailRow = document.createElement('tr');
        detailRow.className = 'mediarow--detail';
        const cell = document.createElement('td');
        cell.colSpan = columnCount;
        const list = document.createElement('ul');
        list.className = 'mediaeps';
        for (const episode of show.episodes) {
          const li = document.createElement('li');
          const label = document.createElement('span');
          label.className = 'mono';
          label.textContent = formatEpisodeLabel(episode);
          const tick = document.createElement('span');
          tick.className = 'mediarow__art';
          tick.textContent = hasArt('episode', episode.relPath) ? '✓' : '—';
          li.append(label, tick);
          list.append(li);
        }
        cell.append(list);
        detailRow.append(cell);
        tr.after(detailRow);
        toggle.textContent = 'Hide';
      });
    }
  } else {
    header(['Title', 'Genres', 'Artwork', 'Card image']);

    for (const movie of movieFiles) {
      if (query && !movie.name.toLowerCase().includes(query)) continue;
      shown += 1;

      const tr = document.createElement('tr');
      const name = document.createElement('td');
      name.className = 'mediarow__name';
      name.textContent = movie.name;

      const genres = genreCell('movie', movie.relPath, movie.name);

      const art = artCell(hasArt('movie', movie.relPath));

      const setTd = document.createElement('td');
      const set = document.createElement('button');
      set.type = 'button';
      set.className = 'btn btn--quiet';
      set.textContent = 'Set image…';
      set.addEventListener('click', () => {
        openArtPicker('movie', movie.relPath, movie.name, () => { art.textContent = '✓'; });
      });
      setTd.append(set);

      tr.append(name, genres, art, setTd);
      rows.append(tr);
    }
  }

  el('mediaEmpty').hidden = shown > 0;
  el('mediaCount').textContent = shown
    ? `${shown} title${shown === 1 ? '' : 's'}`
    : '';
}

// ---------------------------------------------------------------------------
// per-show settings
// ---------------------------------------------------------------------------

/** The show whose settings dialog is on screen. */
let showSetShow = null;

/**
 * This show's saved playback preferences, or an empty object.
 *
 * Lost in the switchover: it sat inside the conversion-era block that the
 * mpv commit deleted wholesale (the wanted-audio cache, the preference
 * generation counter), and went out with it while its FOUR callers stayed —
 * the load-time preference pass, the ingest ledger, and both halves of the
 * per-show settings dialog. Every one of them threw a ReferenceError on
 * every use, and the two that matter most were swallowed by unawaited
 * promises: the track menus opened empty, the show's language preference
 * never applied, and the auto-crop never ran, in silence.
 *
 * The bundler cannot see this either — a free identifier is a legal
 * reference to a global that might exist, so esbuild emits it without a
 * word. test/freeIdentifiers.test.js is what catches it now.
 */
function prefFor(showId) {
  return (state.settings.showPrefs || {})[showId] || {};
}

function openShowSettings(show) {
  if (!show) return;
  showSetShow = show;
  const pref = prefFor(show.id);
  el('showSetTitle').textContent = show.name;
  el('showSetAudio').value = pref.audio || '';
  el('showSetSubs').value = pref.subs || '';
  el('showSetNote').textContent =
    'Audio and subtitles switch instantly — the preference applies to the episode on screen too.';
  el('showSetModal').hidden = false;
  el('showSetAudio').focus();
}

function closeShowSettings() {
  el('showSetModal').hidden = true;
  showSetShow = null;
}

function showSetOpen() {
  return !el('showSetModal').hidden;
}

/* --- the card image picker ------------------------------------------------ */

/**
 * What the picker is setting, and who to tell when it lands.
 *
 * Two places open this — a row in the library table and a show's own settings
 * — and each has a different thing to update afterwards, so the caller hands
 * in the follow-up rather than the dialog trying to work out where it came
 * from.
 */
let artPickTarget = null;

/**
 * Kept in step with electron/main.js. The main process is the one that
 * actually has to refuse — a renderer check can only ever be a courtesy,
 * because it is the one half a determined caller can skip.
 */
const ART_MAX_BYTES = 12 * 1024 * 1024;
const ART_TYPES = /^image\/(png|jpeg|webp|gif|bmp)$/;

function artPickOpen() {
  return !el('artModal').hidden;
}

function openArtPicker(kind, id, label, onDone) {
  artPickTarget = { kind, id, onDone };
  el('artFor').textContent = label || '';
  const err = el('artError');
  err.hidden = true;
  err.textContent = '';
  delete el('artDrop').dataset.over;
  el('artModal').hidden = false;
  el('btnArtBrowse').focus();
}

function closeArtPicker() {
  el('artModal').hidden = true;
  delete el('artDrop').dataset.over;
  artPickTarget = null;
}

/**
 * A refusal stays IN the dialog rather than going out as a toast.
 *
 * The whole reason to have said the rules up front is that a wrong file gets
 * corrected on the spot — and a message that floats away over the settings
 * sheet is not next to the thing being corrected, or still on screen by the
 * time the second attempt is being chosen.
 */
function artPickFailed(message) {
  const err = el('artError');
  err.textContent = message;
  err.hidden = false;
}

/**
 * Land a result, whichever route produced it.
 *
 * Both the file dialog and the drop end in the same two obligations: forget
 * the cached art under that key — a remembered hit would keep painting the
 * old picture until a restart, which reads exactly like the new one not
 * taking — and tell whichever surface asked.
 */
function applyArtResult(result) {
  if (!artPickTarget) return;
  if (!result || result.cancelled) return;
  if (!result.ok) { artPickFailed(result.error || 'Could not use that image.'); return; }

  const { kind, id, onDone } = artPickTarget;
  artworkCache.delete(`${kind}
${id}`);
  if (mediaData && mediaData.art) mediaData.art.set(`${kind}
${id}`, true);
  closeArtPicker();
  if (typeof onDone === 'function') onDone();
  toast('Card image updated.', 2400);
}

/**
 * A dropped file, read here and handed over as bytes.
 *
 * Electron removed File.path, so there is no path to give the main process —
 * the renderer has to read the file itself. The type and size checks are the
 * courtesy half of the guidance in the dialog: nativeImage answers a PDF with
 * an empty image and no complaint, and "nothing happened" is the worst
 * possible reply to a file someone just dragged in.
 */
async function artFromFile(file) {
  if (!file || !artPickTarget) return;
  if (!ART_TYPES.test(file.type || '')) {
    artPickFailed('That is not an image this app can read. Use PNG, JPG, WEBP, GIF or BMP.');
    return;
  }
  if (file.size > ART_MAX_BYTES) {
    artPickFailed('That image is over 12 MB. Try a smaller one.');
    return;
  }

  const target = artPickTarget;
  const bytes = await file.arrayBuffer().catch(() => null);
  if (!bytes) { artPickFailed('Could not read that file.'); return; }
  // Closed, or pointed at something else, while the read was in flight —
  // landing this now would tick over a row nobody is looking at any more.
  if (artPickTarget !== target) return;

  const result = await window.tv.setArtworkFromData(target.kind, target.id, bytes)
    .catch((error) => ({ ok: false, error: String(error && error.message ? error.message : error) }));
  applyArtResult(result);
}

/**
 * Save one show's preference and drop every cache the old answer poisoned.
 *
 * The wanted-track and playable-URL caches were computed under the previous
 * preference; leaving them would keep serving the old language until a restart,
 * which reads exactly like the setting not working.
 */
function saveShowPref(patch) {
  if (!showSetShow) return;
  const show = showSetShow;
  const prior = prefFor(show.id);
  const next = { ...prior, ...patch };

  state = applySettings(shows, state, {
    showPrefs: { ...(state.settings.showPrefs || {}), [show.id]: next },
  }, {});
  persist();

  /**
   * The old body purged three caches here, because a preference could only
   * take effect through a re-prepare. mpv switches live: if the show whose
   * preference just changed is ON SCREEN, apply it to the episode playing
   * right now — the setting doing something immediately is the whole point
   * of the player swap.
   */
  if (current && current.showId === show.id && !playingBumperClip) {
    applyTrackPrefs(current);
  }
}

// ---------------------------------------------------------------------------
// marathon picker
// ---------------------------------------------------------------------------

function openMarathon() {
  const pick = el('marathonPick');
  pick.textContent = '';
  for (const show of shows) {
    const option = document.createElement('option');
    option.value = show.id;
    option.textContent = show.name;
    pick.append(option);
  }
  const running = state.settings.marathonShowId;
  if (running && shows.some((s) => s.id === running)) pick.value = running;

  el('marathonStatus').textContent = running ? 'A marathon is already running.' : '';
  el('marathonConfirm').disabled = shows.length === 0;
  el('marathonModal').hidden = false;
  pick.focus();
}

function closeMarathon() {
  el('marathonModal').hidden = true;
}

function marathonOpen() {
  return !el('marathonModal').hidden;
}

// ---------------------------------------------------------------------------

function openLocks() {
  el('locksModal').hidden = false;
  el('lockSearch').value = '';
  lockTab = SHOW;
  renderLockTable();
  el('btnCloseLocks').focus();
}

function closeLocks() {
  el('locksModal').hidden = true;
  renderLockSummary();
  el('btnOpenLocks').focus();
}

function locksOpen() {
  return !el('locksModal').hidden;
}

// ---------------------------------------------------------------------------
// audio + subtitle tracks — live, on mpv
// ---------------------------------------------------------------------------

/**
 * The whole track apparatus collapsed when the player learned to switch
 * live. Gone with the conversion pipeline: the audio override that forced a
 * re-prepare, the played-vs-planned index pair whose disagreement WAS the
 * lying-label bug, the WebVTT extraction, the <track> elements, and the
 * last-decision-wins sequence number a minutes-long extraction needed. What
 * remains reads mpv's own track-list — the menus carry mpv's `selected`
 * flag, so the label and the sound share one source and cannot disagree.
 */
let currentTracks = { audio: [], subtitles: [] };
let subsOn = false;

async function refreshTrackMenus() {
  if (!window.tv.mpvTrackList) { currentTracks = { audio: [], subtitles: [] }; return; }
  const list = await window.tv.mpvTrackList().catch(() => null);
  currentTracks = {
    audio: audioMenuFrom(list || []),
    subtitles: subtitleMenuFrom(list || []),
  };
  subsOn = (list || []).some((t) => t && t.type === 'sub' && t.selected);
  renderTrackMenu();
}

/**
 * The per-show preferences, applied to the file just loaded.
 *
 * Order matters for none of it — both are instant property writes — but the
 * guard does: the track list is asked AFTER the load settles, and a viewer
 * who moved on mid-ask must not have the old show's preference land on the
 * new file.
 */
async function applyTrackPrefs(item) {
  if (!window.tv.mpvTrackList) return;
  const list = await window.tv.mpvTrackList().catch(() => null);
  if (!list || current !== item) return;

  const pref = prefFor(item.showId);
  const aid = pickAudioTrackId(list, { preferLanguage: pref.audio || 'eng' });
  if (aid !== null) await window.tv.mpvSetAudioTrack(aid).catch(() => {});

  const sid = pref.subs ? pickSubtitleTrackId(list, { preferLanguage: pref.subs }) : null;
  // 'no' rather than nothing when there is no pick: sid is sticky across
  // loadfiles, so the previous episode's selection would otherwise carry.
  await window.tv.mpvSetSubTrack(sid !== null ? sid : 'no').catch(() => {});
  await window.tv.mpvSetSubVisibility(sid !== null).catch(() => {});

  await refreshTrackMenus();
}

/** INSTANT — the reason this branch exists. No re-prepare, no reload. */
async function switchAudio(id) {
  if (!current) return;
  const label = (currentTracks.audio.find((a) => a.id === id) || {}).label || 'that track';
  await window.tv.mpvSetAudioTrack(id).catch(() => {});
  toast(`Audio: ${label}`, 2200);
  await refreshTrackMenus();
}

async function setSubtitle(id) {
  if (id === null || id === undefined) {
    // Clear the TRACK, not just visibility: sid is a sticky mpv property,
    // and the menu's truth source is track-list's selected flag — a track
    // left selected-but-invisible reads as subtitles being on forever.
    await window.tv.mpvSetSubTrack('no').catch(() => {});
    await window.tv.mpvSetSubVisibility(false).catch(() => {});
  } else {
    await window.tv.mpvSetSubTrack(id).catch(() => {});
    await window.tv.mpvSetSubVisibility(true).catch(() => {});
  }
  await refreshTrackMenus();
}

function renderTrackMenu() {
  const audioList = el('audioTrackList');
  const subList = el('subTrackList');
  audioList.textContent = '';
  subList.textContent = '';

  const row = (label, selected, onPick, disabled) => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'trackopt';
    button.dataset.on = String(Boolean(selected));
    button.textContent = label;
    button.disabled = Boolean(disabled);
    button.addEventListener('click', onPick);
    li.append(button);
    return li;
  };

  if (currentTracks.audio.length === 0) {
    audioList.append(row('No audio tracks found', false, () => {}, true));
  } else {
    for (const track of currentTracks.audio) {
      audioList.append(row(track.label, track.selected, () => switchAudio(track.id)));
    }
  }

  subList.append(row('Off', !subsOn, () => setSubtitle(null)));
  for (const track of currentTracks.subtitles) {
    subList.append(row(track.label, subsOn && track.selected, () => setSubtitle(track.id)));
  }

  const note = el('trackMenuNote');
  if (currentTracks.audio.length > 1) {
    note.textContent = 'Audio and subtitles switch instantly.';
    note.hidden = false;
  } else {
    note.hidden = true;
  }
}

function toggleTrackMenu(force) {
  const menu = el('trackMenu');
  const open = force === undefined ? menu.hidden : force;
  menu.hidden = !open;
  el('btnTracks').setAttribute('aria-expanded', String(open));
  if (open) {
    showChrome();
    renderTrackMenu();      // paint from cache: no blank flash
    /**
     * Then ASK, because the cache had exactly one filler — the load-time
     * preference pass — and when that pass silently stopped running, the
     * menu had no second source and opened empty on a dual-audio file. The
     * viewer's own gesture is the cheapest possible moment to re-read mpv;
     * the async re-render lands a frame or two later and corrects anything
     * stale. Not awaited, so it carries its own catch: a failed read leaves
     * the cached menu standing rather than vanishing into a dead promise.
     */
    refreshTrackMenus().catch((error) => console.error('track menu refresh failed:', error));
  }
}

/**
 * One handler for every per-show control, so the sidebar rows stay declarative
 * and the state/persist/re-render sequence is written once.
 */
function onShowControl(showIdValue, act) {
  const show = shows.find((s) => s.id === showIdValue);

  if (act === 'back' || act === 'pass') {
    if (!show || show.episodes.length === 0) return;
    state = nudgeCursor(shows, state, showIdValue, act === 'pass' ? 1 : -1, {});
    const cursor = state.cursors[showIdValue] || { index: 0 };
    const episode = show.episodes[cursor.index % show.episodes.length];
    toast(`${show.name} — next up ${formatEpisodeLabel(episode)}`, 2200);
  } else if (act === 'reset') {
    if (!show) return;
    state = resetProgress(shows, state, showIdValue, {});
    toast(`${show.name} is back at episode 1.`, 2600);
  } else if (act === 'marathon' || act === 'startMarathon') {
    if (!show) return;
    // The row button toggles (it is the same button either way); the picker
    // always starts, because choosing a show from a list can only mean start.
    const already = act === 'marathon' && state.settings.marathonShowId === showIdValue;
    state = applySettings(shows, state, { marathonShowId: already ? null : showIdValue }, {});
    toast(already
      ? 'Marathon ended — back to the full rotation.'
      : `Marathon: only ${show.name} from here.`, 2800);
  } else if (act === 'endMarathon') {
    state = applySettings(shows, state, { marathonShowId: null }, {});
    toast('Marathon ended — back to the full rotation.', 2600);
  } else {
    return;
  }

  // Nudging or resetting a cursor can satisfy a prerequisite, or already have
  // satisfied one — either way this is a point where progress moved.
  refreshLocks();

  renderSidebar();
  if (app.dataset.view === 'ready') renderReady();
  persist();
}

function wireEvents() {
  el('btnChangeFolder').addEventListener('click', pickFolder);
  el('btnRescan').addEventListener('click', () => {
    if (state.rootPath) loadLibrary(state.rootPath);
  });

  // The checkbox governs rotation; the rest of the row means "I want this now".
  // Fitts: the common action gets the whole row, the rarer one gets the box.
  el('showList').addEventListener('click', (event) => {
    const row = event.target.closest('.show');
    if (!row) return;
    const id = row.dataset.showId;

    // Checked before the toggle and the row: these sit inside both, so without
    // this every arrow press would also switch the show off and start playing it.
    const control = event.target.closest('.showctl');
    if (control) {
      onShowControl(id, control.dataset.act);
      return;
    }

    if (event.target.closest('.show__toggle')) {
      const disabled = new Set(state.settings.disabledShows || []);
      if (disabled.has(id)) disabled.delete(id); else disabled.add(id);
      state = applySettings(shows, state, { disabledShows: [...disabled] }, {});
      renderSidebar();
      if (app.dataset.view === 'ready') renderReady();
      persist();
      return;
    }

    const show = shows.find((s) => s.id === id);
    if (!show || show.episodes.length === 0) return;
    const cursor = state.cursors[id] || { index: 0 };
    const episodeIndex = cursor.index % show.episodes.length;
    state = playNow(shows, state, id, episodeIndex);
    playNext();
  });

  /**
   * The sidebar picker. Choosing anything here is a decision about the running
   * order, so it always ends a marathon — including the "off" entry, which
   * means "shuffle", not "leave whatever is happening alone".
   */
  el('scheduleSelect').addEventListener('change', (event) => {
    const id = event.target.value;
    // Re-selecting the status line itself is not a choice; put it back.
    if (id === '__marathon__') { renderScheduleField(); return; }

    /**
     * Create new… is an action, not a running order. Open the editor on a
     * BLANK draft — picking "create" and being shown the schedule you already
     * had would be the wrong answer to the question asked — and put the
     * selection back to whatever is actually in force, so the control never
     * sits displaying a verb.
     */
    if (id === '__create__') {
      loadDraft(null);
      el('scheduleModal').hidden = false;
      renderScheduleEditor();
      renderScheduleField();
      return;
    }

    state = applySettings(shows, state, {
      activeScheduleId: id || null,
      marathonShowId: null,
    }, {});
    persist();
    renderSidebar();
    if (!el('settingsModal').hidden) renderSettings();

    const picked = id ? savedSchedules().find((sc) => sc.id === id) : null;
    const upcoming = peek(shows, state, 1)[0];
    toast(picked
      ? `${picked.name} — ${upcoming ? `${upcoming.showName} is up next.` : 'schedule set.'}`
      : 'Back to a shuffled rotation.', 3000);
  });

  // --- set schedules -------------------------------------------------------

  el('btnOpenSchedule').addEventListener('click', () => { closeSettings(); openSchedule(); });
  el('btnCloseSchedule').addEventListener('click', closeSchedule);
  el('scheduleBackdrop').addEventListener('click', closeSchedule);
  wireColumnDrops();

  el('schedPick').addEventListener('change', (event) => {
    // Switching schedules keeps unsaved work out of the way rather than
    // carrying it across: the draft belongs to the schedule it came from.
    loadDraft(event.target.value);
    renderScheduleEditor();
  });

  el('schedName').addEventListener('input', () => {
    if (draft) draft.name = el('schedName').value;
  });

  el('schedBlock').addEventListener('change', () => {
    if (!draft) return;
    draft.blockSize = Math.min(12, Math.max(1, Number(el('schedBlock').value) || 1));
    el('schedBlock').value = String(draft.blockSize);
    renderScheduleEditor();      // the per-card "N eps" labels follow it
  });

  el('schedNew').addEventListener('click', () => {
    loadDraft(null);
    renderScheduleEditor();
    el('schedName').focus();
    el('schedName').select();
  });

  el('schedDuplicate').addEventListener('click', () => {
    if (!draft) return;
    draft = { ...draft, id: newScheduleId(), name: `${draft.name} copy`, items: [...draft.items] };
    editingId = draft.id;
    renderScheduleEditor();
  });

  el('schedDelete').addEventListener('click', () => {
    if (!draft) return;
    const gone = draft.id;
    const patch = { schedules: savedSchedules().filter((sc) => sc.id !== gone) };
    // Deleting the one that is running has to stop it running, or the channel
    // keeps following an order nothing can show you any more.
    if (state.settings.activeScheduleId === gone) patch.activeScheduleId = null;
    state = applySettings(shows, state, patch, {});
    persist();
    renderSidebar();

    const remaining = savedSchedules();
    loadDraft(remaining.length ? remaining[0].id : null);
    renderScheduleEditor();
    toast('Schedule deleted.', 2400);
  });

  el('schedClear').addEventListener('click', () => {
    if (!draft) return;
    draft.items = [];
    renderScheduleEditor();
  });

  el('schedUse').addEventListener('click', () => {
    if (!draft) return;
    if (draft.items.length === 0) {
      toast('Add at least one show before using this schedule.', 3200);
      return;
    }
    commitDraft({ activate: true });
    renderScheduleEditor();
    closeSchedule();
    const upcoming = peek(shows, state, 1)[0];
    toast(upcoming ? `${draft.name} — ${upcoming.showName} is up next.` : `${draft.name} set.`, 3000);
  });

  // --- marathon ------------------------------------------------------------

  // --- per-show settings ---------------------------------------------------

  // --- the library table ---------------------------------------------------

  el('btnOpenMedia').addEventListener('click', openMedia);
  el('btnCloseMedia').addEventListener('click', closeMedia);
  el('mediaBackdrop').addEventListener('click', closeMedia);
  // Both of these rebuild the table, and a row can vanish from it entirely —
  // narrowed away by the search, or on the tab that was just left. The
  // popover would then be editing a title nobody can see.
  el('mediaSearch').addEventListener('input', () => { closeTagPop(); renderMediaTable(); });
  el('mediaTabs').addEventListener('click', (event) => {
    const button = event.target.closest('.mode');
    if (!button) return;
    closeTagPop();
    mediaKind = button.dataset.kind;
    renderMediaTable();
  });

  // --- genre tags ----------------------------------------------------------

  el('tagPopInput').addEventListener('input', () => { tagPopActive = 0; renderTagPop(); });
  el('tagPopInput').addEventListener('keydown', tagPopKeydown);

  /**
   * Keep the popover attached to its row.
   *
   * Captured at the document, because the scroll happens on .modal__body and
   * scroll events do not bubble — a listener on window would never see it.
   * Resize matters too: the flip-above decision is made from the window
   * height.
   */
  document.addEventListener('scroll', positionTagPop, true);
  window.addEventListener('resize', positionTagPop);

  el('btnGenreFilter').addEventListener('click', () => {
    if (genreMenuOpen()) closeGenreMenu(); else openGenreMenu();
  });
  el('btnGenreClear').addEventListener('click', () => {
    browseGenres = [];
    renderGenreFilter();
    renderBrowse();
  });

  /**
   * One outside-click listener for both popovers.
   *
   * Captured on the document, because the tag popover is opened from inside
   * a scrolling modal and the filter menu from the browse header — there is
   * no common ancestor to hang this on. Each guard checks containment rather
   * than target identity, so clicking a chip, a count or an SVG inside the
   * control does not count as clicking outside it.
   */
  document.addEventListener('mousedown', (event) => {
    if (tagPopOpen()
      && !el('tagPop').contains(event.target)
      && !(tagPopAnchor && tagPopAnchor.contains(event.target))) {
      closeTagPop();
    }
    if (genreMenuOpen() && !el('genreFilter').contains(event.target)) {
      closeGenreMenu();
    }
  });

  // --- the card image picker -----------------------------------------------

  el('btnCloseArt').addEventListener('click', closeArtPicker);
  el('artBackdrop').addEventListener('click', closeArtPicker);

  el('btnArtBrowse').addEventListener('click', async () => {
    if (!artPickTarget) return;
    const target = artPickTarget;
    const result = await window.tv.chooseArtwork(target.kind, target.id).catch(() => null);
    // The OS dialog is modal to the app, so nothing can have moved underneath
    // it — but a cancel must leave the picker standing, not read as a failure.
    if (!result || result.cancelled) return;
    applyArtResult(result);
  });

  /**
   * The whole zone is the drop target, and the whole zone is also a button.
   *
   * Dragging is not available to everyone, and a keyboard reaching the zone
   * should get the same file dialog rather than a dead end — which is why the
   * markup gives it role="button" and a tab stop.
   */
  const artDrop = el('artDrop');
  artDrop.addEventListener('click', (event) => {
    if (event.target.closest('#btnArtBrowse')) return;   // its own handler ran
    el('btnArtBrowse').click();
  });
  artDrop.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    el('btnArtBrowse').click();
  });

  /**
   * dragover MUST be prevented, on the zone and on the window.
   *
   * Without the zone's preventDefault the browser refuses the drop and no drop
   * event ever fires. Without the window's, a file let go anywhere else
   * NAVIGATES the renderer to that file — the app silently becomes a picture
   * viewer with no way back, which is the failure mode worth guarding even
   * when the picker is closed.
   */
  artDrop.addEventListener('dragover', (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    artDrop.dataset.over = 'true';
  });
  artDrop.addEventListener('dragleave', () => { delete artDrop.dataset.over; });
  artDrop.addEventListener('drop', (event) => {
    event.preventDefault();
    delete artDrop.dataset.over;
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (!file) { artPickFailed('Nothing was dropped that this app can read.'); return; }
    artFromFile(file);
  });
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => event.preventDefault());

  el('btnDetailSettings').addEventListener('click', () => openShowSettings(browseDetailShow));
  el('btnCloseShowSet').addEventListener('click', closeShowSettings);
  el('showSetBackdrop').addEventListener('click', closeShowSettings);

  el('showSetAudio').addEventListener('change', (event) => {
    saveShowPref({ audio: event.target.value || null });
    toast(event.target.value
      ? 'Audio preference saved — episodes may convert once before playing.'
      : 'Back to the default audio.', 3200);
  });

  el('showSetSubs').addEventListener('change', (event) => {
    saveShowPref({ subs: event.target.value || null });
    toast(event.target.value ? 'Subtitles will switch on for this show.' : 'Subtitles back to off.', 2600);
  });

  el('btnShowSetImage').addEventListener('click', () => {
    if (!showSetShow) return;
    const show = showSetShow;
    openArtPicker('show', show.id, show.name, () => {
      if (browseDetailShow && browseDetailShow.id === show.id) {
        const art = el('detailArt');
        art.textContent = '';
        art.dataset.empty = 'true';
        paintArt(art, [], { kind: 'show', id: show.id });
      }
      if (browseOpen()) renderBrowse();
    });
  });

  el('btnShowSetForget').addEventListener('click', () => {
    if (!showSetShow) return;
    const show = showSetShow;
    if (!window.confirm(`Forget the library's watch history for ${show.name}?

The channel keeps its own place.`)) return;
    state = forgetShow(state, show.id);
    persist();
    closeShowSettings();
    if (detailOpen()) openDetail(show);   // redraw counts, ticks and the resume point
    if (browseOpen()) renderBrowse();
    toast(`${show.name} — library history cleared.`, 2600);
  });

    el('btnMarathon').addEventListener('click', () => {
    if (!shows.length) { toast('No shows to marathon yet.', 2400); return; }
    openMarathon();
  });
  el('btnCloseMarathon').addEventListener('click', closeMarathon);
  el('marathonBackdrop').addEventListener('click', closeMarathon);
  el('marathonCancel').addEventListener('click', closeMarathon);

  el('marathonConfirm').addEventListener('click', () => {
    const id = el('marathonPick').value;
    if (!id) { closeMarathon(); return; }
    closeMarathon();
    onShowControl(id, 'startMarathon');
  });

  el('btnForgetLibrary').addEventListener('click', () => {
    // Destructive to the library's memory, but the CHANNEL keeps its place —
    // say exactly which store this touches, because the app has two.
    if (!window.confirm('Forget which episodes the library says you watched?\n\nEvery show card goes back to unwatched. The channel keeps its own place in every show.')) return;
    state = forgetAll(state);
    persist();
    if (browseOpen()) renderBrowse();
    toast('Library watch history cleared.');
  });

  el('btnResetAll').addEventListener('click', () => {
    // Destructive and not undoable, and it is one click from the toggles people
    // use constantly — so it asks.
    const total = shows.reduce((n, s) => n + s.episodes.length, 0);
    if (!window.confirm(`Send all ${shows.length} shows back to episode 1?\n\n${total} episodes will be treated as unwatched. This cannot be undone.`)) return;
    state = resetProgress(shows, state, null, {});
    /**
     * The library's own watch record is a SEPARATE store from the channel
     * cursors, and for a long time this button only reset the cursors — the
     * gallery went on showing every tick and resume point for shows the
     * channel had just been told were unwatched. "Clears every show's place"
     * has to mean both stores or the button is lying.
     */
    state = forgetAll(state);
    renderSidebar();
    if (app.dataset.view === 'ready') renderReady();
    persist();
    toast('Every show is back at episode 1.');
  });

  // Drop the next item without marking it watched.
  el('scheduleList').addEventListener('click', (event) => {
    if (!event.target.closest('.sched__drop')) return;
    state = skip(shows, state, {});
    renderSidebar();
    if (app.dataset.view === 'ready') renderReady();
    persist();
  });

  for (const button of document.querySelectorAll('.mode')) {
    button.addEventListener('click', () => {
      state = applySettings(shows, state, { mode: button.dataset.mode }, {});
      renderSidebar();
      persist();
    });
  }

  el('bumperRange').addEventListener('input', (event) => {
    const value = Number(event.target.value);
    state = applySettings(shows, state, {
      bumperSeconds: Math.max(1, value),
      bumperEnabled: value > 0,
    }, {});
    renderSettings();
    persist();
  });

  el('loopToggle').addEventListener('change', (event) => {
    state = applySettings(shows, state, { loopWhenExhausted: event.target.checked }, {});
    renderSidebar();
    persist();
  });

  // -- settings modal -------------------------------------------------------

  el('btnSettings').addEventListener('click', openSettings);
  watchSettingsScroll();
  el('btnCloseSettings').addEventListener('click', closeSettings);
  el('settingsBackdrop').addEventListener('click', closeSettings);

  el('btnOpenLocks').addEventListener('click', openLocks);
  el('btnCloseLocks').addEventListener('click', closeLocks);
  el('locksBackdrop').addEventListener('click', closeLocks);
  el('lockSearch').addEventListener('input', renderLockTable);

  el('lockTabs').addEventListener('click', (event) => {
    const tab = event.target.closest('.mode');
    if (!tab || tab.dataset.kind === lockTab) return;
    lockTab = tab.dataset.kind;
    // The search is cleared with the tab: a query typed against shows almost
    // never matches a film, so keeping it would land on an empty table.
    el('lockSearch').value = '';
    renderLockTable();
  });

  el('btnResetUnlocks').addEventListener('click', () => {
    const earned = Object.keys(state.unlocked || {}).length;
    if (!earned) { toast('Nothing has been unlocked yet.', 2800); return; }

    // The rules themselves are left alone — this forgets only what has been
    // EARNED, which is the thing that cannot be recreated by editing the table.
    state = resetUnlocks(state);
    state = applyLocksToQueue(shows, state, {});
    persist();
    renderSidebar();
    renderLockSummary();
    toast(`${earned} unlock${earned === 1 ? '' : 's'} cleared — those titles are held back again.`, 4200);
  });

  el('blockSizeRange').addEventListener('input', (event) => {
    const value = Math.max(2, Number(event.target.value) || 2);
    // Reshapes the schedule, so applySettings rebuilds the committed queue —
    // otherwise the new block length would not appear for a dozen episodes.
    state = applySettings(shows, state, { blockSize: value }, {});
    renderSidebar();
    persist();
  });

  /**
   * Every settings control writes through here, so "saved automatically" is a
   * property of the settings screen rather than something each control has to
   * remember to do. persist() is immediate: a slider the viewer nudges and then
   * closes the app on must survive.
   */
  const setSetting = (patch) => {
    state = applySettings(shows, state, patch, {});
    renderSettings();
    persist();
  };

  el('movieEvery').addEventListener('change', (event) => {
    const hours = Number(event.target.value) || 24;
    setSetting({ movieEvery: hours });
    toast(state.settings.moviesEnabled === false
      ? `Set to every ${hours} hours — movies are still switched off.`
      : `A movie every ${hours} hours. The first one plays at the next break.`, 3600);
  });

  // On/off is its own control rather than a "never" entry in the list above,
  // so switching movies off and back on does not make you re-pick how often
  // you wanted them. The two are different questions.
  el('btnMovies').addEventListener('click', () => {
    const turningOn = state.settings.moviesEnabled === false;
    setSetting({ moviesEnabled: turningOn });

    if (turningOn) {
      // Booked a few blocks out rather than dropped into the next break: a
      // movie that appears the moment you flick a switch is a surprise, and it
      // gives the conversion no time at all. Choosing it now also puts it in
      // the schedule, so it is announced before it arrives.
      const picked = scheduleMovie(movieFiles, state, {});
      state = picked.state;
      persist();
      renderSidebar();
      toast(picked.movie
        ? `Movies on — ${picked.movie.name} in ${state.movieLeadBlocks} block${state.movieLeadBlocks === 1 ? '' : 's'}.`
        : `Movies on — one every ${movieIntervalHours(state.settings)} hours.`, 4200);
      return;
    }

    // Switching off drops the booking too, or it would still be sitting in the
    // schedule promising something that is no longer going to happen.
    state = clearPendingMovie(state);
    persist();
    renderSidebar();
    toast('Movies off.', 3000);
  });

  el('presentationToggle').addEventListener('change', (event) => setSetting({ moviePresentationEnabled: event.target.checked }));

  el('promoToggle').addEventListener('change', (event) => setSetting({ promosEnabled: event.target.checked }));

  el('themeSelect').addEventListener('change', (event) => {
    setSetting({ theme: event.target.value });
    applyTheme();
  });

  el('fontDisplaySelect').addEventListener('change', (event) => {
    setSetting({ fonts: { ...(state.settings.fonts || {}), display: event.target.value } });
    applyFonts();
  });

  el('fontBodySelect').addEventListener('change', (event) => {
    setSetting({ fonts: { ...(state.settings.fonts || {}), body: event.target.value } });
    applyFonts();
  });

  /**
   * Back to how the app ships — the theme and the two faces, and nothing else.
   *
   * DEFAULT_SETTINGS is the source for all three rather than literals here:
   * a default written twice is a default that eventually disagrees with
   * itself, and this control's whole promise is that it lands on the real one.
   */
  el('btnResetLook').addEventListener('click', () => {
    setSetting({
      theme: DEFAULT_SETTINGS.theme,
      fonts: { ...DEFAULT_SETTINGS.fonts },
    });
    applyTheme();
    applyFonts();
    renderSettings();
    toast('Appearance back to the defaults.', 2600);
  });

  el('promoBetweenToggle').addEventListener('change', (event) => {
    setSetting({ promoBetweenShows: event.target.checked });
    toast(event.target.checked
      ? 'Promos now play between shows, not on a count.'
      : `Promos back on a count — every ${Math.max(1, Number(state.settings.promoEvery) || 1)} episode(s).`, 3200);
  });

  // Order only. Cursors are untouched, so nobody loses their place in a series
  // — it is the running order that changes, not the progress.
  el('btnShuffle').addEventListener('click', () => {
    if (!shows.length) { toast('Nothing to shuffle yet.', 2400); return; }

    /**
     * Shuffling is a statement that nothing should be dictating the order, so
     * it turns off whatever was — a set schedule or a marathon — and goes back
     * to the rotation and block size in Settings.
     *
     * Done through applySettings rather than reshuffle so the queue is rebuilt
     * against the CLEARED settings; reshuffling first would deal a fresh round
     * of the schedule that is about to be switched off.
     */
    const wasSchedule = activeSchedule(state.settings);
    const wasMarathon = state.settings.marathonShowId;

    if (wasSchedule || wasMarathon) {
      state = applySettings(shows, state, { activeScheduleId: null, marathonShowId: null }, {});
    } else {
      state = reshuffle(shows, state, {});
    }

    persist();
    renderSidebar();
    if (!el('settingsModal').hidden) renderSettings();

    const upcoming = peek(shows, state, 1)[0];
    const what = wasSchedule ? `${wasSchedule.name} off` : (wasMarathon ? 'Marathon off' : 'Reshuffled');
    toast(upcoming ? `${what} — ${upcoming.showName} is up next.` : `${what}.`, 3000);
  });

  el('btnManualSave').addEventListener('click', async () => {
    const result = await window.tv.manualSave(state).catch((error) => ({ ok: false, error: String(error) }));
    toast(result && result.ok
      ? 'Progress saved. You can come back to this from Settings.'
      : `Could not save progress — ${(result && result.error) || 'unknown error'}`, 4200);
    renderManualSaveInfo();
  });

  el('btnManualLoad').addEventListener('click', async () => {
    const result = await window.tv.manualLoad().catch((error) => ({ ok: false, error: String(error) }));
    if (!result || !result.ok) {
      toast(`Could not load progress — ${(result && result.error) || 'unknown error'}`, 4200);
      return;
    }

    /**
     * Say so when the checkpoint is OLDER than where you actually are.
     *
     * A checkpoint is a point to come back to, so loading one is meant to move
     * progress backwards — but a checkpoint made last week, loaded after a long
     * evening's viewing, silently un-watches everything since, and the first
     * sign of it is an episode you have already seen. Counted and named, then
     * confirmed by pressing again.
     */
    const behind = Object.entries(result.state.cursors || {})
      .filter(([id, saved]) => {
        const now = (state.cursors || {})[id];
        return now && Number.isInteger(now.index) && Number.isInteger(saved.index)
          && saved.index < now.index;
      });

    if (behind.length && loadArmedFor !== result.savedAt) {
      loadArmedFor = result.savedAt;
      clearTimeout(loadArmTimer);
      loadArmTimer = setTimeout(() => { loadArmedFor = null; }, 12000);
      const worst = behind
        .map(([id, saved]) => `${id} ${state.cursors[id].index}→${saved.index}`)
        .slice(0, 3)
        .join(', ');
      toast(
        `That checkpoint is from ${new Date(result.savedAt).toLocaleString()} and moves `
        + `${behind.length} show${behind.length === 1 ? '' : 's'} BACK (${worst}`
        + `${behind.length > 3 ? '…' : ''}). Press Load again to confirm.`,
        11000,
      );
      return;
    }
    loadArmedFor = null;
    clearTimeout(loadArmTimer);

    // Merged the same way boot() merges a loaded file, then re-anchored against
    // the library as it stands NOW: the checkpoint may predate files that have
    // since been added or removed, and an index alone would point at the wrong
    // episode. The queue is rebuilt for the same reason.
    const fresh = createState(result.state.rootPath || state.rootPath);
    state = { ...fresh, ...result.state };
    state.settings = { ...fresh.settings, ...(result.state.settings || {}) };
    state.settings.subtitles = { ...fresh.settings.subtitles, ...((result.state.settings || {}).subtitles || {}) };
    state.cursors = reconcileCursors(shows, state);
    state.queue = pruneQueue(shows, state.queue);
    topUp();

    applySubtitleStyle();
    applyUiScale();
    applyVolume();
    renderSidebar();
    persist();
    toast(`Progress restored to ${new Date(result.savedAt).toLocaleString()}.`, 4600);
  });
  el('promoEveryRange').addEventListener('input', (event) => setSetting({ promoEvery: Number(event.target.value) }));

  el('autoCropToggle').addEventListener('change', (event) => {
    setSetting({ autoCrop: event.target.checked });
    // Switching it on mid-episode should crop THIS episode, not the next one —
    // and a person at the toggle is asking now, so skip the startup courtesy.
    if (event.target.checked && !currentCrop) loadCropForCurrent(true);
    else applyPicture(playingBumperClip);
  });

  // Applies live, so it can be judged against a clip that is on screen rather
  // than by reading a number and guessing.
  el('interZoomRange').addEventListener('input', (event) => {
    setSetting({ interstitialZoom: Number(event.target.value) });
    applyPicture(playingBumperClip);
  });

  el('uiScaleRange').addEventListener('input', (event) => {
    setSetting({ uiScale: Number(event.target.value) });
    applyUiScale();
  });

  el('cueFont').addEventListener('change', (event) => patchSubtitles({ font: event.target.value }));
  el('cueSize').addEventListener('input', (event) => patchSubtitles({ size: Number(event.target.value) }));
  el('cueBackground').addEventListener('change', (event) => patchSubtitles({ background: event.target.checked }));
  el('cueOpacity').addEventListener('input', (event) => patchSubtitles({ backgroundOpacity: Number(event.target.value) }));
  for (const button of el('cuePosition').querySelectorAll('.mode')) {
    button.addEventListener('click', () => patchSubtitles({ position: button.dataset.pos }));
  }

  el('bumperClipToggle').addEventListener('change', (event) => {
    // Not a reshaping setting: it changes what plays BETWEEN episodes, so the
    // committed queue stays exactly as promised.
    state = applySettings(shows, state, { bumperClipsEnabled: event.target.checked }, {});
    renderSettings();
    persist();
  });

  // transport
  el('btnMute').addEventListener('click', () => {
    // Unmuting at zero would be silent, which reads as the button being broken.
    const level = Number(state.settings.volume) || 0;
    const goingAudible = state.settings.muted || level === 0;
    state = applySettings(shows, state, {
      muted: !goingAudible,
      volume: goingAudible && level === 0 ? 60 : level,
    }, {});
    applyVolume();
    persist();
  });

  el('volumeRange').addEventListener('input', (event) => {
    const level = Number(event.target.value);
    // Dragging the slider is an unambiguous request to hear something.
    state = applySettings(shows, state, { volume: level, muted: level === 0 }, {});
    applyVolume();
    persist();
  });

  el('btnPlay').addEventListener('click', togglePlay);
  el('btnBack').addEventListener('click', () => { player.currentTime -= 10; });
  el('btnFwd').addEventListener('click', () => { player.currentTime += 30; });
  // "Next" means play the episode that was promised next — NOT skip past it.
  // advance() already consumed the one on screen, so playNext() is the whole job.
  el('btnNext').addEventListener('click', askSkip);

  el('btnPrev').addEventListener('click', () => {
    // history[0] is the episode ON SCREEN — advance() recorded it the moment it
    // started — so stepping back to the one before it means undoing two: the
    // current episode, and the one that actually preceded it.
    const steps = app.dataset.view === 'playing' ? 2 : 1;
    if ((state.history || []).length < steps) {
      toast('Nothing played before this one.', 2200);
      return;
    }
    for (let i = 0; i < steps; i += 1) state = previous(shows, state);
    playNext();
  });

  el('btnTracks').addEventListener('click', (event) => {
    event.stopPropagation();
    toggleTrackMenu();
  });

  // Click anywhere else closes it. Registered on the stage rather than the
  // document so the menu's own buttons are not swallowed before they fire.
  el('stage').addEventListener('click', (event) => {
    if (el('trackMenu').hidden) return;
    if (event.target.closest('#trackMenu') || event.target.closest('#btnTracks')) return;
    toggleTrackMenu(false);
  });

  el('btnLibrary').addEventListener('click', openLibrary);
  el('btnFull').addEventListener('click', toggleFullscreen);

  wireWindowControls();
  wireBrowse();

  el('scrub').addEventListener('click', (event) => {
    if (!Number.isFinite(player.duration)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    player.currentTime = ((event.clientX - rect.left) / rect.width) * player.duration;
  });

  // player
  // The crop transform is computed from the element's pixel size, so it has to
  // be recomputed whenever that changes.

  player.addEventListener('ended', onEpisodeEnded);
  player.addEventListener('timeupdate', onTimeUpdate);

  /**
   * mpv came back from the dead. Re-assert everything the APP asked the old
   * process for, because all of it died with that process.
   *
   * The bridge restores what an element owns — file, position, pause, volume,
   * mute — and deliberately stops there. These are the rest, and without them
   * the picture returns at the right timestamp wearing mpv's own defaults.
   *
   * The subtitle style is the one that never healed on its own: nothing else
   * in the app re-applies it per file, so one crash left her chosen size,
   * colour and box at mpv's defaults for the whole remaining session. It goes
   * first and unconditionally — it is a process property with no dependence
   * on a file being loaded.
   *
   * The track preference and the crop DO need the file, so they ride a fresh
   * one-shot loadedmetadata exactly as a normal open does. Re-running the
   * preference also repairs the track menu, which until then went on showing
   * the pre-crash selection — asserting a track that was not playing.
   */
  player.addEventListener('restored', () => {
    applySubtitleStyle();
    if (!current) return;
    const item = current;
    player.addEventListener('loadedmetadata', () => {
      if (current !== item) return;   // she moved on while mpv was rebuilding
      applyTrackPrefs(item).catch((error) => console.error('track preferences failed after restart:', error));
      loadCropForCurrent().catch((error) => console.error('auto-crop failed after restart:', error));
    }, { once: true });
  });
  // Glyph only. Showing chrome here would fire on every automatic start —
  // each episode, each bumper, each promo — which is the interface appearing
  // over the opening of the picture. Chrome comes from togglePlay, hover and
  // the keyboard, all of which are the viewer actually asking for it.
  player.addEventListener('play', () => { el('btnPlay').textContent = '❚❚'; });
  player.addEventListener('pause', () => { el('btnPlay').textContent = '▶'; });
  player.addEventListener('error', onPlaybackError);

  el('stage').addEventListener('mousemove', () => {
    if (app.dataset.view === 'playing') showChrome();
  });
  el('stage').addEventListener('dblclick', (event) => {
    if (app.dataset.view === 'playing' && event.target === el('playerSurface')) toggleFullscreen();
  });
  // The picture's click target is the transparent surface standing where the
  // <video> element stood — the facade is not a DOM node and never gets a
  // 'click'.
  el('playerSurface').addEventListener('click', togglePlay);

  document.addEventListener('keydown', onGlobalKey);
  window.addEventListener('beforeunload', () => window.tv.saveState(state));
}

let lastSavedAt = 0;
function onTimeUpdate() {
  const { currentTime, duration } = player;
  el('timeLabel').textContent = `${formatTime(currentTime)} / ${formatTime(duration)}`;
  if (Number.isFinite(duration) && duration > 0) {
    el('scrubFill').style.width = `${(currentTime / duration) * 100}%`;
  }

  // Library mode keeps its position in its own record, not in state.resume —
  // state.resume is what the channel offers to pick up, and offering to resume
  // something watched out of band is exactly the confusion the two records
  // exist to avoid.
  if (browsing() && browseItem && !playingBumperClip && performance.now() - lastSavedAt > 5000) {
    lastSavedAt = performance.now();
    browseTimeUpdate();
    return;
  }

  // `current` still points at the finished episode while a clip plays, so
  // without this we would save that episode's resume at the CLIP's timestamp.
  if (current && !current.isMovie && !playingBumperClip && performance.now() - lastSavedAt > 5000) {
    lastSavedAt = performance.now();
    state.resume = {
      showId: current.showId,
      episodeIndex: current.episodeIndex,
      relPath: current.relPath,
      position: currentTime,
    };
    persist();
  }
}

function onPlaybackError() {
  // A clip that will not play is not an episode failure — its own handler
  // moves the channel on.
  if (playingBumperClip) return;

  /**
   * The old body escalated through conversion tiers here — a decode failure
   * meant the PLANNER guessed wrong and a re-encode could fix it. mpv does
   * not guess; a file it reports an error for is genuinely unreadable
   * (truncated, corrupt, or gone with its drive), and the only honest move
   * is the one the old last resort made: say so, and move on.
   */
  const name = current ? `${current.showName} ${current.label}` : 'that file';
  failedInARow += 1;
  if (failedInARow >= MAX_FAILURES_IN_A_ROW) {
    failedInARow = 0;
    toast('Several episodes in a row could not be played — is the drive connected? Stopping here.', 8000);
    setView('ready');
    renderReady();
    renderSidebar();
    return;
  }
  toast(`Could not play ${name} — skipping it.`, 4500);
  setTimeout(() => { if (app.dataset.view === 'playing') playNext(); }, 1200);
}

function togglePlay() {
  if (app.dataset.view !== 'playing') return;
  if (player.paused) player.play().catch(() => {}); else player.pause();
  /**
   * Pressing is intent, so the transport comes back — and this is the ONLY
   * play/pause path that shows it, because every caller here is a viewer
   * action (the click on the picture, the space bar, the transport button).
   *
   * It also re-arms the hide timer on resume: chrome stays up while paused by
   * design, and without this a resume would leave it up for good.
   */
  showChrome();
}

/**
 * Is there a paused episode we can pick straight back up?
 *
 * Opening the library pauses playback but leaves the episode LOADED, so
 * resuming is just play() — no reload, no seek, no re-resolving a converted
 * file. That makes it both instant and more accurate than the saved resume
 * position, which is only written every five seconds and so is always slightly
 * behind where the viewer actually stopped.
 */
/**
 * Is there something paused on the player that Resume should pick up?
 *
 * A bumper or promo counts. Opening the library pauses whatever is on screen,
 * and if that happened to be a promo, refusing to resume it meant Resume
 * silently skipped to the next episode — losing the clip and, worse, doing
 * something other than what the button said.
 */
function canResumeInPlace() {
  return Boolean(
    (current || playingBumperClip)
    && player.src
    && !player.ended
    && player.currentTime > 0,
  );
}

/**
 * The window buttons, now that there is no system title bar to carry them.
 *
 * Guarded on each call rather than on the whole block: these are the only way
 * to minimise or close the app, and a preview or a dev build running against an
 * older preload would otherwise throw on the first click and leave the window
 * with no way out. A button that does nothing is bad; a window that cannot be
 * closed is worse.
 */
function wireWindowControls() {
  el('btnWinMin').addEventListener('click', () => window.tv.minimizeWindow?.());
  el('btnWinMax').addEventListener('click', () => window.tv.toggleMaximizeWindow?.());
  el('btnWinClose').addEventListener('click', () => window.tv.closeWindow?.());

  // Pushed from main whenever it changes, because the window can be maximised
  // without the button — a double-click on the drag strip, Win+Up, a snap — and
  // a glyph that only reads the state once starts lying at the first of those.
  window.tv.onWindowState?.(({ maximized, fullscreen }) => {
    windowIsFullscreen = Boolean(fullscreen);
    app.dataset.maximized = String(Boolean(maximized));
    app.dataset.fullscreen = String(Boolean(fullscreen));
  });
}

/**
 * Show the library over whatever is playing.
 *
 * Shared by the ☰ button and the L key: two entry points running two copies of
 * this would eventually disagree about whether the resume point gets written.
 */
function openLibrary() {
  player.pause();
  // Record the exact stopping point now. onTimeUpdate only saves every five
  // seconds, so without this a quit from the library screen loses up to five
  // seconds — and, worse, pausing early in an episode leaves nothing saved at
  // all and the screen offers to start something else instead.
  if (current && !playingBumperClip && Number.isFinite(player.currentTime) && player.currentTime > 0) {
    if (browsing()) {
      // Library mode keeps its own record. Writing state.resume here would make
      // the CHANNEL offer to pick up something watched in the library, which is
      // the exact confusion two separate records exist to prevent.
      browseTimeUpdate();
    } else if (!current.isMovie) {
      state.resume = {
        showId: current.showId,
        episodeIndex: current.episodeIndex,
        relPath: current.relPath,
        position: player.currentTime,
      };
      persist();
    }
    // A channel MOVIE writes nothing: state.resume is an episode reference and
    // findEpisode can never resolve a movie, so it would be a record that only
    // ever reads back as null. Resuming in place still works — the file is
    // loaded, and that is what the button uses.
  }
  setView('ready');
  renderReady();
  renderSidebar();
}

function resumeInPlace() {
  setView('playing');
  // A clip has its own title; `current` is still the episode either side of it.
  if (!playingBumperClip) renderNowPlaying(current);
  showChrome();
  player.play().catch(() => {});
}

/** Mirrored from window:state — the OS window is the one source of truth. */
let windowIsFullscreen = false;

async function toggleFullscreen() {
  /**
   * ONE mechanism, not two. The old body ALSO requested the page's own HTML
   * fullscreen, which now belongs to the interface plane alone — Chromium's
   * built-in Escape exited the HTML half and left the OS window fullscreen,
   * a state the app could not see and the viewer could not leave.
   */
  windowIsFullscreen = !windowIsFullscreen;
  window.tv.setFullscreen(windowIsFullscreen);
}

function onGlobalKey(event) {
  // `event.target` is not always an Element — with nothing focused it can be
  // the document itself, which has no matches(). Calling it blind throws and
  // kills the handler for that keypress, so the key silently does nothing.
  const target = event.target;
  // Escape pressed to cancel an IME composition is not a command to the app.
  if (event.isComposing) return;
  /**
   * Form fields own their keys — except Escape. The show-settings dialog
   * opens with a <select> focused, and changing a select re-focuses it, so
   * without this exemption the dialog's Escape arm below could never fire in
   * exactly the states the dialog is actually in. A guard that cannot
   * execute reads exactly like one that works.
   *
   * One carve-out inside the exemption: Escape in a search box that HOLDS
   * text is the browser's own clear-the-query gesture. Let it clear; only an
   * already-empty field lets Escape fall through to close the layer.
   */
  if (target && typeof target.matches === 'function'
      && target.matches('input, textarea, select')) {
    if (event.key !== 'Escape') return;
    if (target.matches('input[type="search"]') && target.value) return;
  }

  // Library mode is checked first because it covers the whole window. Escape
  // peels one layer at a time — the show card, then the grid — and nothing else
  // gets through: space must not pause an episode nobody can see, and N must
  // not advance a channel that is not the thing on screen.
  /**
   * The two genre popovers are checked FIRST, above even the image picker.
   *
   * Both float over a surface that has its own Escape handler — the tag
   * popover over the library table, the filter menu over the browse page —
   * so without this, Escape would close the thing UNDERNEATH and leave a
   * menu hanging over nothing.
   */
  if (tagPopOpen()) {
    if (event.key === 'Escape') { event.preventDefault(); closeTagPop(); }
    return;
  }
  if (genreMenuOpen()) {
    if (event.key === 'Escape') { event.preventDefault(); closeGenreMenu(); }
    return;
  }

  // Checked before everything: the picker opens over the show-settings sheet
  // AND over the library table, so it is always the layer in front.
  if (artPickOpen()) {
    if (event.key === 'Escape') { event.preventDefault(); closeArtPicker(); }
    return;
  }

  // Checked before browse: this dialog opens OVER the detail card inside the
  // library, and Escape must close the thing on top, not the card under it.
  if (showSetOpen()) {
    if (event.key === 'Escape') { event.preventDefault(); closeShowSettings(); }
    return;
  }

  if (browseOpen()) {
    /**
     * Escape and L both leave, and both peel ONE layer — the show card first,
     * then the page — which is how Escape already works everywhere else here.
     *
     * They go to the SIDEBAR, not back to the picture. backFromBrowse resumes
     * whatever was paused, which is right for the Back button (it means
     * "return me to what was on screen") and wrong for a key that is the
     * other half of the key that opened this page.
     */
    if (event.key === 'Escape' || event.key === 'l' || event.key === 'L') {
      event.preventDefault();
      if (detailOpen()) closeDetail();
      else backToSidebar();
    }
    return;
  }

  // Checked before Settings, because it opens FROM Settings and sits on top:
  // Escape should peel off the sheet in front, not the one behind it.
  if (locksOpen()) {
    if (event.key === 'Escape') { event.preventDefault(); closeLocks(); }
    return;
  }

  // Same layering rule as the play-order table above it.
  if (mediaOpen()) {
    if (event.key === 'Escape') { event.preventDefault(); closeMedia(); }
    return;
  }

  /**
   * The schedule and marathon windows swallow keys the same way the others do.
   *
   * Marathon is checked FIRST because it can be opened over the schedule
   * window, and Escape has to close the one actually on top. Returning
   * unconditionally matters as much as the Escape: without it, space would
   * pause an episode nobody can see behind the dialog, and typing a schedule
   * name would fire the player's single-key shortcuts.
   */
  if (marathonOpen()) {
    if (event.key === 'Escape') { event.preventDefault(); closeMarathon(); }
    return;
  }

  if (scheduleOpen()) {
    if (event.key === 'Escape') { event.preventDefault(); closeSchedule(); }
    return;
  }

  // The settings dialog is modal: Escape closes it, and nothing else reaches
  // the player — space must not pause an episode you cannot see.
  if (settingsOpen()) {
    if (event.key === 'Escape') { event.preventDefault(); closeSettings(); }
    return;
  }

  if (!el('skipAsk').hidden) return;              // the skip dialog owns the keyboard
  if (app.dataset.view === 'bumper') return; // the bumper owns the keyboard

  switch (event.key) {
    case ' ':
      event.preventDefault();
      // On the library screen, space means "carry on" — resume what is paused.
      // It only starts a NEW episode when there is genuinely nothing to resume,
      // otherwise opening the library would silently cost you the episode you
      // were watching.
      if (app.dataset.view !== 'ready') togglePlay();
      else if (canResumeInPlace()) resumeInPlace();
      else playNext();
      break;
    case 'ArrowLeft': player.currentTime -= 10; showChrome(); break;
    case 'ArrowRight': player.currentTime += 30; showChrome(); break;
    // F11 handled here because the default menu (and its accelerator) is
    // gone: it fullscreened whichever plane was FOCUSED, which is always the
    // interface — leaving the video window behind at its old size.
    case 'f': case 'F': case 'F11': event.preventDefault(); toggleFullscreen(); break;
    case 'n': case 'N': askSkip(); break;
    case 'l': case 'L':
      /**
       * L is one key walking one line: picture -> sidebar -> library page,
       * and back out the same way (the browse arm above handles the return).
       *
       * From the sidebar it used to RESUME, which made the same key mean
       * "show me more" in one place and "put it away" in the other.
       */
      if (app.dataset.view === 'playing') openLibrary();
      else if (app.dataset.view === 'ready') openBrowse();
      break;
    case 'm': case 'M':
      el('btnMute').click();
      toast(state.settings.muted ? 'Muted' : 'Sound on', 1400);
      break;
    case 'Escape':
      // The OS window is the one fullscreen there is now; leave it here,
      // where the old HTML fullscreen used to exit.
      if (windowIsFullscreen) toggleFullscreen();
      break;
    default: break;
  }
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

async function boot() {
  wireEvents();

  const saved = await window.tv.loadState();
  if (saved && saved.version === 1) {
    state = { ...createState(saved.rootPath), ...saved };
    state.settings = { ...createState(null).settings, ...(saved.settings || {}) };
    // Nested settings need their own merge: the spread above replaces the whole
    // subtitles object, so a file saved before a new field existed would come
    // back missing it — and `undefined` reaches the stylesheet as the string
    // "undefined", which silently breaks every cue rule after it.
    state.settings.subtitles = {
      ...DEFAULT_SETTINGS.subtitles,
      ...((saved.settings || {}).subtitles || {}),
    };
  }

  // "Never" used to be an entry in the frequency menu, saved as 0. It is a
  // switch now, so a 0 left in an older file would match no option at all and
  // leave the menu blank. Move it to the default interval; whether movies
  // actually play is the switch's job.
  if (!MOVIE_INTERVALS.includes(Number(state.settings.movieEvery))) {
    state.settings = { ...state.settings, movieEvery: 24 };
  }

  applyTheme();
  applyFonts();
  applySubtitleStyle();
  applyUiScale();
  applyPicture(false);
  applyVolume();
  renderSettings();

  if (state.rootPath) {
    await loadLibrary(state.rootPath);
  } else {
    renderWelcome();
  }

  // Find out on launch whether saving works, rather than discovering an hour
  // of viewing later that none of it was kept.
  await verifySaving('startup');
}

boot();

// ---------------------------------------------------------------------------
// waiting on a conversion
// ---------------------------------------------------------------------------

/*
 * The preparing panel lived here — the honest wait screen for a conversion
 * running in front of the viewer. Nothing converts any more; nothing waits.
 */

// ---------------------------------------------------------------------------
// library mode
// ---------------------------------------------------------------------------

/**
 * A second way to watch: pick a thing, play it, roll into the next episode.
 *
 * The channel is untouched by all of this. Its queue stays committed, its
 * cursors stay where they were, and "Back to channel" simply stops intercepting
 * the end of an episode — nothing has to be restored because nothing was moved.
 *
 * What library mode DOES own is its own record of what has been watched, which
 * lives in src/shared/browse.js and is deliberately separate from the cursors.
 */

let browseItem = null;      // { kind: 'show'|'movie', show, episodeIndex, movie }
let browseDetailShow = null;
let browseQuery = '';
/** Genres ticked in the filter menu. Empty means no genre filter at all. */
let browseGenres = [];
let browseSavedScroll = 0;

function browsing() {
  return app.dataset.browsing === 'true';
}

/**
 * Build the shape loadAndPlay understands, WITHOUT going through advance().
 *
 * advance() is the only thing allowed to move a cursor, and it moves one every
 * time it is called — so borrowing it here would quietly walk the channel
 * forward every time an episode was picked out of the library, which is the one
 * behaviour this whole feature was asked not to have.
 */
function browseEpisodeItem(show, episodeIndex) {
  const episode = show.episodes[episodeIndex];
  if (!episode) return null;
  return {
    showId: show.id,
    showName: show.name,
    episodeIndex,
    relPath: episode.relPath,
    show,
    episode,
    title: episode.title || '',
    label: formatEpisodeLabel(episode),
    absPath: episode.absPath,
  };
}

function openBrowse() {
  // Seeding is idempotent and cheap, but it needs the scanned shows, so it
  // cannot happen at load. Here is the first moment both exist.
  const seeded = seedFromCursors(state, shows);
  if (seeded !== state) { state = seeded; persist(); }

  browseQuery = '';
  el('browseSearch').value = '';
  // The genre filter resets with the search box, for the same reason: a
  // narrowing you set last time and cannot see is a library that looks like
  // it has lost things.
  browseGenres = [];
  closeGenreMenu();
  el('browse').hidden = false;
  renderGenreFilter();
  renderBrowse();
  el('browseBody').scrollTop = browseSavedScroll;
  /**
   * The search box is NOT focused on open, and that is deliberate.
   *
   * L opens this page and L closes it again. Form fields own their letter
   * keys — they have to, or you could not type — so an autofocused search box
   * would swallow every L and the toggle would only ever work in one
   * direction. Special-casing the letter is not available either: "Lazarus"
   * and "Lupin" both start with it.
   *
   * Click the box or Tab to it to search.
   */
}

function closeBrowse() {
  browseSavedScroll = el('browseBody').scrollTop;
  el('browse').hidden = true;
  // The menu lives INSIDE #browse, so hiding the page makes it invisible
  // while leaving its own hidden flag false — and that flag is the first
  // thing the global key handler consults, above every other layer and above
  // the player's own keys. An invisible open menu was swallowing space, N, M,
  // F and the arrows for the whole app until Escape was pressed.
  closeGenreMenu();
  dropPendingDecodes();
  closeDetail();
}

function browseOpen() {
  return !el('browse').hidden;
}

/**
 * Close the gallery and go back to whatever was on screen.
 *
 * Distinct from backToChannel, which changes MODE. This one changes nothing:
 * it is the way out of a gallery you opened over something, and what you came
 * from might be a library movie, a library episode or the channel. Resuming
 * in place is the only answer that is true in all three.
 */
/**
 * Leave the library page for the sidebar it was opened from.
 *
 * The keyboard's way out. Deliberately does NOT resume what was paused, which
 * is the one thing that separates it from backFromBrowse below: L opened this
 * page from the sidebar, so L and Escape put it back to the sidebar. Landing
 * on the picture instead would make the key mean something different
 * depending on what happened to be loaded.
 */
function backToSidebar() {
  closeBrowse();
  setView(shows.length ? 'ready' : 'welcome');
  if (shows.length) renderReady();
  renderSidebar();
}

function backFromBrowse() {
  closeBrowse();
  if (canResumeInPlace()) { resumeInPlace(); return; }
  // Nothing loaded: the gallery was opened from the library screen, so that
  // is where Back goes.
  setView(shows.length ? 'ready' : 'welcome');
  if (shows.length) renderReady();
  renderSidebar();
}

/** Leave library mode entirely and hand the picture back to the channel. */
function backToChannel() {
  closeBrowse();
  app.dataset.browsing = 'false';
  browseItem = null;
  // The channel's queue was never disturbed, so this is a plain resume: the
  // episode it plays is the one it was always going to play next.
  if (app.dataset.view === 'playing') playNext();
  else { setView('ready'); renderReady(); renderSidebar(); }
}

// -- the grid ---------------------------------------------------------------

function matchesQuery(name) {
  if (!browseQuery) return true;
  return String(name).toLowerCase().includes(browseQuery);
}

/** Both filters at once — the search box AND the genre menu. */
function matchesBrowse(name, kind, id) {
  return matchesQuery(name) && matchesGenres(tagsFor(state, kind, id), browseGenres);
}

function renderBrowse() {
  const body = el('browseBody');
  body.textContent = '';

  /**
   * No rail while filtering, by search OR by genre.
   *
   * A filter is a question about the whole library, and the answer has to be
   * one list read straight down. Leaving the rail up gives the same title two
   * places to appear, and "carry on where you were" is not an answer to
   * "where is Akira" or to "show me horror" — it is a second, louder thing
   * sitting in front of it. Narrowing turns the page into results and nothing
   * else.
   *
   * Not computed at all while either filter is live, rather than computed and
   * filtered away: this runs on every keystroke.
   */
  const filtering = Boolean(browseQuery) || browseGenres.length > 0;
  const rows = filtering ? [] : continueWatching(shows, movieFiles, state, 12);
  const showList = shows.filter((s) => matchesBrowse(s.name, 'show', s.id));
  const movieList = movieFiles.filter((m) => matchesBrowse(m.name, 'movie', m.relPath));

  const found = showList.length + movieList.length;
  el('browseCount').textContent = filtering
    ? `${found} match${found === 1 ? '' : 'es'}`
    : `${shows.length} shows · ${movieFiles.length} movies`;

  if (rows.length) {
    body.append(carousel('Continue watching', rows, continueTile));
  }
  if (showList.length) {
    body.append(section('TV Shows', showList.length, showList.map(showTile)));
  }
  if (movieList.length) {
    body.append(section('Movies', movieList.length, movieList.map(movieTile)));
  }
  if (!showList.length && !movieList.length) {
    const empty = document.createElement('p');
    empty.className = 'browse__empty';
    empty.textContent = emptyBrowseCopy();
    body.append(empty);
  }
}

/**
 * What to say when nothing matched.
 *
 * Four cases, because a sentence naming only the search term is a lie when a
 * genre is also on — someone who has forgotten they left "Horror" ticked
 * would read "Nothing matching Akira" and conclude the film is missing.
 */
function emptyBrowseCopy() {
  const genres = browseGenres.join(', ');
  if (browseQuery && browseGenres.length) return `Nothing matching "${browseQuery}" in ${genres}.`;
  if (browseQuery) return `Nothing matching "${browseQuery}".`;
  if (browseGenres.length) return `Nothing tagged ${genres}.`;
  return 'Nothing in the library yet.';
}

/* --- the genre filter ----------------------------------------------------- */

/**
 * Build the filter menu from the tags something in the library actually
 * carries, per the rule that a menu whose options mostly return an empty page
 * is worse than no menu. Hides the whole control when nothing is tagged yet,
 * which is every library before this feature is used.
 */
function renderGenreFilter() {
  const used = tagsInUse(state, shows, movieFiles);
  const wrap = el('genreFilter');
  wrap.hidden = used.length === 0;
  if (used.length === 0) {
    // Nothing left to filter BY, so a stale selection would silently hide
    // the whole library behind a control that is no longer on screen.
    if (browseGenres.length) browseGenres = [];
    closeGenreMenu();
    return;
  }

  // A selection can outlive the tag it names — the last title carrying it was
  // untagged or deleted. Drop those rather than filtering on a ghost.
  const live = new Set(used.map((entry) => keyFor(entry.name)));
  browseGenres = browseGenres.filter((tag) => live.has(keyFor(tag)));

  el('genreFilterLabel').textContent = browseGenres.length === 0
    ? 'All genres'
    : (browseGenres.length === 1 ? browseGenres[0] : `${browseGenres.length} genres`);
  el('genreFilter').dataset.on = String(browseGenres.length > 0);

  const list = el('genreMenuList');
  list.textContent = '';
  for (const entry of used) {
    const on = hasTag(browseGenres, entry.name);
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'genreopt';
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(on));
    row.dataset.on = String(on);

    const name = document.createElement('span');
    name.textContent = entry.name;
    const count = document.createElement('span');
    count.className = 'genreopt__count mono';
    count.textContent = String(entry.count);
    row.append(name, count);

    row.addEventListener('click', () => {
      browseGenres = on
        ? browseGenres.filter((tag) => keyFor(tag) !== keyFor(entry.name))
        : [...browseGenres, entry.name];
      renderGenreFilter();
      renderBrowse();
    });
    list.append(row);
  }

  el('btnGenreClear').hidden = browseGenres.length === 0;
}

/**
 * Belt and braces: a menu inside a hidden page is not open.
 *
 * closeBrowse() now closes it properly, but this guard gates every keystroke
 * in the app, so it must not be able to answer "yes" for a control nobody can
 * see — whatever future path forgets to tidy up.
 */
function genreMenuOpen() {
  return !el('genreMenu').hidden && browseOpen();
}

function openGenreMenu() {
  el('genreMenu').hidden = false;
  el('btnGenreFilter').setAttribute('aria-expanded', 'true');
}

function closeGenreMenu() {
  el('genreMenu').hidden = true;
  el('btnGenreFilter').setAttribute('aria-expanded', 'false');
}

/**
 * The resume row, as a rail.
 *
 * This page had three identical five-up grids, which meant it had no primary
 * — nothing stood out, so everything read as equally important and the page
 * felt like a file listing. Resuming something is the one thing this screen
 * is for, so that row is now physically different: bigger tiles, three to a
 * view, running edge to edge past the page margin, and horizontal.
 *
 * A REAL SCROLLER, not a transform. Wheel, trackpad, touch, drag and the
 * keyboard all work because the browser is doing the scrolling; the arrows
 * just call scrollBy. Reinventing that with transforms is how a carousel ends
 * up feeling wrong in ways nobody can name.
 *
 * The loop is done by wrapping the scroll POSITION, not by animating: the
 * tiles are laid out three times and the scroller silently jumps a set
 * forward or back when it crosses a boundary. Because every set is identical
 * the jump is invisible, and because it is a jump rather than a transition it
 * cannot fight the user's own momentum. The clones are aria-hidden and
 * untabbable, so the row reads once to a screen reader and tabs through its
 * real tiles only.
 */
const CAROUSEL_MIN_TO_LOOP = 4;

function carousel(title, rows, build) {
  const wrap = document.createElement('section');
  wrap.className = 'browsesec browsesec--rail';

  const head = document.createElement('div');
  head.className = 'browsesec__head';
  const h = document.createElement('h3');
  h.className = 'browsesec__title';
  h.textContent = title;
  head.append(h);

  const viewport = document.createElement('div');
  viewport.className = 'rail';

  const track = document.createElement('ul');
  track.className = 'rail__track';

  /**
   * The repeat sets are BUILT, not cloned.
   *
   * cloneNode copies the DOM as it stands, and a card's artwork arrives
   * asynchronously — the frame grab is fetched and decoded after the element
   * exists. Cloning therefore captured the cards before their pictures had
   * landed, and those copies stayed empty for ever: the row looked right
   * until a wrap carried you into a repeat set, and then every card was
   * blank. Building each set through the same factory gives every card its
   * own paint, and its own click handler, so there is nothing to forward.
   */
  const loops = rows.length >= CAROUSEL_MIN_TO_LOOP;
  const buildSet = (hidden) => rows.map((row) => {
    const card = build(row);
    if (hidden) {
      // The row must read once to a screen reader and tab through its real
      // cards only, however many copies the loop needs.
      card.setAttribute('aria-hidden', 'true');
      card.tabIndex = -1;
    }
    return card;
  });

  if (loops) track.append(...buildSet(true));
  const tiles = buildSet(false);
  track.append(...tiles);
  if (loops) track.append(...buildSet(true));

  viewport.append(track);

  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const setWidthOnce = () => {
    const all = track.children;
    if (all.length < rows.length * 2 + 1) return 0;
    return all[rows.length].offsetLeft - all[0].offsetLeft;
  };

  const arrow = (direction) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `rail__arrow rail__arrow--${direction}`;
    // Full height and at the very edge: the cursor is already travelling
    // there, and a 32px circle floating over artwork is a worse target than
    // the strip it sits in.
    button.setAttribute('aria-label', direction === 'prev' ? 'Earlier titles' : 'More titles');
    button.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" '
      + 'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'
      + (direction === 'prev' ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7') + '" /></svg>';
    button.addEventListener('click', () => {
      // A WHOLE view. With the cards flush against each other, moving by
      // anything less leaves a card sliced by the frame edge, which is the
      // one thing a gapless rail must not do.
      const step = viewport.clientWidth;
      viewport.scrollBy({
        left: direction === 'prev' ? -step : step,
        behavior: reducedMotion() ? 'auto' : 'smooth',
      });
    });
    return button;
  };

  /**
   * Page dots, not tile dots.
   *
   * The rail moves a viewport at a time, so the dots count VIEWS — three
   * cards each. One dot per card would be a row of twelve markers under a row
   * of three pictures, which measures nothing anybody asked about.
   */
  const perPage = 3;
  const pages = Math.max(1, Math.ceil(rows.length / perPage));
  const dots = document.createElement('div');
  dots.className = 'raildots';
  dots.setAttribute('role', 'tablist');
  dots.setAttribute('aria-label', 'Pages');
  const dotEls = [];
  if (pages > 1) {
    for (let i = 0; i < pages; i += 1) {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'raildot';
      dot.setAttribute('aria-label', `Page ${i + 1} of ${pages}`);
      dot.addEventListener('click', () => {
        const first = track.children[loops ? rows.length : 0];
        const target = track.children[(loops ? rows.length : 0) + i * perPage];
        if (target && first) {
          viewport.scrollTo({
            left: target.offsetLeft - first.offsetLeft + (loops ? setWidthOnce() : 0),
            behavior: reducedMotion() ? 'auto' : 'smooth',
          });
        }
      });
      dots.append(dot);
      dotEls.push(dot);
    }
  }

  wrap.append(head, viewport, arrow('prev'), arrow('next'), dots);

  /**
   * Which page is on screen, from the scroll position rather than from a
   * counter we increment. A counter and a scroller disagree the moment
   * anybody uses a trackpad.
   */
  const markDot = () => {
    if (!dotEls.length) return;
    const one = loops ? setWidthOnce() : 0;
    const width = viewport.clientWidth || 1;
    const offset = loops ? viewport.scrollLeft - one : viewport.scrollLeft;
    const page = ((Math.round(offset / width) % pages) + pages) % pages;
    dotEls.forEach((d, i) => { d.dataset.on = String(i === page); });
  };
  requestAnimationFrame(markDot);
  if (!loops) viewport.addEventListener('scroll', markDot);

  if (loops) {
    /**
     * Start on the middle set, and wrap when a boundary is crossed.
     *
     * Measured BETWEEN TILES, never as scrollWidth / 3. The track carries the
     * page margin as its own left and right padding, so scrollWidth is three
     * sets plus 80px — dividing it by three puts a third of that padding into
     * every set, and the row opens a fraction of a tile off, with the first
     * title sliced down its left edge. The distance from one set's first tile
     * to the next set's first tile is the set width by definition, padding
     * and gaps included, and it needs no arithmetic to be right.
     */
    const kids = () => track.children;
    const setWidth = () => {
      const all = kids();
      if (all.length < rows.length * 2 + 1) return 0;
      return all[rows.length].offsetLeft - all[0].offsetLeft;
    };
    /**
     * Home is ONE SET WIDTH, and nothing more.
     *
     * At scrollLeft 0 the first clone sits at the track's left padding, which
     * is the page margin. Scrolling by exactly one set puts the first REAL
     * tile in that same spot, margin included — so the padding never enters
     * the arithmetic. Trying to compute the tile's own offset instead landed
     * the row flush against the rail's edge and sliced the first title down
     * its left side.
     */
    const home = setWidth;
    requestAnimationFrame(() => { viewport.scrollLeft = home(); });

    let wrapping = false;
    viewport.addEventListener('scroll', () => {
      if (wrapping) return;
      const one = setWidth();
      if (one <= 0) return;
      const start = home();
      const x = viewport.scrollLeft;
      // Half a set of slack either side, so a wrap never lands mid-gesture.
      if (x < start - one * 0.5 || x > start + one * 0.5) {
        wrapping = true;
        viewport.scrollLeft = x < start ? x + one : x - one;
        // Cleared on the next frame, not synchronously: the assignment above
        // fires this same handler again.
        requestAnimationFrame(() => { wrapping = false; });
      }
      markDot();
    });
  }

  return wrap;
}

function section(title, count, tiles) {
  const wrap = document.createElement('section');
  wrap.className = 'browsesec';

  const head = document.createElement('div');
  head.className = 'browsesec__head';
  const h = document.createElement('h3');
  h.className = 'browsesec__title';
  h.textContent = title;
  const n = document.createElement('span');
  n.className = 'browsesec__n';
  n.textContent = String(count);
  head.append(h, n);

  const list = document.createElement('ul');
  list.className = 'tiles';
  list.append(...tiles);

  wrap.append(head, list);
  return wrap;
}

/**
 * One tile. The artwork is filled in asynchronously and may never arrive — a
 * frame grab means decoding a multi-GB file — so the initials go down first and
 * the image replaces them if and when it lands.
 */
function tile({ name, sub, subStrong, initials, thumbFrom, artKey, fraction, onOpen }) {
  const li = document.createElement('li');
  li.className = 'tile';
  li.tabIndex = 0;

  const art = document.createElement('div');
  art.className = 'tile__art';
  art.dataset.empty = 'true';
  art.dataset.initials = initials;

  if (fraction > 0) {
    const bar = document.createElement('div');
    bar.className = 'tile__bar';
    const fill = document.createElement('i');
    fill.style.width = `${Math.min(100, fraction * 100)}%`;
    bar.append(fill);
    art.append(bar);
  }

  const label = document.createElement('div');
  label.className = 'tile__name';
  label.textContent = name;

  const meta = document.createElement('div');
  meta.className = 'tile__sub';
  if (subStrong) {
    const b = document.createElement('b');
    b.textContent = subStrong;
    meta.append(b, document.createTextNode(` ${sub}`));
  } else {
    meta.textContent = sub;
  }

  li.append(art, label, meta);
  li.addEventListener('click', onOpen);
  li.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(); }
  });

  if (thumbFrom || artKey) paintArt(art, thumbFrom || [], artKey);

  return li;
}

/**
 * Fill a tile's artwork, cheaply first and expensively only if it has to.
 *
 * Two measurements drove this. Of 27 shows, 3 had a cached frame for their
 * FIRST episode — which is what a tile naively asks for — while 18 had one
 * cached for SOME episode, because the cache fills with whatever the bumper
 * happened to show. Asking for a frame that already exists is six times more
 * artwork for no work at all.
 *
 * And the fallback is not cheap: a miss means seeking a multi-gigabyte file and
 * decoding a frame out of it. Opening a gallery of 27 shows and 14 movies fired
 * 41 of those at once, all against the same disk. getThumb is a file read and
 * never decodes, so every candidate can be probed before anything is decoded.
 */
/**
 * Permanent artwork, cached per session — HITS only. Misses are deliberately
 * not cached (see artFor): the background sweep lands art all session long,
 * and a remembered null would hide it until restart. Cleared wholesale on
 * scan and after an ingest; a chosen image clears its own key.
 */
const artworkCache = new Map();

async function artFor(kind, id) {
  if (!kind || !id || !window.tv.getArtwork) return null;
  const key = `${kind}\n${id}`;
  if (artworkCache.has(key)) return artworkCache.get(key);
  const dataUrl = await window.tv.getArtwork(kind, id).catch(() => null);
  /**
   * Misses are NOT cached. The background sweep lands art all session long,
   * and a remembered null would hide every capture made after the first
   * gallery open until a restart — the feature looking broken on exactly the
   * first-run session it exists for. A miss costs one cheap IPC per paint.
   */
  if (dataUrl) artworkCache.set(key, dataUrl);
  return dataUrl;
}

async function paintArt(art, candidates, artKey) {
  const list = (Array.isArray(candidates) ? candidates : [candidates]).filter(Boolean);

  /**
   * Tiles are rebuilt per render, so isConnected catches their stale paints —
   * but #detailArt is one static element reused by every show card. Opening
   * card B while card A's slower decode is in flight would let A's frame land
   * on B. The stamp makes the later call the only one allowed to paint.
   */
  const stamp = String((Number(art.dataset.paintStamp) || 0) + 1);
  art.dataset.paintStamp = stamp;

  const show = (dataUrl) => {
    if (!dataUrl || !art.isConnected || art.dataset.paintStamp !== stamp) return false;
    const img = document.createElement('img');
    img.src = dataUrl;
    img.alt = '';
    art.dataset.empty = 'false';
    art.prepend(img);
    return true;
  };

  /**
   * The permanent store outranks everything: it holds either a deliberate
   * capture or an image the user chose by hand, and both beat whatever frame
   * the thumbnail cache happens to have.
   */
  if (artKey) {
    const kept = await artFor(artKey.kind, artKey.id);
    if (kept && show(kept)) return;
  }

  if (!list.length) return;

  for (const candidate of list) {
    if (!candidate.absPath) continue;
    /**
     * The in-memory cache sits right beside this loop and used to be ignored:
     * every gallery open re-fetched every visible tile over IPC as fresh
     * base64. A remembered frame paints instantly; a remembered null means the
     * file already failed to decode this session, so neither the IPC nor the
     * decode queue will produce anything for it.
     */
    const known = thumbCache.get(candidate.absPath);
    if (known === null) continue;
    if (known) {
      if (show(known)) return;
      continue; // a remembered frame that would not paint will not paint from IPC either
    }
    const cached = await window.tv.getThumb(candidate.absPath).catch(() => null);
    if (cached) {
      thumbCache.set(candidate.absPath, cached);
      if (show(cached)) return;
    }
  }

  queueDecode(list[0], show);
}

/**
 * Decoding, three at a time.
 *
 * Unbounded, this is 41 concurrent seeks into 41 large files, which is a stalled
 * window and a thrashing disk rather than a gallery. Three keeps something
 * arriving without the app going away.
 */
const THUMB_CONCURRENCY = 3;
const decodeQueue = [];
let decodesRunning = 0;

function queueDecode(episode, onReady) {
  decodeQueue.push({ episode, onReady });
  pumpDecodes();
}

function pumpDecodes() {
  while (decodesRunning < THUMB_CONCURRENCY && decodeQueue.length) {
    const job = decodeQueue.shift();
    decodesRunning += 1;
    ensureThumb(job.episode)
      .then(job.onReady)
      .catch(() => {})
      .finally(() => { decodesRunning -= 1; pumpDecodes(); });
  }
}

/** Leaving the gallery abandons work nobody is waiting for. */
function dropPendingDecodes() {
  decodeQueue.length = 0;
}

function showTile(show) {
  const watched = watchedCount(show, state);
  return tile({
    name: show.name,
    initials: initialsOf(show.name),
    sub: `episodes · ${watched} watched`,
    subStrong: String(show.episodeCount),
    // The episode the library is up to is the one most likely already
    // decoded, because it is the one that was most recently played.
    thumbFrom: [show.episodes[resumePoint(show, state).episodeIndex], ...show.episodes.slice(0, 6)],
    artKey: { kind: 'show', id: show.id },
    fraction: show.episodeCount ? watched / show.episodeCount : 0,
    onOpen: () => openDetail(show),
  });
}

function movieTile(movie) {
  return tile({
    name: movie.name,
    initials: initialsOf(movie.name),
    sub: movie.year ? String(movie.year) : 'Movie',
    thumbFrom: [{ absPath: movie.absPath, mediaUrl: movie.mediaUrl }],
    artKey: { kind: 'movie', id: movie.relPath },
    fraction: 0,
    onOpen: () => playMovieFromLibrary(movie),
  });
}

/**
 * A Continue Watching tile names the EPISODE, not the show — "what was I in the
 * middle of" is answered by "Big O, episode nine", and a tile that only says
 * Big O makes you open the card to find out.
 */
/**
 * A rail card is NOT a grid tile.
 *
 * The grid below is for browsing, so its tiles carry counts and captions
 * under the art. This row is for resuming one specific thing, and every extra
 * line is one more thing to read before doing that. So the card is the
 * picture: the frame fills it, the title sits IN it over the lower third, and
 * the only other marks are the episode code and how far in you are.
 *
 * Selective Attention: at three-up and edge to edge, the artwork is doing the
 * identifying. A caption block underneath would be read second and add
 * nothing the frame did not already say.
 *
 * No progress bar either. It is real information and it is still on the grid
 * below, where browsing is the job — but on a full-bleed strip of picture it
 * is a second amber mark competing with the title for the same lower third,
 * and this row has to stay quiet enough to read as one image per card. The
 * episode code says where you are; that is enough.
 */
function railCard({ name, code, initials, thumbFrom, onOpen }) {
  const li = document.createElement('li');
  li.className = 'railcard';
  li.tabIndex = 0;

  const art = document.createElement('div');
  art.className = 'railcard__art tile__art';
  art.dataset.empty = 'true';
  art.dataset.initials = initials;

  // A scrim, not a panel. The title has to stay legible over a bright frame
  // without putting a box on top of the picture.
  const scrim = document.createElement('div');
  scrim.className = 'railcard__scrim';

  const text = document.createElement('div');
  text.className = 'railcard__text';
  const title = document.createElement('div');
  title.className = 'railcard__title';
  title.textContent = name;
  text.append(title);
  if (code) {
    const meta = document.createElement('div');
    meta.className = 'railcard__code mono';
    meta.textContent = code;
    text.append(meta);
  }

  li.append(art, scrim, text);
  li.addEventListener('click', onOpen);
  li.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(); }
  });
  paintArt(art, thumbFrom || [], null);
  return li;
}

function continueTile(row) {
  if (row.kind === 'movie') {
    return railCard({
      name: row.name,
      code: 'Movie',
      initials: initialsOf(row.name),
      thumbFrom: [{ absPath: row.movie.absPath, mediaUrl: row.movie.mediaUrl }],
      onOpen: () => playMovieFromLibrary(row.movie),
    });
  }
  return railCard({
    name: row.name,
    code: formatEpisodeLabel(row.episode),
    initials: initialsOf(row.name),
    thumbFrom: [row.episode],
    onOpen: () => playFromLibrary(row.show, row.episodeIndex),
  });
}

// -- the show card ----------------------------------------------------------

function openDetail(show) {
  browseDetailShow = show;
  const watched = watchedCount(show, state);
  const point = resumePoint(show, state);
  const next = show.episodes[point.episodeIndex];

  el('detailTitle').textContent = show.name;
  el('detailMeta').textContent =
    `${show.episodeCount} episode${show.episodeCount === 1 ? '' : 's'} · ${watched} watched`;

  const art = el('detailArt');
  art.textContent = '';
  art.dataset.empty = 'true';
  art.dataset.initials = initialsOf(show.name);
  paintArt(art, next ? [next, ...show.episodes.slice(0, 6)] : [], { kind: 'show', id: show.id });

  const play = el('btnDetailPlay');
  play.textContent = point.seekTo > 0
    ? `Resume ${formatEpisodeLabel(next)}`
    : (watched > 0 ? `Play ${formatEpisodeLabel(next)}` : 'Play');

  renderEpisodes(show);
  el('browseDetail').hidden = false;
  play.focus();
}

function closeDetail() {
  el('browseDetail').hidden = true;
  browseDetailShow = null;
}

function detailOpen() {
  return !el('browseDetail').hidden;
}

function renderEpisodes(show) {
  const list = el('detailEpisodes');
  list.textContent = '';

  show.episodes.forEach((episode, index) => {
    const li = document.createElement('li');
    li.className = 'ep';
    li.dataset.status = episodeStatus(show, index, state);

    const art = document.createElement('div');
    art.className = 'ep__art';

    // Plenty of these files carry no episode title. Falling back to the
    // filename printed "S01E01.mkv" directly under "S01E01" — the same string
    // twice, one of them with an extension on it. When there is no title the
    // code IS the name, and the row says it once.
    const body = document.createElement('div');
    body.className = 'ep__body';
    if (episode.title) {
      const code = document.createElement('div');
      code.className = 'ep__code';
      code.textContent = formatEpisodeLabel(episode);
      const name = document.createElement('div');
      name.className = 'ep__name';
      name.textContent = episode.title;
      body.append(code, name);
    } else {
      const name = document.createElement('div');
      name.className = 'ep__name';
      name.textContent = formatEpisodeLabel(episode);
      body.append(name);
    }

    const tick = document.createElement('span');
    tick.className = 'ep__tick';
    tick.textContent = li.dataset.status === 'watched' ? '✓' : '';

    li.append(art, body, tick);
    li.addEventListener('click', () => playFromLibrary(show, index));
    list.append(li);

    // Only the first dozen are asked for up front. Twenty-six shows at a
    // hundred-and-nine episodes each is a lot of multi-gigabyte files to start
    // seeking through the moment a card opens.
    if (index < 12) {
      paintArt(art, [episode], { kind: 'episode', id: episode.relPath });
    }
  });
}

// -- playing from the library ----------------------------------------------

function playFromLibrary(show, episodeIndex, seekTo) {
  const item = browseEpisodeItem(show, episodeIndex);
  if (!item) return;

  const point = seekTo === undefined && episodeIndex === resumePoint(show, state).episodeIndex
    ? resumePoint(show, state).seekTo
    : (seekTo || 0);

  browseItem = { kind: 'show', show, episodeIndex };
  app.dataset.browsing = 'true';
  closeBrowse();
  loadAndPlay(item, point);
}

function playMovieFromLibrary(movie) {
  browseItem = { kind: 'movie', movie };
  app.dataset.browsing = 'true';
  closeBrowse();
  loadAndPlay(movieItem(movie), movieResumePoint(movie, state).seekTo);
}

/**
 * The end of an episode in library mode.
 *
 * Straight into the next one, which is what "watch a whole show" means. The
 * last episode drops back to the show card rather than looping to the start or
 * silently handing over to the channel — both of those are surprises.
 */
function browseEpisodeEnded() {
  const { kind, show, episodeIndex, movie } = browseItem || {};

  if (kind === 'movie') {
    state = markMovie(state, movie, player.duration || 0, player.duration, Date.now());
    persist();
    browseItem = null;
    openBrowse();
    return;
  }

  state = markEpisode(state, show, episodeIndex, player.duration || 0, player.duration, Date.now());
  persist();

  const nextIndex = episodeIndex + 1;
  if (show.episodes[nextIndex]) {
    playFromLibrary(show, nextIndex, 0);
    return;
  }

  browseItem = null;
  openBrowse();
  openDetail(show);
}

/** Where library mode writes its position, in place of state.resume. */
function browseTimeUpdate() {
  const { kind, show, episodeIndex, movie } = browseItem || {};
  if (kind === 'movie') {
    state = markMovie(state, movie, player.currentTime, player.duration, Date.now());
  } else if (show) {
    state = markEpisode(state, show, episodeIndex, player.currentTime, player.duration, Date.now());
  } else {
    return;
  }
  persist();
}

function wireBrowse() {
  el('btnBrowse').addEventListener('click', openBrowse);
  el('btnBrowseChannel').addEventListener('click', backFromBrowse);
  el('btnBrowseLeave').addEventListener('click', backToChannel);

  el('browseSearch').addEventListener('input', (event) => {
    browseQuery = String(event.target.value || '').trim().toLowerCase();
    renderBrowse();
  });

  el('btnDetailClose').addEventListener('click', closeDetail);
  el('detailBackdrop').addEventListener('click', closeDetail);
  el('btnDetailPlay').addEventListener('click', () => {
    if (!browseDetailShow) return;
    const point = resumePoint(browseDetailShow, state);
    playFromLibrary(browseDetailShow, point.episodeIndex, point.seekTo);
  });
}
