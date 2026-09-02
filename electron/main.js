'use strict';

const { app, BrowserWindow, ipcMain, dialog, protocol, shell, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');

const { buildLibrary, isVideoFile } = require('../src/shared/parseEpisode.js');
const { digestCursors, describeChange } = require('../src/shared/progressJournal.js');
const prepare = require('./prepare.js');
const { createPlanes } = require('./planeManager.js');
const { startMpvPlayer } = require('./mpvPlayer.js');
const { createMpvHost } = require('./mpvHost.js');
const artwork = require('./artwork.js');
const ingest = require('./ingest.js');

const MAX_SCAN_DEPTH = 6;
const MAX_FILES = 20000;

/**
 * Pin the settings folder to one fixed name.
 *
 * Electron derives userData from the app NAME, which differs between running
 * from source and running packaged. Left alone, installing the app would
 * silently orphan every show's progress, the thumbnail cache and the
 * prepared-file cache behind a folder nothing reads any more, and the channel
 * would start over from episode one with no explanation.
 *
 * 🚨 The folder is still called "shuffle-tv" after the app was renamed to
 * Nostalgia TV, and must STAY that way. It is the real, live save location —
 * renaming it to match the product would abandon every show's place. It is
 * invisible to the viewer, so the tidiness is not worth the data.
 *
 * Must run before anything calls getPath('userData').
 */
/**
 * NTV_PROFILE points the WHOLE profile somewhere else — state, caches,
 * single-instance lock and all. Test-only: it is how a smoke run boots a
 * scratch copy of the app on the same machine as a live one without the two
 * sharing a lock or, far worse, a state file. Never set it for real use.
 */
app.setPath('userData', process.env.NTV_PROFILE
  ? process.env.NTV_PROFILE
  : path.join(app.getPath('appData'), 'shuffle-tv'));

let mainWindow = null;
/** Roots the user has actually chosen. Media requests outside these are refused. */
const allowedRoots = new Set();
/**
 * Where prepared (converted) episodes live. Held separately from allowedRoots
 * because it is ours rather than the user's: it must be servable over media://,
 * but a rescan or a folder change must never drop it, and it must never be
 * walked as if it were part of the library.
 */
let prepareCacheRoot = null;

// ---------------------------------------------------------------------------
// media:// — local video with byte-range support
// ---------------------------------------------------------------------------

// Must run before app is ready.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,      // required for <video> to treat it as seekable media
      corsEnabled: true,
      bypassCSP: false,
    },
  },
]);

const MIME_BY_EXT = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.wmv': 'video/x-ms-wmv',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.ts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.flv': 'video/x-flv',
};

/**
 * How much to read from disk at a time when serving video.
 *
 * Node's default for a file stream is 64 KB. That is fine on an internal SSD
 * and pathological on a degraded external one: measured cold on a USB drive
 * that had fallen back to the legacy Bulk-Only Transport driver — which has no
 * command queuing, so every read costs a full round trip — 64 KB reads
 * sustained 2 MB/s while 8 MB reads sustained 28 MB/s on the same file, minutes
 * apart. A 4K remux needs 12 MB/s. At 64 KB the app could not read its own
 * library fast enough to play it, and the drive was not even the limit: the
 * request count was.
 *
 * 1 MB rather than 8 MB. The overhead works out near 31 ms per request, which
 * 1 MB already amortises almost entirely, while keeping time-to-first-byte
 * small enough not to blunt seeking and keeping the per-stream buffer cheap —
 * playback, prepare-ahead and thumbnail decoding all hold one at once.
 */
const MEDIA_READ_CHUNK = 1024 * 1024;

/**
 * The one place that opens a video file for the player.
 *
 * Kept as a single function because serveMedia answers on three branches and
 * the read size has to be identical on all of them; three separate
 * createReadStream calls is exactly the shape where one quietly keeps the old
 * default and only some requests are slow.
 */
/**
 * How many media streams are open right now — the main process's only honest
 * answer to "is somebody watching?".
 *
 * Background work (the artwork sweep, ingest) must stand down during playback,
 * and playback does not go through the jobs map — it is this protocol. A
 * stream stays open for as long as the player is consuming it, and 'close'
 * fires on finish, seek-away and stop alike, so open-count is the signal.
 * ('close' is safe to listen for: unlike 'data' it does not switch the stream
 * into flowing mode before toWeb takes over.)
 */
let openMediaStreams = 0;

function mediaStreamsActive() {
  return openMediaStreams > 0;
}

function mediaBody(absPath, range) {
  const stream = fs.createReadStream(absPath, {
    ...(range || {}),
    highWaterMark: MEDIA_READ_CHUNK,
  });
  openMediaStreams += 1;
  let counted = true;
  const release = () => {
    if (counted) { counted = false; openMediaStreams -= 1; }
  };
  stream.on('close', release);
  stream.on('error', release);
  return Readable.toWeb(stream);
}

function mediaUrlFor(absPath) {
  return `media://local/${encodeURIComponent(absPath)}`;
}

function absPathFromMediaUrl(rawUrl) {
  const url = new URL(rawUrl);
  // The whole path is one encoded component, so a show called "Hits & Misses"
  // or "S01E01 #1" round-trips without losing anything after the & or #.
  return decodeURIComponent(url.pathname.replace(/^\//, ''));
}

/**
 * A compromised renderer must not be able to read arbitrary files off the disk
 * just by asking for media://local/C:/Users/.../id_rsa. Only paths inside a
 * folder the user actually picked are served.
 */
function isInsideAllowedRoot(absPath) {
  const target = path.resolve(absPath);
  const roots = prepareCacheRoot ? [...allowedRoots, prepareCacheRoot] : [...allowedRoots];
  for (const root of roots) {
    const rel = path.relative(path.resolve(root), target);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return true;
  }
  return false;
}

async function serveMedia(request) {
  let absPath;
  try {
    absPath = absPathFromMediaUrl(request.url);
  } catch {
    return new Response('Bad request', { status: 400 });
  }

  if (!isInsideAllowedRoot(absPath) || !isVideoFile(path.basename(absPath))) {
    return new Response('Forbidden', { status: 403 });
  }

  let stat;
  try {
    stat = await fsp.stat(absPath);
  } catch {
    return new Response('Not found', { status: 404 });
  }
  if (!stat.isFile()) return new Response('Not found', { status: 404 });

  const contentType = MIME_BY_EXT[path.extname(absPath).toLowerCase()] || 'application/octet-stream';
  const baseHeaders = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    // Lets the renderer draw a frame to a canvas for bumper thumbnails without
    // tainting it. Same-machine local files only, gated by the root check above.
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  };

  const rangeHeader = request.headers.get('Range');
  if (!rangeHeader) {
    return new Response(mediaBody(absPath), {
      status: 200,
      headers: { ...baseHeaders, 'Content-Length': String(stat.size) },
    });
  }

  // Seeking in a long episode depends entirely on this branch answering 206.
  const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
  if (!match) {
    return new Response(mediaBody(absPath), {
      status: 200,
      headers: { ...baseHeaders, 'Content-Length': String(stat.size) },
    });
  }

  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : stat.size - 1;

  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
    return new Response('Range not satisfiable', {
      status: 416,
      headers: { 'Content-Range': `bytes */${stat.size}` },
    });
  }
  end = Math.min(end, stat.size - 1);

  return new Response(mediaBody(absPath, { start, end }), {
    status: 206,
    headers: {
      ...baseHeaders,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Content-Length': String(end - start + 1),
    },
  });
}

// ---------------------------------------------------------------------------
// library scanning
// ---------------------------------------------------------------------------

const IGNORED_DIRS = new Set([
  'extras', 'featurettes', 'sample', 'samples', 'subs', 'subtitles',
  'behind the scenes', 'deleted scenes', 'trailers', 'other', '.git',
  '$recycle.bin', 'system volume information',
]);

async function walk(rootPath) {
  const found = [];
  const queue = [{ dir: rootPath, depth: 0 }];

  while (queue.length > 0) {
    const { dir, depth } = queue.shift();
    if (depth > MAX_SCAN_DEPTH || found.length >= MAX_FILES) break;

    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable folder: skip rather than abort the whole scan
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.name.startsWith('.')) continue;

      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name.toLowerCase())) continue;
        queue.push({ dir: full, depth: depth + 1 });
      } else if (entry.isFile() && isVideoFile(entry.name)) {
        if (found.length >= MAX_FILES) break;
        let size = 0;
        try { size = (await fsp.stat(full)).size; } catch { /* keep it anyway */ }
        found.push({
          relPath: path.relative(rootPath, full).split(path.sep).join('/'),
          absPath: full,
          size,
        });
      }
    }
  }
  return found;
}

/**
 * Find the library again when its drive letter has changed.
 *
 * An external disk is not guaranteed the same letter twice — Windows hands out
 * whatever is free — so a saved root of `F:\TVandFilms` silently becomes
 * unreachable when the same disk comes back as `I:`. The app then scanned
 * nothing, showed the welcome screen, and looked exactly as though it had
 * forgotten every show: progress was never lost, it just had nothing to attach
 * itself to.
 *
 * Looks for the SAME FOLDER NAME at the root of every drive. Show ids come from
 * folder names and episode anchors are stored relative to the root, so a
 * library found this way lines up with the saved progress exactly.
 */
function locateLibrary(previousPath) {
  if (!previousPath) return { ok: false };
  if (fs.existsSync(previousPath)) return { ok: true, rootPath: previousPath, moved: false };

  const name = path.basename(previousPath);
  if (!name) return { ok: false };

  for (let code = 'A'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code += 1) {
    const candidate = path.join(`${String.fromCharCode(code)}:\\`, name);
    if (candidate === previousPath) continue;
    try {
      if (!fs.statSync(candidate).isDirectory()) continue;
    } catch { continue; }

    // Must actually contain something playable. A stray empty folder of the
    // same name on another disk would otherwise be adopted as the library and
    // wipe the schedule with nothing in it.
    let hasVideo = false;
    try {
      for (const entry of fs.readdirSync(candidate, { withFileTypes: true })) {
        if (entry.isDirectory()) { hasVideo = true; break; }
        if (entry.isFile() && isVideoFile(entry.name)) { hasVideo = true; break; }
      }
    } catch { continue; }

    if (hasVideo) return { ok: true, rootPath: candidate, moved: true };
  }

  return { ok: false };
}

async function scanLibrary(rootPath) {
  const exists = fs.existsSync(rootPath);
  if (!exists) return { ok: false, error: `Folder not found: ${rootPath}` };

  allowedRoots.add(rootPath);
  const files = await walk(rootPath);
  // The chosen folder's own name is the fallback show name, so pointing the app
  // at a single show works as well as pointing it at a folder full of them.
  const { shows, bumpers, promos, movies, presentations, skipped } = buildLibrary(files, { rootName: path.basename(rootPath) });

  // Attach the playable URL here so the renderer never builds a path itself.
  for (const show of shows) {
    for (const episode of show.episodes) {
      episode.mediaUrl = mediaUrlFor(episode.absPath);
    }
  }
  for (const clip of [...bumpers, ...promos, ...movies, ...presentations]) {
    clip.mediaUrl = mediaUrlFor(clip.absPath);
  }

  /**
   * Fill in missing artwork behind the scan, one file at a time.
   *
   * Fire-and-forget on purpose: the scan result must not wait on hundreds of
   * frame grabs. A rescan cancels the previous sweep so two never interleave,
   * skip-existing makes it resumable, and it stands down whenever a conversion
   * is running — background art never competes for the disk with a viewer.
   */
  artwork.cancelSweep();
  artwork.sweep(artwork.planFor({ shows, movies }), {
    // A conversion owns the disk, and so does the VIEWER: on a drive that has
    // dropped off the bus under sustained reads, background frame-grabs while
    // an episode streams are how the picture stutters and the drive dies.
    shouldPause: () => prepare.activeJobs().length > 0 || mediaStreamsActive() || !mpvIdleActive,
  }).catch(() => { /* art is best-effort; the library works without it */ });

  return {
    ok: true,
    rootPath,
    shows,
    bumpers,
    promos,
    movies,
    presentations,
    skipped,
    stats: {
      showCount: shows.length,
      episodeCount: shows.reduce((n, s) => n + s.episodes.length, 0),
      bumperCount: bumpers.length,
      promoCount: promos.length,
      movieCount: movies.length,
      presentationCount: presentations.length,
      skippedCount: skipped.length,
    },
  };
}

// ---------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------

const stateFile = () => path.join(app.getPath('userData'), 'channel-state.json');
const thumbDir = () => path.join(app.getPath('userData'), 'thumbnails');

/**
 * Read saved progress, falling back to the backup copy.
 *
 * "Start fresh" is the worst possible outcome here — it silently discards every
 * show's place — so an unreadable primary file is worth one more attempt before
 * accepting it.
 */
async function loadState() {
  for (const file of [stateFile(), `${stateFile()}.bak`]) {
    try {
      const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (!parsed || typeof parsed !== 'object') continue;
      if (parsed.rootPath) allowedRoots.add(parsed.rootPath);
      lastState = parsed;
      return parsed;
    } catch { /* try the backup */ }
  }
  return null; // genuinely nothing saved yet
}

/**
 * The most recent state the renderer sent us.
 *
 * Held so it can be written synchronously on quit: IPC is asynchronous and the
 * renderer is torn down before an in-flight save can land, so without a copy
 * here the last stretch of viewing is lost every time the app closes.
 */
let lastState = null;

/**
 * A dated record of every change to where each show sits.
 *
 * "My progress went backwards" has been reported repeatedly and has never been
 * diagnosable after the fact: by the time anyone looks, the bad state has been
 * overwritten by a good one, and neither the file nor its single backup carries
 * a date. This is append-only, one line per CHANGE (not per save, which happens
 * constantly), so the next report can be answered by reading it instead of
 * reconstructing it.
 *
 * Never allowed to break a save — progress matters, the journal does not.
 */
let lastDigest = null;

function journalLine(text) {
  try {
    const journal = path.join(path.dirname(stateFile()), 'progress-journal.log');

    // Trim rather than grow without bound; a few hundred lines covers months of
    // use and stays small enough to read in one go.
    let existing = '';
    try { existing = fs.readFileSync(journal, 'utf8'); } catch { /* first line */ }
    const lines = `${existing}${new Date().toISOString()}  ${text}\n`.split('\n').filter(Boolean);
    fs.writeFileSync(journal, `${lines.slice(-500).join('\n')}\n`, 'utf8');
  } catch { /* diagnostics must never be the thing that fails a save */ }
}

function journalCursors(state) {
  try {
    const cursors = (state && state.cursors) || {};
    const digest = digestCursors(cursors);
    if (digest === lastDigest) return;

    const moved = describeChange(lastDigest, cursors);
    lastDigest = digest;
    journalLine(moved);
  } catch { /* diagnostics must never be the thing that fails a save */ }
}

/** The exact bytes of the last write that was confirmed on disk. */
let lastWritten = null;

/**
 * Did the last save actually land?
 *
 * Reads the file back rather than trusting that writeFile + rename returning
 * without error means the bytes are on disk. That assumption is precisely what
 * failed here: saves reported success for half an hour while the file's
 * timestamp never moved.
 */
async function saveStatus() {
  const file = stateFile();
  try {
    const onDisk = await fsp.readFile(file, 'utf8');
    if (lastWritten === null) return { ok: true, note: 'nothing written yet this session' };
    if (onDisk === lastWritten) return { ok: true, bytes: onDisk.length };
    return { ok: false, error: 'the file on disk is not what was last written', bytes: onDisk.length };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

async function saveState(state) {
  lastState = state;
  journalCursors(state);
  const file = stateFile();
  const tmp = `${file}.tmp`;
  await fsp.mkdir(path.dirname(file), { recursive: true });

  // Keep the previous good copy. Write-then-rename protects against a torn
  // file, but not against writing a valid file with the WRONG contents — and
  // progress is the one thing here that cannot be regenerated.
  try {
    await fsp.copyFile(file, `${file}.bak`);
  } catch { /* nothing to back up yet */ }

  // Write-then-rename: a crash mid-write must not leave a truncated JSON file
  // that would wipe every show's progress on next launch.
  const json = JSON.stringify(state, null, 2);
  await fsp.writeFile(tmp, json, 'utf8');
  await fsp.rename(tmp, file);

  // Read it back. "writeFile resolved" is not the same claim as "the bytes are
  // on disk", and the difference between those two is a viewer losing their
  // place with nothing anywhere to show for it. Cheap next to the conversions
  // this app does constantly.
  const onDisk = await fsp.readFile(file, 'utf8');
  if (onDisk !== json) {
    lastWritten = null;
    throw new Error(`write did not land (${onDisk.length} bytes on disk, ${json.length} expected)`);
  }

  lastWritten = json;
  return { ok: true, bytes: json.length };
}

/**
 * A checkpoint the viewer makes on purpose, kept apart from the rolling save.
 *
 * The automatic file and its .bak both track whatever happened most recently,
 * which is no help at all when what happened most recently is the thing you
 * want to undo. This one only ever changes when someone asks for it, so it is
 * still there after a bad skip, an accidental reset, or a run of episodes that
 * moved every cursor.
 */
function manualSaveFile() {
  return path.join(path.dirname(stateFile()), 'manual-save.json');
}

async function manualSave(state) {
  const file = manualSaveFile();
  const tmp = `${file}.tmp`;
  const payload = { savedAt: Date.now(), state };
  const json = JSON.stringify(payload, null, 2);

  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(tmp, json, 'utf8');
  await fsp.rename(tmp, file);

  // Same read-back as the rolling save: a checkpoint you cannot rely on is
  // worse than none, because it is only reached for when something has gone
  // wrong already.
  const onDisk = await fsp.readFile(file, 'utf8');
  if (onDisk !== json) throw new Error('the checkpoint did not land');

  journalLine(`manual checkpoint saved (${json.length} bytes)`);
  return { ok: true, savedAt: payload.savedAt };
}

async function manualLoad() {
  try {
    const raw = await fsp.readFile(manualSaveFile(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.state) return { ok: false, error: 'the checkpoint file has no state in it' };
    journalLine('manual checkpoint loaded');
    return { ok: true, savedAt: parsed.savedAt || null, state: parsed.state };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ok: false, error: 'no checkpoint has been made yet' };
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

async function manualInfo() {
  try {
    const raw = await fsp.readFile(manualSaveFile(), 'utf8');
    const parsed = JSON.parse(raw);
    const cursors = parsed && parsed.state && parsed.state.cursors;
    return {
      exists: true,
      savedAt: (parsed && parsed.savedAt) || null,
      shows: cursors ? Object.keys(cursors).length : 0,
    };
  } catch {
    return { exists: false, savedAt: null, shows: 0 };
  }
}

/** Last-chance write during shutdown, when async work no longer completes. */
function saveStateSync() {
  if (!lastState) return;
  const file = stateFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(lastState, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch { /* shutting down anyway; nothing useful left to do */ }
}

function thumbPathFor(absPath) {
  const hash = crypto.createHash('sha1').update(absPath).digest('hex');
  return path.join(thumbDir(), `${hash}.jpg`);
}

// ---------------------------------------------------------------------------
// window
// ---------------------------------------------------------------------------

/**
 * The two planes. `videoWindow` is the OS window — mpv renders into it, and
 * every window VERB (minimise, maximise, fullscreen, close, drag) acts on
 * it. `mainWindow` is the transparent interface plane glued exactly over it,
 * carrying the ENTIRE renderer — every webContents.send and dialog parent in
 * this file keeps working against it unchanged, which is why it keeps the
 * name. The design and its traps are proven end to end by
 * scripts/mpv-embed-proof.cjs; the plumbing lives in planeManager.js.
 */
let videoWindow = null;
let mpvPlayerHandle = null;
/**
 * Is mpv sitting idle? Background work (the artwork sweep, ingest) stands
 * down during playback, and playback no longer flows through media:// — the
 * open-stream count that used to answer "is somebody watching" is silent
 * under mpv. mpv's own idle-active property is the honest replacement.
 * True until told otherwise: at boot, nothing is playing.
 */
let mpvIdleActive = true;

function watchMpvActivity(player) {
  const subscribe = () => player.observe('idle-active', (value) => {
    mpvIdleActive = Boolean(value);
  }).catch(() => {});
  subscribe();
  // Observers die with a crashed process; re-arm with each replacement.
  player.on('restarted', subscribe);
}

async function createWindow() {
  if (videoWindow) return;   // 'activate' re-entry: the pair already exists
  const { video, overlay, showBoth } = createPlanes({
    videoOptions: {
      width: 1280,
      height: 800,
      minWidth: 720,
      minHeight: 480,
      backgroundColor: '#08070c',
      autoHideMenuBar: true,
      title: 'Nostalgia TV',
      /**
       * No system title bar. The window buttons are drawn by the renderer
       * and float over the picture — on a player, that strip is the picture.
       * The drag strip and the buttons live in the INTERFACE plane; the
       * planeManager's reverse glue makes dragging the strip carry the video
       * window along underneath.
       */
      frame: false,
    },
    overlayWebPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  videoWindow = video;
  mainWindow = overlay;

  video.on('closed', () => { videoWindow = null; mainWindow = null; });

  /**
   * mpv and its typed handlers come up BEFORE the renderer does. The boot
   * sequence writes volume and subtitle style within its first frames, and
   * an invoke on an unregistered channel rejects — harmless to the facade,
   * but a boot that races its own player is exactly the ordering debt the
   * bridge work paid off elsewhere. Loading the page last removes the race
   * instead of tolerating it.
   */
  const player = await startMpvPlayer({
    hwnd: video.getNativeWindowHandle().readBigUInt64LE(0).toString(),
    logFile: path.join(app.getPath('userData'), 'mpv.log'),
  });
  mpvPlayerHandle = player;
  watchMpvActivity(player);
  const host = createMpvHost({
    player,
    send: (...args) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(...args);
    },
    isInsideAllowedRoot,
  });
  for (const [channel, handler] of Object.entries(host.handlers)) ipcMain.handle(channel, handler);
  await host.ready;

  overlay.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  overlay.webContents.once('did-finish-load', showBoth);

  /**
   * Tell the renderer what the window is doing.
   *
   * The maximise button has to show a different glyph once maximised, and the
   * window can be maximised without the button — Win+Up, or a snap — so asking
   * once at startup would leave the glyph lying for the rest of the session.
   * Fullscreen rides along because the buttons hide in it. The events come
   * from the VIDEO window (the OS window); the report goes to the interface.
   */
  const reportWindowState = () => {
    if (!videoWindow || videoWindow.isDestroyed()) return;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('window:state', {
      maximized: videoWindow.isMaximized(),
      fullscreen: videoWindow.isFullScreen(),
    });
  };
  for (const event of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'restore']) {
    video.on(event, reportWindowState);
  }
  overlay.webContents.on('did-finish-load', reportWindowState);

  // Anything trying to open a new window or navigate away is not part of this
  // app; send external links to the real browser instead.
  overlay.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  overlay.webContents.on('will-navigate', (event) => event.preventDefault());
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle('library:pick', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose your TV folder',
      properties: ['openDirectory'],
      buttonLabel: 'Use this folder',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    allowedRoots.add(result.filePaths[0]);
    return result.filePaths[0];
  });

  ipcMain.handle('library:scan', async (_event, rootPath) => {
    if (typeof rootPath !== 'string' || !rootPath) return { ok: false, error: 'No folder given' };
    try {
      return await scanLibrary(rootPath);
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) };
    }
  });

  ipcMain.handle('library:locate', async (_event, previousPath) => locateLibrary(previousPath));

  ipcMain.handle('state:load', async () => loadState());

  ipcMain.handle('state:status', async () => saveStatus());

  ipcMain.handle('state:manualSave', async (_event, state) => {
    try {
      return await manualSave(state);
    } catch (error) {
      journalLine(`MANUAL SAVE FAILED: ${String(error && error.message ? error.message : error)}`);
      return { ok: false, error: String(error && error.message ? error.message : error) };
    }
  });

  ipcMain.handle('state:manualLoad', async () => manualLoad());
  ipcMain.handle('state:manualInfo', async () => manualInfo());

  ipcMain.handle('state:save', async (_event, state) => {
    try {
      return await saveState(state);
    } catch (error) {
      // Recorded, not just returned. A failed save is the one event worth
      // having a dated record of, and it is precisely the moment when nothing
      // is being written to the state file to look at afterwards.
      journalLine(`SAVE FAILED: ${String(error && error.message ? error.message : error)}`);
      return { ok: false, error: String(error && error.message ? error.message : error) };
    }
  });

  /**
   * The ingest ledger — has a scan brought anything new? Cheap: a dictionary
   * diff, no disk probing, so the renderer may ask on every settings open.
   */
  ipcMain.handle('ingest:status', async (_event, items) => {
    try { return await ingest.status(Array.isArray(items) ? items : []); }
    catch { return { newCount: 0, newShows: 0, newEpisodes: 0, newMovies: 0 }; }
  });

  /**
   * Take in the new titles: capture artwork and answer "will this need
   * converting?", one file at a time. Runs with the sweep's own courtesy —
   * standing down while a conversion is running — and reports progress so a
   * first ingest of a whole show does not look like a hang.
   */
  ipcMain.handle('ingest:run', async (event, items) => {
    try {
      // The background sweep and an ingest both capture frames; two ffmpegs
      // against the fragile drive is exactly what neither should cause. The
      // ingest covers the new items' art itself, and the next scan restarts
      // the sweep for anything else.
      artwork.cancelSweep();
      return await ingest.run(Array.isArray(items) ? items : [], {
        artwork,
        inspect: (absPath, options) => prepare.inspect(absPath, options),
        shouldPause: () => prepare.activeJobs().length > 0 || mediaStreamsActive() || !mpvIdleActive,
        onProgress: (progress) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('ingest:progress', progress);
          }
        },
      });
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) };
    }
  });

  /** The ingest ledger, read-only, for the library table. */
  ipcMain.handle('ingest:entries', async () => {
    try { return await ingest.entriesSnapshot(); } catch { return {}; }
  });

  /** Which of these titles have artwork — booleans in input order. */
  ipcMain.handle('artwork:stats', async (_event, items) => {
    try { return await artwork.stats(Array.isArray(items) ? items : []); } catch { return []; }
  });

  /** Permanent artwork, keyed by show id / relPath — see electron/artwork.js. */
  ipcMain.handle('artwork:get', async (_event, kind, id) => {
    if (typeof kind !== 'string' || typeof id !== 'string') return null;
    try { return await artwork.read(kind, id); } catch { return null; }
  });

  /**
   * Let the user pick an image for a show or movie card. The dialog runs here
   * because only the main process can open one; the renderer gets back either
   * the stored PNG as a data URL, cancelled:true, or an error to show.
   */
  ipcMain.handle('artwork:choose', async (_event, kind, id) => {
    // 'movie' has no caller YET — the media/status table (planned) adds the
    // movie-card image picker. Named here so the no-caller sweep knows it is
    // deliberate, not another half-shipped feature.
    if (!['show', 'movie'].includes(kind) || typeof id !== 'string') {
      return { ok: false, error: 'Bad request' };
    }
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose an image',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
    });
    if (picked.canceled || !picked.filePaths.length) return { ok: false, cancelled: true };
    try {
      return await artwork.setFromImage(kind, id, picked.filePaths[0]);
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) };
    }
  });

  ipcMain.handle('thumb:get', async (_event, absPath) => {
    try {
      const buf = await fsp.readFile(thumbPathFor(absPath));
      return `data:image/jpeg;base64,${buf.toString('base64')}`;
    } catch {
      return null;
    }
  });

  ipcMain.handle('thumb:put', async (_event, absPath, dataUrl) => {
    try {
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return { ok: false };
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      await fsp.mkdir(thumbDir(), { recursive: true });
      await fsp.writeFile(thumbPathFor(absPath), Buffer.from(base64, 'base64'));
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  });

  ipcMain.handle('window:setFullscreen', (_event, value) => {
    if (videoWindow) videoWindow.setFullScreen(Boolean(value));
    return Boolean(videoWindow && videoWindow.isFullScreen());
  });

  // The window buttons. With no system frame these are the ONLY way to minimise
  // or close, so each one checks the window is still there rather than assuming
  // — a click landing during teardown would otherwise throw on a destroyed
  // window and leave the app unclosable.
  ipcMain.handle('window:minimize', () => {
    if (videoWindow && !videoWindow.isDestroyed()) videoWindow.minimize();
  });

  ipcMain.handle('window:toggleMaximize', () => {
    if (!videoWindow || videoWindow.isDestroyed()) return false;
    if (videoWindow.isMaximized()) videoWindow.unmaximize();
    else videoWindow.maximize();
    return videoWindow.isMaximized();
  });

  ipcMain.handle('window:close', () => {
    // close(), not destroy(). Closing runs the same path the old title bar's X
    // ran — 'window-all-closed' and 'before-quit', which is where saveStateSync
    // lives. destroy() tears the window down without either, so every episode
    // watched since the last rolling save would be lost on the way out.
    // Through the OVERLAY, not the video window: the renderer's
    // beforeunload final-save lives there, and the plane manager cascades
    // the close to the pair either way.
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  });


  // -- preparing unplayable files ------------------------------------------

  // What the player could actually decode, measured rather than guessed.
  ipcMain.handle('prepare:verdict', async (_event, absPath) => (
    isInsideAllowedRoot(absPath) ? prepare.readVerdict(absPath) : null
  ));

  ipcMain.handle('prepare:saveVerdict', async (_event, absPath, verdict) => (
    isInsideAllowedRoot(absPath) ? prepare.writeVerdict(absPath, verdict) : { ok: false }
  ));

  ipcMain.handle('prepare:capabilities', async () => ({
    ffmpeg: prepare.hasFfmpeg(),
    ffmpegPath: prepare.findFfmpeg(),
  }));

  /** Read a file's codecs and say what would have to happen for it to play. */
  ipcMain.handle('prepare:inspect', async (_event, absPath, options) => {
    if (!isInsideAllowedRoot(absPath)) return { ok: false, error: 'Forbidden' };
    const preferLanguage = options && typeof options.preferLanguage === 'string'
      ? options.preferLanguage
      : undefined;
    try {
      return { ok: true, plan: await prepare.inspect(absPath, { preferLanguage }) };
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) };
    }
  });

  /**
   * Convert if needed and return something playable. Safe to call twice for the
   * same file: the second caller joins the running job rather than starting a
   * second ffmpeg against the same output.
   */
  /** Audio and subtitle tracks, labelled for the player's track menu. */
  ipcMain.handle('prepare:tracks', async (_event, absPath, options) => {
    if (!isInsideAllowedRoot(absPath)) return { ok: false, error: 'Forbidden' };
    const preferLanguage = options && typeof options.preferLanguage === 'string'
      ? options.preferLanguage
      : undefined;
    try {
      return await prepare.listTracks(absPath, { preferLanguage });
    } catch (error) {
      return { ok: false, audio: [], subtitles: [], error: String(error && error.message ? error.message : error) };
    }
  });

  /**
   * Subtitles come back as WebVTT TEXT rather than a URL: the renderer turns it
   * into a blob for the <track> element, so the media:// protocol stays a
   * video-only surface rather than growing a second file type to guard.
   */
  ipcMain.handle('prepare:subtitle', async (_event, absPath, index) => {
    if (!isInsideAllowedRoot(absPath)) return { ok: false, error: 'Forbidden' };
    if (!Number.isInteger(index) || index < 0) return { ok: false, error: 'Bad track index' };
    try {
      const result = await prepare.extractSubtitle(absPath, index);
      if (!result.ok) return result;
      return { ok: true, vtt: await fsp.readFile(result.path, 'utf8') };
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) };
    }
  });

  ipcMain.handle('prepare:ensure', async (_event, absPath, forceTier, audioIndex, preferLanguage) => {
    if (!isInsideAllowedRoot(absPath)) return { ok: false, error: 'Forbidden' };
    try {
      const result = await prepare.ensurePlayable(absPath, {
        forceTier: typeof forceTier === 'string' ? forceTier : undefined,
        audioIndex: Number.isInteger(audioIndex) ? audioIndex : undefined,
        preferLanguage: typeof preferLanguage === 'string' ? preferLanguage : undefined,
        onProgress: ({ outMs, totalMs }) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('prepare:progress', { absPath, outMs, totalMs });
          }
        },
      });
      return {
        ...result,
        // The renderer only ever plays through media://, so hand back a URL
        // rather than a path it would have to know how to encode.
        mediaUrl: result.playablePath ? mediaUrlFor(result.playablePath) : null,
      };
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) };
    }
  });

  /**
   * The real picture inside a frame with bars baked in.
   *
   * `cachedOnly` answers from the crop cache without ever spawning ffmpeg —
   * the renderer applies a known crop the instant an episode starts, and only
   * measures unknown files after the startup contention window has passed.
   */
  ipcMain.handle('prepare:crop', async (_event, absPath, options) => {
    if (!isInsideAllowedRoot(absPath)) return null;
    const cachedOnly = Boolean(options && options.cachedOnly);
    try { return await prepare.detectCrop(absPath, { cachedOnly }); } catch { return null; }
  });

  ipcMain.handle('prepare:cancel', async (_event, absPath) => ({ cancelled: prepare.cancel(absPath) }));

  /** Keep the playing and next-up conversions; everything else may be evicted. */
  ipcMain.handle('prepare:pin', async (_event, paths) => {
    prepare.unpinAllExcept(Array.isArray(paths) ? paths : []);
    for (const p of Array.isArray(paths) ? paths : []) prepare.pin(p);
    return { ok: true };
  });

  ipcMain.handle('prepare:cacheInfo', async () => {
    const entries = await prepare.cacheEntries();
    return {
      count: entries.length,
      bytes: entries.reduce((n, e) => n + e.size, 0),
      budget: prepare.DEFAULT_CACHE_BUDGET,
      jobs: prepare.activeJobs(),
    };
  });

  /**
   * The settings button: sweep abandoned .part fragments and re-enforce the
   * budget. Deliberately does NOT cancel running jobs — cleaning up must never
   * kill the conversion someone is waiting on; live fragments are skipped by
   * their fresh mtime instead.
   */
  ipcMain.handle('prepare:cleanup', async () => {
    try {
      return { ok: true, ...(await prepare.cleanupCache()) };
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) };
    }
  });
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (videoWindow) {
      if (videoWindow.isMinimized()) videoWindow.restore();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    prepareCacheRoot = path.join(app.getPath('userData'), 'prepared');
    prepare.setCacheDir(prepareCacheRoot);
    /**
     * The cache polices itself at every launch, not only when the Settings
     * button is pressed. Orphaned .part fragments once grew to 69 GB precisely
     * because nothing ran this automatically, and the budget was only enforced
     * after a conversion FINISHED — a cache pushed over budget stayed there
     * across sessions. The single-instance lock means no other process is
     * writing here and no jobs exist yet — but NOTHING IS PINNED either, and
     * bare LRU order at boot picks the resume episode's conversion first (its
     * atime dates from when its play STARTED; the prepare-ahead files were
     * written after it). Hence the age floor: the last session's working set
     * is left alone, stale bulk drains, and the mid-session passes — which
     * have real pins — hold the budget from there. Fire-and-forget so a large
     * sweep never delays the window.
     */
    prepare.cleanupCache(undefined, { minAgeMs: 48 * 60 * 60 * 1000 }).catch(() => {});
    artwork.init({ dir: path.join(app.getPath('userData'), 'artwork'), findFfmpeg: prepare.findFfmpeg });
    ingest.init({ file: path.join(app.getPath('userData'), 'ingest.json') });

    protocol.handle('media', serveMedia);
    registerIpc();
    createWindow().catch((error) => {
      // Without this an mpv that cannot start leaves a windowless process:
      // nothing on screen, nothing on the taskbar, no way to quit.
      dialog.showErrorBox('Nostalgia TV could not start its player',
        String(error && error.message ? error.message : error));
      app.quit();
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // A half-finished conversion is written to a .part file and only renamed on a
  // clean exit, so killing jobs here loses nothing but the CPU already spent —
  // whereas leaving them running keeps ffmpeg alive after the window is gone.
  // Closing the window is the most common way this app ends, and the renderer's
  // last debounced save has usually not landed yet — so flush synchronously on
  // every shutdown path rather than trusting one of them to fire.
  app.on('before-quit', () => { saveStateSync(); prepare.cancelAll(); if (mpvPlayerHandle) mpvPlayerHandle.close(); });

  app.on('window-all-closed', () => {
    saveStateSync();
    prepare.cancelAll();
    if (mpvPlayerHandle) mpvPlayerHandle.close();
    if (process.platform !== 'darwin') app.quit();
  });
}
