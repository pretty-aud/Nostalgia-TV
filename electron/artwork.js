'use strict';

/**
 * Permanent artwork: one PNG per show, episode and movie.
 *
 * This is a different animal from the thumbnails/ cache. That cache fills with
 * whatever frames the bumper happened to decode, keyed by ABSOLUTE path — so a
 * drive-letter change (I: became H: in this very library's history) orphans
 * every entry at once. Artwork is the permanent record: keyed by RELATIVE path
 * (or show id), captured deliberately, never evicted, and overridable by hand —
 * a manually chosen image and a captured frame live at the same key, so setting
 * one simply replaces the other.
 *
 * Capture uses the bundled ffmpeg rather than the renderer's <video> decode:
 * it works for every container the library holds, needs no visible window, and
 * reads only around one keyframe.
 *
 * The sweep is deliberately timid. The library lives on an external drive that
 * has dropped off the bus under sustained load, so: one capture at a time, a
 * pause between files, stand down entirely while a conversion is running, and
 * skip everything that already has art — which is also what makes the sweep
 * resumable across restarts for free.
 */

const path = require('node:path');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { nativeImage } = require('electron');

let artDir = null;
let findFfmpeg = () => null;

/** Milliseconds of quiet between captures; kindness to a fragile drive. */
const SWEEP_GAP_MS = 400;
/** Where in the file to look: past the intro, not into the credits. */
const EPISODE_AT_SECONDS = 90;
const MOVIE_AT_SECONDS = 300;
/** Output width; height follows the picture. */
const CAPTURE_WIDTH = 640;

function init(options) {
  artDir = options.dir;
  findFfmpeg = options.findFfmpeg || findFfmpeg;
}

/**
 * show:<showId> / episode:<relPath> / movie:<relPath>.
 *
 * relPath rather than absPath on purpose: the id must survive the library
 * moving between drive letters, which absolute paths do not.
 */
function keyFor(kind, id) {
  return crypto.createHash('sha1').update(`${kind}\n${id}`).digest('hex');
}

function pathFor(kind, id) {
  return path.join(artDir, `${keyFor(kind, id)}.png`);
}

async function has(kind, id) {
  try {
    const stat = await fsp.stat(pathFor(kind, id));
    return stat.size > 0;
  } catch { return false; }
}

/** The stored PNG as a data URL, or null. */
async function read(kind, id) {
  try {
    const buf = await fsp.readFile(pathFor(kind, id));
    if (!buf.length) return null;
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch { return null; }
}

/**
 * Store a user-chosen image, whatever format it arrived in.
 *
 * nativeImage decodes anything Chromium can (png/jpg/webp/gif first frame) and
 * hands back a PNG, so the store stays one format. Downscaled to card size —
 * a 12 MP photo as a gallery card is 30x the bytes for zero extra pixels drawn.
 */
async function setFromImage(kind, id, sourcePath) {
  const image = nativeImage.createFromPath(sourcePath);
  if (image.isEmpty()) return { ok: false, error: 'That file is not a readable image.' };

  const size = image.getSize();
  const scaled = size.width > CAPTURE_WIDTH
    ? image.resize({ width: CAPTURE_WIDTH })
    : image;

  await fsp.mkdir(artDir, { recursive: true });
  const target = pathFor(kind, id);
  const tmp = `${target}.tmp`;
  await fsp.writeFile(tmp, scaled.toPNG());
  await fsp.rename(tmp, target);
  return { ok: true, dataUrl: await read(kind, id) };
}

/**
 * Grab one frame with ffmpeg. Returns true when a non-empty PNG landed.
 *
 * A file shorter than the seek point produces no frame and exits 0, so the
 * result is judged by the OUTPUT (exists and non-empty), never the exit code —
 * and a second attempt near the start covers shorts and cold opens.
 */
function captureOnce(ffmpeg, absPath, outPath, atSeconds) {
  return new Promise((resolve) => {
    const child = spawn(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-ss', String(atSeconds),
      '-i', absPath,
      '-frames:v', '1',
      '-vf', `scale=${CAPTURE_WIDTH}:-2`,
      '-y', outPath,
    ], { windowsHide: true });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 45000);
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('close', async () => {
      clearTimeout(timer);
      try { resolve((await fsp.stat(outPath)).size > 0); }
      catch { resolve(false); }
    });
  });
}

async function capture(kind, id, absPath, atSeconds) {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return false;

  await fsp.mkdir(artDir, { recursive: true });
  const target = pathFor(kind, id);
  // Unique per attempt: a rescan's fresh sweep can reach the item an old
  // sweep is still capturing, and two ffmpegs writing ONE tmp is corruption.
  const tmp = `${target}.${crypto.randomBytes(4).toString('hex')}.tmp.png`;

  let got = await captureOnce(ffmpeg, absPath, tmp, atSeconds);
  if (!got && atSeconds > 10) got = await captureOnce(ffmpeg, absPath, tmp, 10);

  /**
   * "Non-empty" is not "a picture". The 45-second kill (or a full disk) can
   * leave a truncated file that stats fine — and this store is permanent and
   * skip-existing, so a bad frame would never be retried. Decode it to know.
   */
  if (got) {
    const image = nativeImage.createFromPath(tmp);
    if (image.isEmpty()) got = false;
  }

  if (!got) {
    await fsp.unlink(tmp).catch(() => {});
    return false;
  }

  /**
   * Re-checked at the last moment: the user can choose an image by hand while
   * a capture is running, and the deliberate choice must win over the frame
   * grab that started before it existed.
   */
  if (await has(kind, id)) {
    await fsp.unlink(tmp).catch(() => {});
    return false;
  }
  await fsp.rename(tmp, target);
  return true;
}

/** Cancels the running sweep; a rescan starts a fresh one over the new library. */
let sweepToken = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fill in missing artwork for a whole library, gently, in the background.
 *
 * items: [{ kind, id, absPath, at }]. shouldPause is consulted between files;
 * while it returns true the sweep sleeps instead of reading — a conversion or
 * anything else that owns the disk outranks background art.
 */
async function sweep(items, options = {}) {
  const token = ++sweepToken;
  const shouldPause = options.shouldPause || (() => false);
  let captured = 0;
  let skipped = 0;
  let failed = 0;

  // Leftover tmp files from a crash or a cancelled sweep are dead weight in a
  // permanent store; sweep start is the natural broom.
  try {
    for (const name of await fsp.readdir(artDir)) {
      if (!name.endsWith('.tmp.png')) continue;
      const full = path.join(artDir, name);
      try {
        // Only genuinely abandoned tmps: an ingest capture (or an old sweep's
        // final item) can still be writing one this young.
        const stat = await fsp.stat(full);
        if (Date.now() - stat.mtimeMs > 5 * 60 * 1000) await fsp.unlink(full);
      } catch { /* vanished under us */ }
    }
  } catch { /* dir not created yet */ }

  for (const item of items) {
    if (token !== sweepToken) return { cancelled: true, captured, skipped, failed };

    try {
      if (await has(item.kind, item.id)) { skipped += 1; continue; }

      while (shouldPause()) {
        await sleep(5000);
        if (token !== sweepToken) return { cancelled: true, captured, skipped, failed };
      }

      const ok = await capture(item.kind, item.id, item.absPath, item.at);
      if (ok) captured += 1; else failed += 1;
    } catch {
      // One transient filesystem refusal (an AV scanner holding the file, a
      // hiccuping drive) must cost one item, not the remaining several hundred.
      failed += 1;
    }
    await sleep(SWEEP_GAP_MS);
  }
  return { cancelled: false, captured, skipped, failed };
}

function cancelSweep() {
  sweepToken += 1;
}

/**
 * The capture list for a scanned library, cheap targets first.
 *
 * Show cards come before episodes: 34 show images make the gallery whole,
 * while 500 episode frames are a long tail. A show's art is captured from the
 * FIRST episode; a manual image set later simply overwrites it.
 */
function planFor(library) {
  const items = [];
  for (const show of library.shows || []) {
    const first = show.episodes && show.episodes[0];
    if (first) items.push({ kind: 'show', id: show.id, absPath: first.absPath, at: EPISODE_AT_SECONDS });
  }
  for (const movie of library.movies || []) {
    items.push({ kind: 'movie', id: movie.relPath, absPath: movie.absPath, at: MOVIE_AT_SECONDS });
  }
  for (const show of library.shows || []) {
    for (const episode of show.episodes || []) {
      items.push({ kind: 'episode', id: episode.relPath, absPath: episode.absPath, at: EPISODE_AT_SECONDS });
    }
  }
  return items;
}

module.exports = { init, read, has, setFromImage, capture, sweep, cancelSweep, planFor, keyFor };
