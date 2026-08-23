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
} from '../shared/scheduler.js';
import { TIER, needsFallback } from '../shared/playability.js';
import {
  SHOW,
  MOVIE,
  lockableItems,
  earnUnlocks,
  isLocked,
  lockLabel,
  episodeLabel,
  wouldCycle,
  setLock,
  resetUnlocks,
} from '../shared/locks.js';

// ---------------------------------------------------------------------------
// module state
// ---------------------------------------------------------------------------

const el = (id) => document.getElementById(id);
const app = el('app');
const player = el('player');

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

function setView(view) {
  app.dataset.view = view;
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
function clearToast() {
  clearTimeout(toastTimer);
  el('toast').dataset.show = 'false';
}

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
  el('rootLabel').textContent = state.rootPath || 'No folder chosen';

  const episodeCount = shows.reduce((n, s) => n + s.episodes.length, 0);
  el('libraryStats').textContent = shows.length
    ? `${shows.length} shows · ${episodeCount} episodes`
    : '';
  el('showCount').textContent = shows.length ? String(shows.length) : '';

  const list = el('showList');
  list.textContent = '';
  const disabled = new Set(state.settings.disabledShows || []);
  const marathonId = state.settings.marathonShowId || null;

  for (const show of shows) {
    const cursor = state.cursors[show.id] || { index: 0 };
    const position = Math.min(cursor.index, show.episodes.length);
    const nextEpisode = show.episodes[position % show.episodes.length];
    const off = disabled.has(show.id);

    const li = document.createElement('li');
    li.className = 'show';
    li.dataset.off = String(off);
    li.dataset.showId = show.id;
    li.title = off ? 'Switched off — click to include' : 'Click to switch off';

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

    li.append(name, toggle, meta, bar, showControls(show, marathonId === show.id));
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
}

function renderSettings() {
  const marathonId = state.settings.marathonShowId || null;
  const marathonShow = marathonId ? shows.find((s) => s.id === marathonId) : null;

  renderLockSummary();

  // Rebuilt from `shows` each time so a rescan cannot leave the picker offering
  // a show that is no longer in the folder.
  const select = el('marathonSelect');
  select.textContent = '';
  const off = document.createElement('option');
  off.value = '';
  off.textContent = shows.length ? 'Off — play everything' : 'No shows yet';
  select.append(off);
  for (const show of shows) {
    const option = document.createElement('option');
    option.value = show.id;
    option.textContent = show.name;
    select.append(option);
  }
  select.value = marathonShow ? marathonShow.id : '';
  select.disabled = shows.length === 0;
  el('marathonField').dataset.on = String(Boolean(marathonShow));

  // Rotation governs which show comes next, which is exactly what a marathon
  // takes over — so the buttons are dimmed rather than left looking broken.
  el('modeGroup').dataset.muted = String(Boolean(marathonShow));

  for (const button of document.querySelectorAll('.mode')) {
    button.setAttribute('aria-pressed', String(button.dataset.mode === state.settings.mode));
  }
  el('modeNote').textContent = marathonShow
    ? `Paused while the ${marathonShow.name} marathon runs.`
    : (MODE_NOTES[state.settings.mode] || '');

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

  const theme = THEMES.includes(state.settings.theme) ? state.settings.theme : 'midnight';
  el('themeSelect').value = theme;
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
   * Start converting the episode this card is announcing, and hold the card up
   * until it is ready.
   *
   * This is the point of having an interstitial at all: the countdown is dead
   * time we were spending anyway, so any conversion that has not finished gets
   * to finish HERE, in front of something worth looking at, instead of after
   * the countdown against a black screen that reads as the app having frozen.
   */
  let leadReady = false;
  let waitingShown = false;
  prepareItem(lead).then(() => { leadReady = true; });

  // Everything behind it keeps warming too, so a burst of skipping later does
  // not land straight back on a wait.
  prepareAhead();

  const prepLabel = el('bumperPrep');
  prepLabel.hidden = true;
  let convertedMs = 0;
  const stopProgress = window.tv.onPrepareProgress
    ? window.tv.onPrepareProgress((payload) => {
      if (payload && payload.absPath === lead.episode.absPath) convertedMs = payload.outMs || 0;
    })
    : null;

  /** Swap the "any key" hint for honest progress once we are actually waiting. */
  const showWaiting = () => {
    if (waitingShown) return;
    waitingShown = true;
    el('bumperSkip').hidden = true;
    prepLabel.hidden = false;
  };

  // A conversion that has gone wrong must not strand the channel on this card.
  const HOLD_LIMIT_MS = 240000;
  const holdStartedAt = performance.now();

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
    if (stopProgress) stopProgress();
    // Restore the card's resting state, or the next one opens mid-wait.
    el('bumperSkip').hidden = false;
    prepLabel.hidden = true;
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
    if (remaining > 0) return;

    if (leadReady) { finish(); return; }

    // Countdown is spent but the episode is not ready. Hold, and say why —
    // a card that visibly waits is honest; a black screen is a bug report.
    showWaiting();
    prepLabel.textContent = convertedMs > 0
      ? `Preparing — ${formatTime(convertedMs / 1000)} converted`
      : 'Preparing the next episode…';
    countLabel.textContent = '';
    fill.style.transform = 'scaleX(1)';

    // Give up eventually rather than sit here forever; loadAndPlay will report
    // the real failure and move on.
    if (performance.now() - holdStartedAt > HOLD_LIMIT_MS) finish();
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
 * absPath -> media:// URL that actually plays.
 *
 * For most files this is the original URL. For an .mkv it is usually a prepared
 * MP4 sitting in the cache, put there while the previous episode was playing.
 */
const playableUrls = new Map();

/**
 * Guards against a slow conversion finishing after the user has moved on.
 * Without it, skipping during a two-minute re-encode starts the episode you
 * skipped, on top of the one you skipped to.
 */
let playToken = 0;

/**
 * Get a URL that will actually play, converting first if the file needs it.
 * Returns null when the file cannot be made playable at all.
 */
async function resolvePlayable(item, token, forceTier) {
  const episode = item.episode;
  const absPath = episode.absPath;
  if (!absPath || !window.tv.ensurePlayable) return episode.mediaUrl;

  if (!forceTier && playableUrls.has(absPath)) return playableUrls.get(absPath);

  // Anything needing real work gets a message, because a silent ten-second gap
  // before an episode starts reads as the app having frozen.
  const slowNotice = setTimeout(() => {
    if (token === playToken) toast(`Preparing ${item.showName} ${item.label}…`, 60000);
  }, 600);

  // From here the viewer is waiting. Everything else converting gets out of the
  // way, and prepare-ahead stops starting new work until this is done.
  foregroundPath = absPath;
  foregroundSince = Date.now();
  await yieldDiskTo(absPath);

  let result;
  try {
    // Carry any audio override through, so a re-prepare (say, after a decode
    // failure) does not quietly revert the language the viewer picked.
    result = await window.tv.ensurePlayable(
      absPath,
      forceTier,
      audioOverride === null ? undefined : audioOverride,
    );
  } catch (error) {
    result = { ok: false, error: String(error) };
  } finally {
    clearTimeout(slowNotice);
    if (foregroundPath === absPath) foregroundPath = null;
  }

  if (token !== playToken) return null; // superseded; caller discards this

  if (result && result.ok && result.mediaUrl) {
    if (result.prepared) toast(`Ready — ${item.showName} ${item.label}`, 1800);
    else clearToast();
    playableUrls.set(absPath, result.mediaUrl);
    return result.mediaUrl;
  }

  clearToast();
  if (result && result.needsFfmpeg) {
    toast(`${item.showName} ${item.label} needs converting, but ffmpeg is not installed.`, 6000);
  } else if (result && result.lowDisk) {
    toast('Not enough free disk space to prepare this episode.', 6000);
  } else if (result && result.reason !== 'cancelled') {
    toast(`Could not prepare ${item.showName} ${item.label}.`, 4500);
  }
  return null;
}

/** How many episodes ahead to keep converted. */
const PREPARE_DEPTH = 3;

/** In-flight preparations, so two callers never start the same job twice. */
const preparing = new Map();

/**
 * Ensure one item is converted, returning the playable URL (or null).
 *
 * Safe to call repeatedly for the same episode from anywhere — the promise is
 * shared, so the bumper waiting on it and the prepare-ahead loop starting it
 * are the same job rather than two.
 */
function prepareItem(item) {
  const absPath = item && item.episode ? item.episode.absPath : null;
  if (!absPath || !window.tv.ensurePlayable) {
    return Promise.resolve(item ? item.episode.mediaUrl : null);
  }
  if (playableUrls.has(absPath)) return Promise.resolve(playableUrls.get(absPath));
  if (preparing.has(absPath)) return preparing.get(absPath);

  const job = window.tv.ensurePlayable(absPath)
    .then((result) => {
      preparing.delete(absPath);
      if (result && result.ok && result.mediaUrl) {
        playableUrls.set(absPath, result.mediaUrl);
        return result.mediaUrl;
      }
      return null;
    })
    .catch(() => { preparing.delete(absPath); return null; });

  preparing.set(absPath, job);
  return job;
}

/**
 * Convert the next few episodes while this one plays.
 *
 * This is the whole reason the scheduler commits its queue in advance: we know
 * what is coming, so the work happens against a complete file with time to
 * spare instead of racing playback.
 *
 * Depth matters more than it looks. Preparing only ONE ahead is enough for
 * someone watching straight through, but anyone pressing Next outruns it
 * immediately and lands on the wait this exists to remove. Three deep survives
 * a burst of skipping.
 *
 * Jobs are started in order and NOT awaited together: converting three files at
 * once would have them contend for the same disk while an episode is playing
 * off it, making all three slower than doing them in turn.
 */
/**
 * The file the viewer is actually waiting on, if any.
 *
 * There is no concurrency limit in the main process, so a background
 * conversion and the one being waited on run at the same time and halve each
 * other's throughput — which is exactly the "a show and a movie both sitting
 * there converting" case. While this is set, prepare-ahead stands down.
 */
let foregroundPath = null;
let foregroundSince = 0;

/**
 * Is someone waiting on a conversion right now?
 *
 * Treated as stale after ten minutes rather than trusted indefinitely. A flag
 * that leaked would stop prepare-ahead for the rest of the session — turning a
 * fix for waiting into a much better generator of it — and no single
 * conversion this app performs runs that long.
 */
function foregroundBusy() {
  if (!foregroundPath) return false;
  if (Date.now() - foregroundSince > 600000) { foregroundPath = null; return false; }
  return true;
}

/**
 * Give the whole disk to one file, cancelling anything else mid-conversion.
 *
 * Cancelled work is discarded rather than resumed, which sounds wasteful — but
 * the alternative is the viewer waiting twice as long for the thing on screen
 * so that a file they will not see for twenty minutes can finish early. The
 * cancelled item is picked up again by the next prepare-ahead pass.
 */
async function yieldDiskTo(absPath) {
  if (!window.tv.cacheInfo || !window.tv.cancelPrepare) return;
  const info = await window.tv.cacheInfo().catch(() => null);
  for (const job of (info && info.jobs) || []) {
    if (job.absPath && job.absPath !== absPath) {
      preparing.delete(job.absPath);
      await window.tv.cancelPrepare(job.absPath).catch(() => {});
    }
  }
}

async function prepareAhead(depth = PREPARE_DEPTH) {
  // Whatever is on screen comes first; this can wait for the next call.
  if (foregroundBusy()) return;

  const upcoming = peek(shows, state, depth);

  /**
   * The movie goes SECOND, not last.
   *
   * It is the longest conversion this app ever performs, and it is the one
   * with a hard deadline a few blocks out — but the episode immediately next
   * is the one someone is about to sit and wait for, so that still goes first.
   */
  const movie = state.pendingMovie ? movieItem(state.pendingMovie) : null;
  const order = movie
    ? [upcoming[0], movie, ...upcoming.slice(1)].filter(Boolean)
    : upcoming;
  if (order.length === 0) return;

  // Protect what is playing and what is queued from cache eviction.
  const keep = [current, ...order]
    .filter(Boolean)
    .map((entry) => playableUrls.get(entry.episode && entry.episode.absPath))
    .filter(Boolean)
    .map((url) => decodeURIComponent(String(url).replace(/^media:\/\/local\//, '')));
  if (window.tv.pinPrepared) window.tv.pinPrepared(keep);

  for (const item of order) {
    // Re-checked each time round: the viewer may have started waiting on
    // something while the previous conversion was running.
    if (foregroundBusy()) return;
    // Not token-guarded: the result goes to the on-disk cache, so work is never
    // wasted even if the user skips past this episode before it comes round.
    await prepareItem(item);
  }
}

async function loadAndPlay(item, seekTo = 0) {
  // Tear down a clip still on screen (the user pressed Next through it) without
  // running its onDone, which would advance the queue a second time.
  if (bumperClipCleanup) bumperClipCleanup();

  const token = ++playToken;
  current = item;
  setView('playing');
  renderNowPlaying(item);

  // Every episode starts fresh: English audio, subtitles off. An override is a
  // decision about the episode you are watching, not a setting that follows you
  // into the next show.
  audioOverride = null;
  activeSubIndex = null;
  clearSubtitles();
  toggleTrackMenu(false);
  // Episodes are never zoomed — only the interstitials are.
  applyPicture(false);

  const url = await resolvePlayable(item, token);
  if (token !== playToken) return;      // the user moved on while we prepared

  if (!url) {
    // Skipping to the next episode is right for ONE bad file. But this path
    // re-enters loadAndPlay, so a run of them recurses with nothing to stop it
    // and locks the window solid. Give up after a few and say so.
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
  failedInARow = 0;

  player.src = url;
  player.load();

  const start = () => {
    if (seekTo > 0 && Number.isFinite(player.duration)) {
      player.currentTime = Math.min(seekTo, Math.max(0, player.duration - 5));
    }
    // The crop transform is computed from videoWidth/videoHeight, which are 0
    // until metadata arrives. A cached crop resolves instantly — well before
    // that — so applying it only when it arrives would silently do nothing.
    // Re-applying here means whichever lands last is the one that counts.
    applyPicture(false);
    player.play().catch(() => {
      toast('Could not start playback. Press space to try again.');
    });
  };
  player.addEventListener('loadedmetadata', start, { once: true });

  showChrome();
  renderSidebar();
  persist({ immediate: true });

  // Read this episode's tracks so the menu is populated before it is opened.
  loadTracksForCurrent();
  loadCropForCurrent();

  // Warm the next bumper's thumbnail while this episode plays, so the
  // interstitial has a picture the moment it appears.
  const upcoming = peek(shows, state, 1)[0];
  if (upcoming) setTimeout(() => ensureThumb(upcoming.episode), 4000);

  // Start converting the next episodes shortly in — long enough not to fight
  // this episode's own startup for disk bandwidth, short enough that a 22
  // minute episode leaves an enormous margin.
  setTimeout(() => { if (token === playToken) prepareAhead(); }, 2000);
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

  // Clips get the same codec treatment as episodes — an AC3 .mkv bumper is
  // exactly as unplayable as an AC3 .mkv episode.
  const token = ++playToken;
  let url = clip.mediaUrl;
  if (clip.absPath && window.tv.ensurePlayable) {
    const result = await window.tv.ensurePlayable(clip.absPath).catch(() => null);
    if (token !== playToken) return;            // superseded while preparing
    if (result && result.ok && result.mediaUrl) url = result.mediaUrl;
    else { onDone(); return; }                  // not worth stalling the channel
  }

  let done = false;
  let watchdog = null;

  const teardown = () => {
    clearTimeout(watchdog);
    player.removeEventListener('ended', finish);
    player.removeEventListener('error', finish);
    player.removeEventListener('loadedmetadata', armFullWatchdog);
    bumperClipCleanup = null;
    delete app.dataset.bumperClip;
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
  app.dataset.bumperClip = 'true';
  setView('playing');
  // No transport over a clip: it is a few seconds long and the controls would
  // be acting on an episode that is no longer on screen.
  clearTimeout(chromeTimer);
  app.dataset.chrome = 'off';
  applyPicture(true);

  player.addEventListener('ended', finish, { once: true });
  player.addEventListener('error', finish, { once: true });
  player.src = url;
  player.load();
  player.play().catch(finish);

  // The clip is time we are spending anyway, and nothing is competing for the
  // disk while a few seconds of video plays — so convert the next episodes now.
  // Between this and the up-next card, an ordinary transition buys the better
  // part of a minute before the viewer waits on anything.
  prepareAhead();
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

  state.resume = null;

  // FIRST, before any of the interstitials. The whole transition — sting,
  // promo, card — is time we are spending anyway, and the conversion for what
  // comes next should be using all of it rather than starting part way in.
  prepareAhead();

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
    if (picked.movie) { renderSidebar(); prepareAhead(); }
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
      const after = () => (movieNow ? startMovie() : playNext());
      if (state.settings.bumperEnabled && state.settings.bumperSeconds > 0) {
        showBumper(after, movieNow ? movieItem(state.pendingMovie) : null);
      } else {
        after();
      }
    });
  });
}

// ---------------------------------------------------------------------------
// chrome auto-hide
// ---------------------------------------------------------------------------

function showChrome() {
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

  const eyebrow = document.createElement('p');
  eyebrow.className = 'eyebrow mono';
  eyebrow.textContent = resumable ? 'Pick up where you left off' : 'Ready';

  const title = document.createElement('h1');
  title.className = 'welcome__title';
  title.textContent = resumable ? resumable.show.name : 'Start the channel';

  const body = document.createElement('p');
  body.className = 'welcome__body';
  if (resumable) {
    body.textContent = `${formatEpisodeLabel(resumable.episode)}${resumable.episode.title ? ` · ${resumable.episode.title}` : ''} — ${formatTime(state.resume.position)} in.`;
  } else if (upcoming) {
    body.textContent = `First up: ${upcoming.showName} ${upcoming.label}${upcoming.title ? ` · ${upcoming.title}` : ''}.`;
  } else {
    body.textContent = 'No episodes are available. Switch a show back on in the list.';
  }

  const button = document.createElement('button');
  button.className = 'btn btn--signal';
  button.type = 'button';
  button.textContent = (canResumeInPlace() || resumable) ? 'Resume' : 'Start the channel';
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

  // Warm the front of the queue now, while the user is still reading the ready
  // screen. Without this the very first episode of a session is the one that
  // always waits, which is the worst possible first impression.
  prepareAhead();

  reportConversionNeeds();
}

/**
 * Say up front what this library will and will not be able to play.
 *
 * Without ffmpeg an AC3-audio episode fails at the moment it tries to start,
 * which reads as the app being broken rather than as a missing dependency. One
 * honest message after the scan is worth more than a skipped episode an hour
 * later, so this counts the files that would need converting and says so once.
 */
async function reportConversionNeeds() {
  if (!window.tv.capabilities) return;
  const caps = await window.tv.capabilities();
  if (caps.ffmpeg) return; // everything is convertible; nothing to warn about

  // Only sample what is actually coming up — inspecting a 2000-episode library
  // would read thousands of file headers to produce one sentence.
  const upcoming = peek(shows, state, 12);
  const seen = new Set();
  let blocked = 0;

  for (const item of upcoming) {
    const absPath = item.episode && item.episode.absPath;
    if (!absPath || seen.has(absPath)) continue;
    seen.add(absPath);
    const result = await window.tv.inspect(absPath).catch(() => null);
    // remux is survivable without ffmpeg — the player is given a chance anyway.
    if (result && result.ok && result.plan.needsWork && result.plan.tier !== TIER.REMUX) blocked += 1;
  }

  if (blocked > 0) {
    toast(
      `${blocked} of the next ${seen.size} episodes need converting (usually AC3 audio). Install ffmpeg to play them.`,
      9000,
    );
  }
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
 * Push subtitle appearance into the page.
 *
 * ::cue is a pseudo-element, so it cannot be styled inline on the track — the
 * only way to reach it is a real stylesheet, rewritten whenever the settings
 * change.
 */
function applySubtitleStyle() {
  const cue = cueSettings();
  const background = cue.background ? rgba('#000000', cue.backgroundOpacity / 100) : 'transparent';
  // With no box behind it, text needs its own edge or it vanishes over a light
  // scene. The shadow is only paid for when the box is off.
  const shadow = cue.background
    ? 'none'
    : '0 2px 4px rgba(0,0,0,0.95), 0 0 3px rgba(0,0,0,1)';

  el('cueStyle').textContent = [
    'video::cue {',
    `  color: ${cue.color};`,
    `  background-color: ${background};`,
    `  font-family: ${CUE_FONTS[cue.font] || CUE_FONTS.sans};`,
    `  font-size: ${cue.size}%;`,
    `  text-shadow: ${shadow};`,
    '}',
  ].join('\n');

  applyCuePlacement();
}

/**
 * Move the cues up or down the frame.
 *
 * Placement is not a CSS property — ::cue cannot be positioned. It is a
 * property of each CUE, so it has to be written onto every cue of every loaded
 * track, and again whenever a new track loads.
 */
function applyCuePlacement() {
  const position = cueSettings().position;
  const line = position === 'top' ? 8 : position === 'middle' ? 48 : 88;
  for (const track of player.textTracks) {
    if (!track.cues) continue;
    for (const cue of track.cues) {
      try {
        cue.snapToLines = false;   // makes `line` a percentage of the frame
        cue.line = line;
        cue.position = 50;
        cue.align = 'center';
      } catch { /* some cues refuse; leave them where they are */ }
    }
  }
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
 * Scale bumpers and promos only, to crop bars baked INTO those files.
 *
 * Episodes are never touched. Their shape is handled entirely by CSS
 * `object-fit: contain`, which already does the right thing: largest size that
 * fits, aspect intact, leftover space black on whichever axis has it, and
 * recomputed on every resize. A file with bars encoded into the picture is a
 * different problem — object-fit cannot see them as bars — so those get scaled
 * off the edge, and only there.
 */
function applyPicture(isInterstitial) {
  const settings = state.settings || {};
  const zoom = Math.max(100, Number(settings.interstitialZoom) || 100);
  const crop = (!isInterstitial && settings.autoCrop !== false) ? currentCrop : null;

  if (!crop || !crop.worthCropping) {
    player.style.transform = isInterstitial && zoom > 100 ? `scale(${zoom / 100})` : '';
    return;
  }

  const box = player.getBoundingClientRect();
  const vw = player.videoWidth;
  const vh = player.videoHeight;
  if (!vw || !vh || !box.width || !box.height) { player.style.transform = ''; return; }

  // The size object-fit: contain actually draws the frame at. Everything below
  // is measured against that rather than the element, because the frame does
  // not fill the element on the axis that has bars.
  const fit = Math.min(box.width / vw, box.height / vh);
  const drawnW = vw * fit;
  const drawnH = vh * fit;

  // The real picture inside that frame, and how far its centre sits from the
  // frame's centre (zero for ordinary symmetrical pillarboxing).
  const contentW = crop.fw * drawnW;
  const contentH = crop.fh * drawnH;
  const offsetX = ((crop.fx + crop.fw / 2) - 0.5) * drawnW;
  const offsetY = ((crop.fy + crop.fh / 2) - 0.5) * drawnH;

  // Grow the content to fill the window, still without changing its shape.
  const scale = Math.min(box.width / contentW, box.height / contentH);

  // scale() runs first and translate() second, so the shift is written in
  // final, already-scaled pixels.
  player.style.transform =
    `translate(${(-offsetX * scale).toFixed(2)}px, ${(-offsetY * scale).toFixed(2)}px) `
    + `scale(${scale.toFixed(4)})`;
}

/**
 * Ask for the crop of the episode on screen and apply it.
 *
 * Detection needs ffmpeg and takes under a second, so it runs after playback
 * has already started — the picture snaps to full size a moment in rather than
 * delaying the episode, and the result is cached for next time.
 */
async function loadCropForCurrent() {
  currentCrop = null;
  applyPicture(false);

  const absPath = current && current.episode ? current.episode.absPath : null;
  if (!absPath || !window.tv.detectCrop || state.settings.autoCrop === false) return;

  const crop = await window.tv.detectCrop(absPath).catch(() => null);
  // The episode may have moved on while ffmpeg looked.
  if (!current || current.episode.absPath !== absPath) return;
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
  'midnight', 'mono', 'marigold', 'cathode', 'paper',
  'kawaii', 'neon', 'oceanic', 'nitrate', 'crimson',
  'forest', 'sunset', 'espresso', 'royal', 'slate',
  'ember', 'storm', 'arctic', 'mint', 'lilac',
];

/**
 * Themes whose panels are LIGHT.
 *
 * Adding a palette here is all it takes: applyTheme puts data-light on the
 * root, and the stylesheet hangs everything a light theme needs off that one
 * attribute — inverted type over the picture, outlines on cards that would
 * otherwise be tone on tone.
 */
const LIGHT_THEMES = ['marigold', 'paper', 'kawaii', 'arctic', 'mint', 'lilac'];

/**
 * Put the theme on <html>, not on #app.
 *
 * The settings sheet and the play-order table are rendered outside #app, so
 * anchoring the theme there would leave every dialog wearing the old palette.
 */
function applyTheme() {
  const wanted = String((state.settings || {}).theme || 'midnight');
  const theme = THEMES.includes(wanted) ? wanted : 'midnight';
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.light = String(LIGHT_THEMES.includes(theme));
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
      const label = `${episodeLabel(episode)}${episode.title ? ` · ${episode.title}` : ''}`;
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
// audio + subtitle tracks
// ---------------------------------------------------------------------------

/**
 * Which audio track the viewer chose for the episode ON SCREEN.
 *
 * Reset for every new episode, deliberately: English is the default and stays
 * the default. This only ever holds an explicit override of the current one.
 */
let audioOverride = null;

let currentTracks = { audio: [], subtitles: [], defaultAudioIndex: 0 };
let activeSubIndex = null;
let subtitleObjectUrl = null;

/** Drop any subtitle currently attached, and release its blob. */
function clearSubtitles() {
  for (const node of [...player.querySelectorAll('track')]) node.remove();
  if (subtitleObjectUrl) {
    URL.revokeObjectURL(subtitleObjectUrl);
    subtitleObjectUrl = null;
  }
}

/**
 * Show one subtitle track, or none.
 *
 * Subtitles are extracted to WebVTT and attached as a <track>, which Chromium
 * renders and toggles instantly — no reload, unlike audio. Image-based subtitle
 * formats cannot become text and are refused rather than silently doing nothing.
 */
async function setSubtitle(index) {
  if (!current) return;
  const absPath = current.episode.absPath;

  if (index === null || index === undefined) {
    clearSubtitles();
    activeSubIndex = null;
    renderTrackMenu();
    return;
  }

  const track = currentTracks.subtitles.find((s) => s.index === index);
  if (track && !track.usable) {
    toast('Those subtitles are images, not text — they cannot be switched on.', 5000);
    return;
  }

  toast('Loading subtitles…', 30000);
  const result = await window.tv.subtitleText(absPath, index).catch(() => null);
  if (!result || !result.ok || !result.vtt) {
    clearToast();
    toast(result && result.needsFfmpeg ? 'Subtitles need ffmpeg.' : 'Could not load those subtitles.', 4000);
    return;
  }
  // The episode may have moved on while ffmpeg worked.
  if (!current || current.episode.absPath !== absPath) return;

  clearSubtitles();
  subtitleObjectUrl = URL.createObjectURL(new Blob([result.vtt], { type: 'text/vtt' }));

  const node = document.createElement('track');
  node.kind = 'subtitles';
  node.label = track ? track.label : 'Subtitles';
  node.srclang = (track && track.language) || 'en';
  node.src = subtitleObjectUrl;
  node.default = true;
  player.append(node);
  // Set on load AND immediately: whichever fires first wins, and a track that
  // loads from a blob can be ready before the listener is attached.
  const show = () => {
    if (node.track) node.track.mode = 'showing';
    // Placement lives on each CUE, and the cues do not exist until the track
    // has parsed — so it has to be applied here as well as from settings.
    applyCuePlacement();
  };
  node.addEventListener('load', show, { once: true });
  show();

  activeSubIndex = index;
  clearToast();
  renderTrackMenu();
}

/**
 * Switch the audio language of the episode on screen.
 *
 * Chromium has no audio-track API, so this is not a toggle — it re-prepares the
 * file with a different track mapped and reloads at the same timestamp. Usually
 * fast (video is copied, only the sound is re-encoded) and instant if that
 * variant was prepared before, but it is real work, so the UI says so.
 */
async function switchAudio(index) {
  if (!current || index === audioOverride) return;
  const absPath = current.episode.absPath;
  const at = player.currentTime;
  const wasPlaying = !player.paused;
  const label = (currentTracks.audio.find((a) => a.index === index) || {}).label || `track ${index + 1}`;

  audioOverride = index;
  playableUrls.delete(absPath);
  renderTrackMenu();
  toast(`Switching audio to ${label}…`, 120000);

  const result = await window.tv.ensurePlayable(absPath, undefined, index).catch(() => null);
  if (!current || current.episode.absPath !== absPath) return;  // moved on

  if (!result || !result.ok || !result.mediaUrl) {
    clearToast();
    toast('Could not switch audio for this episode.', 4000);
    return;
  }

  playableUrls.set(absPath, result.mediaUrl);
  player.src = result.mediaUrl;
  player.load();
  player.addEventListener('loadedmetadata', () => {
    // Back to where they were, not to the start of the episode.
    if (Number.isFinite(player.duration)) player.currentTime = Math.min(at, player.duration - 1);
    if (wasPlaying) player.play().catch(() => {});
    // Text tracks do not survive a source change.
    if (activeSubIndex !== null) setSubtitle(activeSubIndex);
  }, { once: true });

  clearToast();
  toast(`Audio: ${label}`, 2200);
}

/** Read the current episode's tracks and draw the menu. */
async function loadTracksForCurrent() {
  if (!current || !current.episode.absPath || !window.tv.listTracks) {
    currentTracks = { audio: [], subtitles: [], defaultAudioIndex: 0 };
    return;
  }
  const absPath = current.episode.absPath;
  const result = await window.tv.listTracks(absPath).catch(() => null);
  if (!current || current.episode.absPath !== absPath) return;
  currentTracks = result && result.audio
    ? result
    : { audio: [], subtitles: [], defaultAudioIndex: 0 };
  renderTrackMenu();
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

  const activeAudio = audioOverride === null ? currentTracks.defaultAudioIndex : audioOverride;
  if (currentTracks.audio.length === 0) {
    audioList.append(row('No audio tracks found', false, () => {}, true));
  } else {
    for (const track of currentTracks.audio) {
      audioList.append(row(track.label, track.index === activeAudio, () => switchAudio(track.index)));
    }
  }

  subList.append(row('Off', activeSubIndex === null, () => setSubtitle(null)));
  for (const track of currentTracks.subtitles) {
    subList.append(row(
      track.usable ? track.label : `${track.label} — image-based`,
      track.index === activeSubIndex,
      () => setSubtitle(track.index),
      !track.usable,
    ));
  }

  const note = el('trackMenuNote');
  if (currentTracks.audio.length > 1) {
    note.textContent = 'Changing audio re-prepares the episode and resumes where you are.';
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
    renderTrackMenu();
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
  persist({ immediate: true });
}

function wireEvents() {
  el('btnPickFolder').addEventListener('click', pickFolder);
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

  el('marathonSelect').addEventListener('change', (event) => {
    const id = event.target.value;
    if (id) onShowControl(id, 'startMarathon');
    else onShowControl(null, 'endMarathon');
  });

  el('btnResetAll').addEventListener('click', () => {
    // Destructive and not undoable, and it is one click from the toggles people
    // use constantly — so it asks.
    const total = shows.reduce((n, s) => n + s.episodes.length, 0);
    if (!window.confirm(`Send all ${shows.length} shows back to episode 1?\n\n${total} episodes will be treated as unwatched. This cannot be undone.`)) return;
    state = resetProgress(shows, state, null, {});
    renderSidebar();
    if (app.dataset.view === 'ready') renderReady();
    persist({ immediate: true });
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
    persist({ immediate: true });
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
      prepareAhead();
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
    state = reshuffle(shows, state, {});
    persist();
    renderSidebar();
    const upcoming = peek(shows, state, 1)[0];
    toast(upcoming ? `Reshuffled — ${upcoming.showName} is up next.` : 'Reshuffled.', 3000);
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
    // Switching it on mid-episode should crop THIS episode, not the next one.
    if (event.target.checked && !currentCrop) loadCropForCurrent();
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
    persist({ immediate: true });
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

  el('scrub').addEventListener('click', (event) => {
    if (!Number.isFinite(player.duration)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    player.currentTime = ((event.clientX - rect.left) / rect.width) * player.duration;
  });

  // player
  // The crop transform is computed from the element's pixel size, so it has to
  // be recomputed whenever that changes.
  window.addEventListener('resize', () => applyPicture(playingBumperClip));

  player.addEventListener('ended', onEpisodeEnded);
  player.addEventListener('timeupdate', onTimeUpdate);
  player.addEventListener('progress', renderBuffer);
  player.addEventListener('play', () => { el('btnPlay').textContent = '❚❚'; showChrome(); });
  player.addEventListener('pause', () => { el('btnPlay').textContent = '▶'; showChrome(); });
  player.addEventListener('error', onPlaybackError);

  el('stage').addEventListener('mousemove', () => {
    if (app.dataset.view === 'playing') showChrome();
  });
  el('stage').addEventListener('dblclick', (event) => {
    if (app.dataset.view === 'playing' && event.target === player) toggleFullscreen();
  });
  player.addEventListener('click', togglePlay);

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

function renderBuffer() {
  if (!Number.isFinite(player.duration) || player.buffered.length === 0) return;
  const end = player.buffered.end(player.buffered.length - 1);
  el('scrubBuffer').style.width = `${(end / player.duration) * 100}%`;
}

/** Files we have already re-encoded once, so a second failure gives up. */
const escalated = new Set();

function onPlaybackError() {
  // A clip that will not play is not an episode failure — its own handler moves
  // the channel on, and escalating here would re-encode the wrong file and
  // skip an episode that was never given a chance.
  if (playingBumperClip) return;

  const name = current ? `${current.showName} ${current.label}` : 'that file';
  const absPath = current && current.episode ? current.episode.absPath : null;

  /**
   * A decode failure means the file needs converting, not that it is missing.
   * The codec tables are a prediction and two things beat them: H.265, whose
   * support depends on the machine rather than the file, and codec ids we have
   * never seen. Both are planned optimistically, so this is where a wrong guess
   * gets corrected — re-encode properly, once, rather than dropping an episode
   * that was only ever one conversion away from playing.
   */
  if (absPath && needsFallback(player.error) && !escalated.has(absPath)) {
    escalated.add(absPath);
    playableUrls.delete(absPath);

    const token = playToken;
    const item = current;
    resolvePlayable(item, token, TIER.FULL).then((url) => {
      if (token !== playToken) return;
      if (!url) {
        toast(`Could not play ${name} — skipping it.`, 4500);
        if (app.dataset.view === 'playing') playNext();
        return;
      }
      player.src = url;
      player.load();
      player.play().catch(() => {});
    });
    return;
  }

  toast(`Could not play ${name} — skipping it.`, 4500);
  setTimeout(() => { if (app.dataset.view === 'playing') playNext(); }, 1200);
}

function togglePlay() {
  if (app.dataset.view !== 'playing') return;
  if (player.paused) player.play().catch(() => {}); else player.pause();
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
    state.resume = {
      showId: current.showId,
      episodeIndex: current.episodeIndex,
      relPath: current.relPath,
      position: player.currentTime,
    };
    persist();
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

async function toggleFullscreen() {
  const next = !document.fullscreenElement;
  if (next) await document.documentElement.requestFullscreen().catch(() => {});
  else await document.exitFullscreen().catch(() => {});
  window.tv.setFullscreen(next);
}

function onGlobalKey(event) {
  // `event.target` is not always an Element — with nothing focused it can be
  // the document itself, which has no matches(). Calling it blind throws and
  // kills the handler for that keypress, so the key silently does nothing.
  const target = event.target;
  if (target && typeof target.matches === 'function'
      && target.matches('input, textarea, select')) return;

  // Checked before Settings, because it opens FROM Settings and sits on top:
  // Escape should peel off the sheet in front, not the one behind it.
  if (locksOpen()) {
    if (event.key === 'Escape') { event.preventDefault(); closeLocks(); }
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
    case 'f': case 'F': toggleFullscreen(); break;
    case 'n': case 'N': askSkip(); break;
    case 'l': case 'L':
      // A toggle, because that is what a single key on a panel should be —
      // and stepping back out resumes exactly what was paused rather than
      // advancing the channel.
      if (app.dataset.view === 'ready') {
        if (canResumeInPlace()) resumeInPlace(); else playNext();
      } else if (app.dataset.view === 'playing') {
        openLibrary();
      }
      break;
    case 'm': case 'M':
      el('btnMute').click();
      toast(state.settings.muted ? 'Muted' : 'Sound on', 1400);
      break;
    case 'Escape':
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
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
