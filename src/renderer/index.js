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
  blockSizeFor,
} from '../shared/scheduler.js';
import { TIER, needsFallback, audioIndexFromInspect, matchesLanguage } from '../shared/playability.js';
import { preparingCopy } from '../shared/prepProgress.js';
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

  const off = document.createElement('option');
  off.value = '';
  off.textContent = savedSchedules().length ? 'Off — shuffle the rotation' : 'No schedules yet';
  select.append(off);

  for (const sc of savedSchedules()) {
    const option = document.createElement('option');
    option.value = sc.id;
    const blocks = (sc.items || []).length;
    option.textContent = `${sc.name} · ${blocks} block${blocks === 1 ? '' : 's'}`;
    select.append(option);
  }

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

  /** When the card actually started waiting, as opposed to counting down. */
  let waitingSince = 0;

  /** Swap the "any key" hint for honest progress once we are actually waiting. */
  const showWaiting = () => {
    if (waitingShown) return;
    waitingShown = true;
    waitingSince = performance.now();
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

    /**
     * Hand the wait to a promo rather than sitting on a static card.
     *
     * Closing the card is safe: fillUntilReady runs immediately after it and
     * puts a promo up while the conversion carries on. If there is no promo to
     * spend, this does nothing and the card keeps holding as before, which is
     * still better than a black screen.
     */
    if (performance.now() - waitingSince > FILLER_HANDOFF_MS && fillerPromoAvailable()) {
      finish();
      return;
    }

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
/**
 * Can the player decode this file as it stands?
 *
 * Measured, not looked up. The codec tables read stream ids and guess; this
 * plays a few seconds and reads webkitVideoDecodedByteCount and
 * webkitAudioDecodedByteCount, which count bytes that came out of a DECODER.
 * Loading metadata proves only that the container parsed.
 *
 * The gap between the two is not academic. Measured against a real library of
 * 4K remuxes, the tables called eleven of fourteen files unplayable; the
 * player decoded video in all fourteen, and audio in nine. Two of the files
 * being converted were 58GB and 44GB, and each would have taken about an hour
 * to copy before it could start.
 *
 * Seeks in first, because the opening seconds of a remux are often black and
 * silent, and "nothing decoded" there is true and meaningless.
 */
const nativeVerdicts = new Map();

async function canPlayNatively(item) {
  const absPath = item.episode.absPath;
  const url = item.episode.mediaUrl;
  if (!absPath || !url || !window.tv.playbackVerdict) return null;
  if (nativeVerdicts.has(absPath)) return nativeVerdicts.get(absPath);

  const saved = await window.tv.playbackVerdict(absPath).catch(() => null);
  if (saved) { nativeVerdicts.set(absPath, saved); return saved; }

  const probe = document.createElement('video');
  probe.muted = true;
  probe.preload = 'auto';
  probe.crossOrigin = 'anonymous';
  let verdict = { video: false, audio: false };
  try {
    probe.src = url;
    await waitFor(probe, 'loadedmetadata', 15000);
    if (Number.isFinite(probe.duration) && probe.duration > 120) {
      probe.currentTime = 60;
      await waitFor(probe, 'seeked', 15000).catch(() => {});
    }
    await probe.play().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 2500));
    verdict = {
      video: (probe.webkitVideoDecodedByteCount || 0) > 0,
      audio: (probe.webkitAudioDecodedByteCount || 0) > 0,
    };
  } catch {
    verdict = { video: false, audio: false };
  } finally {
    probe.pause();
    probe.removeAttribute('src');
    probe.load();
  }

  nativeVerdicts.set(absPath, verdict);
  if (window.tv.savePlaybackVerdict) window.tv.savePlaybackVerdict(absPath, verdict);
  return verdict;
}

/**
 * Which audio track this file should be played with, per the plan.
 *
 * 0 means the first one, which is the only track the player can reach without
 * a conversion. Anything else means the file has to be rebuilt around the
 * right track, however large it is — a wrong-language episode is not a
 * cheaper version of the right one.
 *
 * Cached because it costs an ffprobe and is asked before every play.
 */
const wantedAudio = new Map();

/** This show's saved playback preferences, or an empty object. */
function prefFor(showId) {
  return (state.settings.showPrefs || {})[showId] || {};
}

/**
 * Bumped whenever any show's preference changes.
 *
 * The purge in saveShowPref clears the caches, but a conversion already IN
 * FLIGHT under the old preference finishes afterwards and writes its result
 * back — re-poisoning playableUrls with the old language for the rest of the
 * session. Every async path that caches a playable URL captures this counter
 * before its await and declines to cache when it moved.
 */
let prefGeneration = 0;

async function wantedAudioIndex(absPath, preferLanguage) {
  // The preference is part of the QUESTION: "which track for Evangelion in
  // Japanese" and "in English" are different answers about the same file.
  const cacheKey = `${absPath}
${preferLanguage || ''}`;
  if (wantedAudio.has(cacheKey)) return wantedAudio.get(cacheKey);
  if (!window.tv.inspect) return 0;

  /**
   * inspect() answers with an ENVELOPE — { ok, plan } — and the plan is one
   * level down. Reading audioIndex off the envelope gives undefined for every
   * file ever inspected, which collapses to 0, which means "track one is fine",
   * which is how a Japanese first track came to be played under an English
   * label. The guard in resolvePlayable exists to stop precisely that, and
   * could never fire, because its input was a constant.
   *
   * The other call site (the ffmpeg-missing count) unwraps this correctly, so
   * the shape was never in doubt — only this line was wrong.
   */
  const index = audioIndexFromInspect(await window.tv.inspect(
    absPath,
    preferLanguage ? { preferLanguage } : undefined,
  ).catch(() => null));

  /**
   * No answer means no evidence, and a guess must not be remembered. A probe
   * fails for reasons that have nothing to do with the file — an external
   * drive dropping off mid-scan being the obvious one — and caching 0 would
   * hold the wrong language for the rest of the session, long after the drive
   * came back.
   */
  if (index === null) return 0;

  wantedAudio.set(cacheKey, index);
  return index;
}

async function resolvePlayable(item, token, forceTier) {
  const episode = item.episode;
  const absPath = episode.absPath;
  if (!absPath || !window.tv.ensurePlayable) return episode.mediaUrl;

  // Captured before any await: a preference change mid-flight means whatever
  // this call produces is the OLD language and must not be remembered.
  const generation = prefGeneration;

  if (!forceTier && playableUrls.has(absPath)) {
    /**
     * The cache hit is the NORMAL path — prepare-ahead means almost every
     * episode arrives here — and it used to skip every line that records
     * which track is playing, leaving the menu to fall back to a default
     * computed without the preference. That is the confidently-wrong-label
     * bug wearing a new coat. The cached URL plays the track the plan chose,
     * so ask the plan (cached after its first answer) and say so.
     */
    const url = playableUrls.get(absPath);
    if (audioOverride !== null) {
      playingAudioIndex = audioOverride;
    } else {
      /**
       * Resolved WITHOUT blocking: this is the hottest path in the app — the
       * prepared-ahead episode about to hit the screen — and an ffprobe here
       * is seconds of black on a slow drive. The label lands moments later,
       * token-guarded so a rapid Next cannot be stamped by a stale answer.
       */
      wantedAudioIndex(absPath, prefFor(item.showId).audio || undefined)
        .then((heard) => { if (token === playToken) playingAudioIndex = heard; })
        .catch(() => {});
    }
    return url;
  }

  /**
   * Ask the player before asking ffmpeg — but only when the track we want is
   * the FIRST one.
   *
   * Playing the original file means playing audio track 1, because Chromium
   * has no way to switch. On a release with Japanese first and English fourth
   * that is the wrong language, and the app went on labelling it English,
   * which is worse than being slow: it was confidently wrong about what you
   * were listening to.
   *
   * So the measurement decides whether the file CAN be played, and the plan
   * decides whether it MAY be. Both have to agree.
   *
   * forceTier means somebody already overruled this from the audio menu, so
   * the measurement is not worth repeating.
   */
  let wanted = null;
  if (!forceTier) {
    wanted = audioOverride === null
      ? await wantedAudioIndex(absPath, prefFor(item.showId).audio || undefined)
      : audioOverride;
    if (token !== playToken) return null;

    if (wanted === 0) {
      const native = await canPlayNatively(item);
      if (token !== playToken) return null;
      if (native && native.video && native.audio) {
        // Playing the file untouched means playing audio track one, whatever
        // language that turns out to be. Record it, so the menu names the track
        // actually being heard rather than the one the planner would prefer.
        playingAudioIndex = 0;
        if (generation === prefGeneration) playableUrls.set(absPath, episode.mediaUrl);
        return episode.mediaUrl;
      }
    }
  }

  // Anything needing real work says so, because a silent gap before an
  // episode starts reads as the app having frozen. Delayed slightly: most
  // conversions are quick, and a panel that flashes up for half a second on
  // every episode is its own kind of noise.
  const slowNotice = setTimeout(() => {
    if (token === playToken) showPreparing(item);
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
      // The preference re-plans in the main process, so a forced tier or an
      // explicit override still wins — the language only fills the default.
      prefFor(item.showId).audio || undefined,
    );
  } catch (error) {
    result = { ok: false, error: String(error) };
  } finally {
    clearTimeout(slowNotice);
    hidePreparing();
    if (foregroundPath === absPath) foregroundPath = null;
  }

  if (token !== playToken) return null; // superseded; caller discards this

  if (result && result.ok && result.mediaUrl) {
    // A prepared file has the chosen track mapped to position one, so what plays
    // is what was asked for. Null when nothing decided it (a forced tier), which
    // leaves the menu on the planner's preference as before.
    playingAudioIndex = audioOverride !== null
      ? audioOverride
      : (Number.isInteger(wanted) ? wanted : null);
    if (result.prepared) toast(`Ready — ${item.showName} ${item.label}`, 1800);
    else clearToast();
    if (generation === prefGeneration) playableUrls.set(absPath, result.mediaUrl);
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

  const generation = prefGeneration;
  const job = window.tv.ensurePlayable(
    absPath, undefined, undefined,
    prefFor(item.showId).audio || undefined,
  )
    .then((result) => {
      preparing.delete(absPath);
      if (result && result.ok && result.mediaUrl) {
        // A preference change mid-conversion makes this the OLD language;
        // deliver it to whoever is already waiting, but do not remember it.
        if (generation === prefGeneration) playableUrls.set(absPath, result.mediaUrl);
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
  // NOT renderNowPlaying yet. Resolving a playable URL can take a while for a
  // file that genuinely needs converting, and the previous episode is still
  // on screen throughout — so naming the new one here put a movie title over
  // a show that was still playing, sometimes for half an hour. The title
  // changes when the picture does, further down.

  // Every episode starts fresh: English audio, subtitles off. An override is a
  // decision about the episode you are watching, not a setting that follows you
  // into the next show.
  audioOverride = null;
  playingAudioIndex = null;
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

  renderNowPlaying(item);
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

  /**
   * The episode opens with NO interface over it.
   *
   * This used to call showChrome(), so every episode began with the transport
   * fading in and out across the first couple of seconds of the picture. The
   * controls are one hover or one press away and the title is on the card that
   * just played, so nothing here needs announcing over the opening shot.
   */
  clearTimeout(chromeTimer);
  app.dataset.chrome = 'off';
  renderSidebar();
  persist({ immediate: true });

  // Read this episode's tracks so the menu is populated before it is opened —
  // and then honour the show's subtitle preference, which can only be applied
  // once the track list actually exists.
  loadTracksForCurrent().then(() => {
    if (token !== playToken) return;
    applySubtitlePref(item);
  });
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

  /**
   * Convert the next episodes now the clip is actually rolling.
   *
   * Deliberately AFTER the clip's own preparation, not before it. Hoisting this
   * above the await looks like it starts the work sooner, and does not:
   * onEpisodeEnded already calls prepareAhead() before the first interstitial,
   * so by here the job is running. All hoisting it achieved was running the
   * episode's conversion CONCURRENTLY with the clip's own, which contends for
   * the same disk — the thing prepareAhead's own sequencing exists to avoid.
   */
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
 * How many promos may be spent covering a conversion that has run long.
 *
 * Bounded, because what a promo displaces is the episode. Three covers a slow
 * remux comfortably without turning the channel into a promo reel when
 * something is genuinely stuck — loadAndPlay still has its own preparing panel
 * for that case, and it reports real failures.
 */
const MAX_FILLER_PROMOS = 3;

/**
 * How long the up-next card waits before handing off to a promo.
 *
 * Most conversions land within a second or two of the countdown ending, and
 * cutting to a promo for those would replace a short wait with a longer one.
 */
const FILLER_HANDOFF_MS = 2500;

/** Is there a promo available to spend on a wait? */
function fillerPromoAvailable() {
  const settings = { ...DEFAULT_SETTINGS, ...(state.settings || {}) };
  return Boolean(settings.promosEnabled) && promoClips.length > 0;
}

/** Is this item playable this instant, with nothing left to wait for? */
function readyToPlay(item) {
  const absPath = item && item.episode ? item.episode.absPath : null;
  if (!absPath) return true;              // nothing to prepare; let it through
  return playableUrls.has(absPath);
}

/**
 * Is a conversion for this item actually RUNNING?
 *
 * "Not ready" is not the same as "worth waiting for". A preparation that has
 * already finished and failed leaves no job and no URL, and filling that with
 * promos would spend three of them delaying a failure the player is about to
 * report properly. Only an in-flight job is worth covering.
 */
function stillPreparing(item) {
  const absPath = item && item.episode ? item.episode.absPath : null;
  return Boolean(absPath) && preparing.has(absPath);
}

/**
 * Cover a conversion that outlasted the transition, with promos.
 *
 * The transition already spends its bumper, promo and card on the conversion,
 * which is enough for almost everything — but a big remux on a slow disk can
 * outlast all three, and what the viewer got then was a static card reading
 * "Preparing…". Honest, and still someone sitting watching a progress line.
 *
 * A promo costs the wait nothing: the same seconds pass, the conversion keeps
 * running behind it, and there is something on screen instead. Deliberately
 * NOT counted against the promo schedule — this is covering a gap, not a promo
 * that was due, and letting it advance the counter would suppress a real one
 * later.
 *
 * Falls straight through when the episode is ready, when promos are off or
 * absent, or when the budget is spent.
 */
function fillUntilReady(item, done, spent = 0) {
  if (readyToPlay(item) || !stillPreparing(item)
    || spent >= MAX_FILLER_PROMOS || !fillerPromoAvailable()) {
    done();
    return;
  }

  const picked = nextPromo(promoClips, state, {});
  state = picked.state;
  if (!picked.promo) { done(); return; }

  playClip(picked.promo, () => fillUntilReady(item, done, spent + 1), 'Promo');
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

  // Library mode ends an episode its own way: the next one in the show, with
  // no bumper, no promo and no movie lead. Returning here rather than adding a
  // branch further down keeps the channel's transition in one piece.
  if (browsing() && browseItem) { browseEpisodeEnded(); return; }

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
      const leadOverride = movieNow ? movieItem(state.pendingMovie) : null;
      // The same item the card headlines and prepareAhead converts first, so
      // "is it ready" is asked about the thing that is actually next.
      const lead = leadOverride || peek(shows, state, 1)[0];
      const after = () => (movieNow ? startMovie() : playNext());
      // Anything still converting when the card closes is covered by promos
      // rather than by a static card or a black screen.
      const then = () => fillUntilReady(lead, after);
      if (state.settings.bumperEnabled && state.settings.bumperSeconds > 0) {
        showBumper(then, leadOverride);
      } else {
        then();
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

  // A scan is exactly when "anything new?" changes its answer. The elements
  // always exist (the settings sheet is merely hidden), so this is safe to
  // refresh whether or not anyone is looking at it.
  renderIngestStatus();
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
  'midnight', 'signal', 'foundry', 'siren', 'mono',
  'slate', 'bone', 'clay', 'arctic', '78',
  'ember', 'searchlight', 'nitrate', 'crimson', 'marigold',
  'greenbox', 'forest', 'mint', 'oceanic', 'orbital',
  '01', 'neon', 'vhs', 'sunset', 'lilac',
  'kawaii',
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
const THEME_ALIASES = { grape: '01' };

/**
 * Themes whose panels are LIGHT.
 *
 * Adding a palette here is all it takes: applyTheme puts data-light on the
 * root, and the stylesheet hangs everything a light theme needs off that one
 * attribute — inverted type over the picture, outlines on cards that would
 * otherwise be tone on tone.
 */
const LIGHT_THEMES = ['marigold', 'kawaii', 'arctic', 'mint', 'lilac', 'bone', '78', 'clay'];

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
      items.push({ kind: 'episode', id: episode.relPath, absPath: episode.absPath, preferLanguage });
    }
  }
  for (const movie of movieFiles) {
    items.push({ kind: 'movie', id: movie.relPath, absPath: movie.absPath });
  }
  return items;
}

async function renderIngestStatus() {
  const note = el('ingestNote');
  const button = el('btnIngest');
  if (!window.tv.ingestStatus) { note.textContent = ''; button.disabled = true; return; }

  const status = await window.tv.ingestStatus(ingestItems()).catch(() => null);
  if (!status) { note.textContent = 'Could not check for new titles.'; button.disabled = true; return; }

  if (status.newCount === 0) {
    note.textContent = 'Nothing new since the last ingest.';
    button.disabled = true;
    return;
  }
  const bits = [];
  if (status.newShows) bits.push(`${status.newShows} show${status.newShows === 1 ? '' : 's'}`);
  if (status.newEpisodes) bits.push(`${status.newEpisodes} episode${status.newEpisodes === 1 ? '' : 's'}`);
  if (status.newMovies) bits.push(`${status.newMovies} movie${status.newMovies === 1 ? '' : 's'}`);
  note.textContent = `New since the last ingest: ${bits.join(', ')}. `
    + 'Ingesting captures artwork and checks which files will need converting.';
  button.disabled = false;
}

/** GB with one decimal — cache sizes are the only place the app talks in GB. */
function formatGb(bytes) {
  return `${(Math.max(0, Number(bytes) || 0) / 1073741824).toFixed(1)} GB`;
}

async function renderCacheInfo() {
  const note = el('cacheNote');
  const info = await window.tv.cacheInfo().catch(() => null);
  if (!info) { note.textContent = 'Prepared-file details are unavailable.'; return; }
  note.textContent =
    `${info.count} prepared file${info.count === 1 ? '' : 's'} — ${formatGb(info.bytes)} of ${formatGb(info.budget)} budget. `
    + 'Cleaning up removes leftovers from cancelled conversions and trims back to budget; '
    + 'nothing that is playing or queued is touched.';
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
  renderCacheInfo();
  renderIngestStatus();
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
  persist({ immediate: true });
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
  li.dataset.source = source;
  li.dataset.showId = show.id;
  if (index !== undefined) li.dataset.index = String(index);

  if (source === 'order') {
    const pos = document.createElement('span');
    pos.className = 'setsched__pos';
    pos.textContent = String(index + 1).padStart(2, '0');
    li.append(pos);
  }

  const name = document.createElement('span');
  name.className = 'setsetsched__name';
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
// per-show settings
// ---------------------------------------------------------------------------

/** The show whose settings dialog is on screen. */
let showSetShow = null;

function openShowSettings(show) {
  if (!show) return;
  showSetShow = show;
  const pref = prefFor(show.id);
  el('showSetTitle').textContent = show.name;
  el('showSetAudio').value = pref.audio || '';
  el('showSetSubs').value = pref.subs || '';
  el('showSetNote').textContent =
    'A language other than the default may need each episode converted once before it plays.';
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
  prefGeneration += 1;
  persist({ immediate: true });

  const paths = new Set(show.episodes.map((e) => e.absPath));
  for (const absPath of paths) {
    playableUrls.delete(absPath);
    preparing.delete(absPath);
  }
  // By key prefix, not by enumerating languages: a list here would silently
  // couple to the <select> options and rot the first time one was added.
  for (const key of [...wantedAudio.keys()]) {
    if (paths.has(key.slice(0, key.indexOf('\n')))) wantedAudio.delete(key);
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
// audio + subtitle tracks
// ---------------------------------------------------------------------------

/**
 * Which audio track the viewer chose for the episode ON SCREEN.
 *
 * Reset for every new episode, deliberately: English is the default and stays
 * the default. This only ever holds an explicit override of the current one.
 */
let audioOverride = null;

/**
 * Which audio track is ACTUALLY playing, as opposed to which one was wanted.
 *
 * These are not the same thing and the difference is the whole bug: the menu
 * used to highlight the planner's preference, so a file that fell back to
 * playing untouched was labelled English while track one played Japanese. Null
 * means nothing has established it yet, and the menu falls back to the plan.
 */
let playingAudioIndex = null;

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
/**
 * Monotonic subtitle request id: the LAST decision wins.
 *
 * An extraction can run for minutes on a slow drive, and the viewer can turn
 * subtitles off (or pick another track) while it runs — the late arrival must
 * not attach over a decision made after it started. Every entry into
 * setSubtitle, including the synchronous Off branch, claims a new id, and the
 * async tail only applies while its id is still the newest.
 */
let subRequestSeq = 0;

async function setSubtitle(index) {
  if (!current) return;
  const absPath = current.episode.absPath;
  const seq = ++subRequestSeq;

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
  /**
   * The extraction can take minutes on a slow drive, and `current` does not
   * change while an interstitial plays — so a track that finished extracting
   * after the viewer moved on would pass the absPath guard below and paint
   * the skipped episode's captions over the bumper. A clip never wants
   * subtitles, full stop.
   */
  if (playingBumperClip || seq !== subRequestSeq) { clearToast(); return; }
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

  /**
   * Deliberately NOT cached in playableUrls. That cache's contract is "this
   * URL plays the track the plan chose", and this one plays the track the
   * viewer overrode — caching it would mislabel the next natural replay.
   * The main-process variant cache keeps the re-prepare on that replay cheap.
   */
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

/**
 * Switch on the subtitles this show asked for, if the episode carries them.
 *
 * Quietly does nothing when there is no preference, no matching track, or only
 * an image-based one — a missing track must not produce an error toast between
 * every episode of a show whose files simply lack that language.
 */
function applySubtitlePref(item) {
  const want = prefFor(item.showId).subs;
  if (!want || activeSubIndex !== null) return;
  // Non-forced first: a forced track carries only the foreign-dialogue lines,
  // which is not what "subtitles on" means to a person who asked for them.
  const usable = currentTracks.subtitles.filter(
    (t) => t.usable && matchesLanguage({ language: t.language }, want),
  );
  const track = usable.find((t) => !t.forced) || usable[0];
  if (track) setSubtitle(track.index);
}

/** Read the current episode's tracks and draw the menu. */
async function loadTracksForCurrent() {
  if (!current || !current.episode.absPath || !window.tv.listTracks) {
    currentTracks = { audio: [], subtitles: [], defaultAudioIndex: 0 };
    return;
  }
  const absPath = current.episode.absPath;
  const result = await window.tv.listTracks(
    absPath,
    prefFor(current.showId).audio ? { preferLanguage: prefFor(current.showId).audio } : undefined,
  ).catch(() => null);
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

  // What is playing beats what was planned. Falling back to the plan is only
  // right before playback has established anything.
  let activeAudio = currentTracks.defaultAudioIndex;
  if (playingAudioIndex !== null) activeAudio = playingAudioIndex;
  if (audioOverride !== null) activeAudio = audioOverride;
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

  /**
   * The sidebar picker. Choosing anything here is a decision about the running
   * order, so it always ends a marathon — including the "off" entry, which
   * means "shuffle", not "leave whatever is happening alone".
   */
  el('scheduleSelect').addEventListener('change', (event) => {
    const id = event.target.value;
    // Re-selecting the status line itself is not a choice; put it back.
    if (id === '__marathon__') { renderScheduleField(); return; }

    state = applySettings(shows, state, {
      activeScheduleId: id || null,
      marathonShowId: null,
    }, {});
    persist({ immediate: true });
    renderSidebar();
    if (!el('settingsModal').hidden) renderSettings();

    const picked = id ? savedSchedules().find((sc) => sc.id === id) : null;
    const upcoming = peek(shows, state, 1)[0];
    toast(picked
      ? `${picked.name} — ${upcoming ? `${upcoming.showName} is up next.` : 'schedule set.'}`
      : 'Back to a shuffled rotation.', 3000);
  });

  // --- set schedules -------------------------------------------------------

  el('btnSchedule').addEventListener('click', openSchedule);
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
    persist({ immediate: true });
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

  el('btnShowSetImage').addEventListener('click', async () => {
    if (!showSetShow) return;
    const show = showSetShow;
    const result = await window.tv.chooseArtwork('show', show.id).catch(() => null);
    if (!result || result.cancelled) return;
    if (!result.ok) { toast(result.error || 'Could not use that image.', 4200); return; }
    // Drop the cached miss/old art so the new image shows the moment it can.
    artworkCache.delete(`show
${show.id}`);
    if (browseDetailShow && browseDetailShow.id === show.id) {
      const art = el('detailArt');
      art.textContent = '';
      art.dataset.empty = 'true';
      paintArt(art, [], { kind: 'show', id: show.id });
    }
    if (browseOpen()) renderBrowse();
    toast('Card image updated.', 2600);
  });

  el('btnShowSetForget').addEventListener('click', () => {
    if (!showSetShow) return;
    const show = showSetShow;
    if (!window.confirm(`Forget the library's watch history for ${show.name}?

The channel keeps its own place.`)) return;
    state = forgetShow(state, show.id);
    persist({ immediate: true });
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

  el('btnIngest').addEventListener('click', async () => {
    const button = el('btnIngest');
    const original = button.textContent;
    button.disabled = true;

    // Progress on the button itself: a first ingest of a whole show is real
    // minutes of one-at-a-time disk work, and a frozen label reads as a hang.
    const stopProgress = window.tv.onIngestProgress
      ? window.tv.onIngestProgress(({ done, total, waiting }) => {
        // The run stands down while anything plays or converts; a label that
        // says so is the difference between patience and a bug report.
        button.textContent = waiting
          ? `Waiting for playback to finish… (${done} of ${total} done)`
          : `Ingesting ${done} of ${total}…`;
      })
      : null;

    const result = await window.tv.ingestRun(ingestItems()).catch(() => null);
    if (stopProgress) stopProgress();
    button.textContent = original;

    if (result && result.busy) {
      toast('An ingest is already running.', 3200);
      return;
    }
    if (!result || result.ok === false) {
      toast('Could not ingest the new titles.', 4200);
      button.disabled = false;
      return;
    }
    // New artwork exists now; cached misses would hide it until a restart.
    artworkCache.clear();
    const what = [];
    if (result.shows) what.push(`${result.shows} show${result.shows === 1 ? '' : 's'}`);
    if (result.episodes) what.push(`${result.episodes} episode${result.episodes === 1 ? '' : 's'}`);
    if (result.movies) what.push(`${result.movies} movie${result.movies === 1 ? '' : 's'}`);
    toast(result.ingested
      ? `Ingested ${what.join(', ')} — ${result.needConversion} will need converting, artwork captured for ${result.captured}.`
      : 'Nothing new to ingest.', 6000);
    renderIngestStatus();
  });

  el('btnCleanupCache').addEventListener('click', async () => {
    const button = el('btnCleanupCache');
    button.disabled = true;
    const result = await window.tv.cleanupPrepared().catch(() => null);
    button.disabled = false;
    if (!result || result.ok === false) {
      toast('Could not clean up the prepared files.', 4200);
      return;
    }
    const freed = (result.reclaimedBytes || 0);
    const bits = [];
    if (result.removedParts) bits.push(`${result.removedParts} unfinished file${result.removedParts === 1 ? '' : 's'} (${formatGb(freed)})`);
    if (result.evicted) bits.push(`${result.evicted} old prepared file${result.evicted === 1 ? '' : 's'}`);
    toast(bits.length ? `Removed ${bits.join(' and ')}.` : 'Nothing to clean up — the cache is tidy.', 4200);
    renderCacheInfo();
  });

  el('btnForgetLibrary').addEventListener('click', () => {
    // Destructive to the library's memory, but the CHANNEL keeps its place —
    // say exactly which store this touches, because the app has two.
    if (!window.confirm('Forget which episodes the library says you watched?\n\nEvery show card goes back to unwatched. The channel keeps its own place in every show.')) return;
    state = forgetAll(state);
    persist({ immediate: true });
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
  window.addEventListener('resize', () => applyPicture(playingBumperClip));

  player.addEventListener('ended', onEpisodeEnded);
  player.addEventListener('timeupdate', onTimeUpdate);
  player.addEventListener('progress', renderBuffer);
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
  // Checked before browse: this dialog opens OVER the detail card inside the
  // library, and Escape must close the thing on top, not the card under it.
  if (showSetOpen()) {
    if (event.key === 'Escape') { event.preventDefault(); closeShowSettings(); }
    return;
  }

  if (browseOpen()) {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (detailOpen()) closeDetail();
      else backFromBrowse();
    }
    return;
  }

  // Checked before Settings, because it opens FROM Settings and sits on top:
  // Escape should peel off the sheet in front, not the one behind it.
  if (locksOpen()) {
    if (event.key === 'Escape') { event.preventDefault(); closeLocks(); }
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

// ---------------------------------------------------------------------------
// waiting on a conversion
// ---------------------------------------------------------------------------

/**
 * An honest wait.
 *
 * This replaced a toast with a sixty-second life. Most conversions finish
 * inside that and it was fine; a 49GB film whose audio Chromium cannot decode
 * takes about forty minutes, and the message vanished after one of them. The
 * report was "it says processing, then the popup disappears and nothing
 * plays" — the app was working the whole time and had simply stopped saying
 * so.
 *
 * So it stays up until the wait ends, and it says three things a spinner
 * cannot: how far in, how much longer, and WHY this is happening at all.
 */
let preparingFor = null;
let preparingStartedAt = 0;
let preparingSeen = 0;
let stopPreparingProgress = null;

function showPreparing(item) {
  const absPath = item.episode && item.episode.absPath;
  if (!absPath) return;

  preparingFor = absPath;
  preparingStartedAt = performance.now();
  preparingSeen = 0;

  el('preppingTitle').textContent = item.isMovie
    ? item.showName
    : `${item.showName} ${item.label}`;
  el('preppingFill').style.width = '0%';
  el('preppingCount').textContent = 'Starting…';
  el('preppingNote').textContent = 'This file needs converting before it can play. It only happens once — after this it starts immediately.';
  el('prepping').hidden = false;

  if (stopPreparingProgress) stopPreparingProgress();
  stopPreparingProgress = window.tv.onPrepareProgress
    ? window.tv.onPrepareProgress((payload) => {
      if (!payload || payload.absPath !== preparingFor) return;
      renderPreparing(payload.outMs || 0, payload.totalMs || 0);
    })
    : null;
}

/**
 * Draws what preparingCopy decided. The wording and the estimate live in
 * src/shared/prepProgress.js, where they can be tested — the parts that can be
 * wrong here are all arithmetic, and none of it is visible in a screenshot.
 */
function renderPreparing(outMs, totalMs) {
  preparingSeen = outMs;
  const elapsed = (performance.now() - preparingStartedAt) / 1000;
  const { fraction, text } = preparingCopy(outMs, totalMs, elapsed);

  if (fraction !== null) el('preppingFill').style.width = `${(fraction * 100).toFixed(1)}%`;
  el('preppingCount').textContent = text;
}

function hidePreparing() {
  el('prepping').hidden = true;
  preparingFor = null;
  void preparingSeen;
  if (stopPreparingProgress) { stopPreparingProgress(); stopPreparingProgress = null; }
}

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
  el('browse').hidden = false;
  renderBrowse();
  el('browseBody').scrollTop = browseSavedScroll;
  el('browseSearch').focus();
}

function closeBrowse() {
  browseSavedScroll = el('browseBody').scrollTop;
  el('browse').hidden = true;
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

function renderBrowse() {
  const body = el('browseBody');
  body.textContent = '';

  const rows = continueWatching(shows, movieFiles, state, 12).filter((r) => matchesQuery(r.name));
  const showList = shows.filter((s) => matchesQuery(s.name));
  const movieList = movieFiles.filter((m) => matchesQuery(m.name));

  el('browseCount').textContent = browseQuery
    ? `${showList.length + movieList.length} match${showList.length + movieList.length === 1 ? '' : 'es'}`
    : `${shows.length} shows · ${movieFiles.length} movies`;

  if (rows.length) {
    body.append(section('Continue watching', rows.length, rows.map(continueTile)));
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
    empty.textContent = browseQuery ? `Nothing matching "${browseQuery}".` : 'Nothing in the library yet.';
    body.append(empty);
  }
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
    const cached = await window.tv.getThumb(candidate.absPath).catch(() => null);
    if (cached && show(cached)) return;
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
function continueTile(row) {
  if (row.kind === 'movie') {
    return tile({
      name: row.name,
      initials: initialsOf(row.name),
      sub: 'Movie · part way through',
      thumbFrom: [{ absPath: row.movie.absPath, mediaUrl: row.movie.mediaUrl }],
      fraction: 0,
      onOpen: () => playMovieFromLibrary(row.movie),
    });
  }
  return tile({
    name: row.name,
    initials: initialsOf(row.name),
    subStrong: formatEpisodeLabel(row.episode),
    sub: row.episode.title || '',
    thumbFrom: [row.episode],
    fraction: 0,
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
