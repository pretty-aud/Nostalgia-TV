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

/**
 * Output width; height follows the picture.
 *
 * Was 640, which is less than a single rail card on a normal window: the
 * browse rail gives each card a THIRD of the body width, so at 1920 that is
 * around 500 CSS pixels — and more device pixels than that on a scaled
 * display. The card was upscaling a 640px frame, which is exactly the
 * softness and the visible rasterising she reported.
 *
 * 1280 covers a rail card at 2x. Captures are JPEG rather than PNG for the
 * same reason a photograph is: a PNG of a 1280x720 video frame runs to well
 * over a megabyte, and across a library of a few hundred episodes that is
 * gigabytes of permanent, never-evicted storage for no visible gain. A
 * hand-picked image stays PNG — see pathFor.
 */
const CAPTURE_WIDTH = 1280;

/**
 * A frame is no good if it is black, and not much better if it is a flat
 * card of one colour. Mean luma and its spread, both on 0..255, sampled on a
 * grid rather than over every pixel.
 */
const MIN_MEAN_LUMA = 16;
const MIN_LUMA_SPREAD = 10;

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

/**
 * The hand-picked path. PNG, because what she chose is hers and lossless, and
 * because every image written before captures moved to JPEG lives here too.
 * Read first, so a deliberate choice always outranks a frame grab.
 */
function pathFor(kind, id) {
  return path.join(artDir, `${keyFor(kind, id)}.png`);
}

/** The captured path. JPEG; see CAPTURE_WIDTH. */
function capturePathFor(kind, id) {
  return path.join(artDir, `${keyFor(kind, id)}.jpg`);
}

/**
 * Keys whose artwork the user chose by hand, so a rebuild can leave them
 * alone. Written from this version onward — anything picked before it is
 * indistinguishable on disk from a captured frame, which is why the rebuild
 * says so out loud rather than pretending it can tell.
 */
function chosenPath() {
  return path.join(artDir, 'chosen.json');
}

async function readChosen() {
  try { return new Set(JSON.parse(await fsp.readFile(chosenPath(), 'utf8'))); }
  catch { return new Set(); }
}

async function rememberChosen(kind, id) {
  try {
    const set = await readChosen();
    set.add(keyFor(kind, id));
    await fsp.writeFile(chosenPath(), JSON.stringify([...set]));
  } catch { /* the record is a courtesy; losing it must not fail the save */ }
}

/**
 * Mean luma and its spread, for judging whether a frame is worth keeping.
 * Sampled on a grid: a 1280x720 frame is 921,600 pixels and the answer does
 * not change for looking at all of them.
 */
function measure(file) {
  const image = nativeImage.createFromPath(file);
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize();
  if (!width || !height) return null;
  const buf = image.toBitmap();                       // BGRA, row-major
  const step = Math.max(1, Math.floor(Math.min(width, height) / 64));
  let sum = 0;
  let sumSquares = 0;
  let n = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      const luma = 0.114 * buf[i] + 0.587 * buf[i + 1] + 0.299 * buf[i + 2];
      sum += luma;
      sumSquares += luma * luma;
      n += 1;
    }
  }
  if (!n) return null;
  const mean = sum / n;
  const spread = Math.sqrt(Math.max(0, sumSquares / n - mean * mean));
  return { width, height, mean, spread, usable: mean >= MIN_MEAN_LUMA && spread >= MIN_LUMA_SPREAD };
}

async function has(kind, id) {
  for (const file of [pathFor(kind, id), capturePathFor(kind, id)]) {
    try {
      if ((await fsp.stat(file)).size > 0) return true;
    } catch { /* try the next one */ }
  }
  return false;
}

/** The stored PNG as a data URL, or null. */
async function read(kind, id) {
  for (const [file, mime] of [[pathFor(kind, id), 'image/png'], [capturePathFor(kind, id), 'image/jpeg']]) {
    try {
      const buf = await fsp.readFile(file);
      if (buf.length) return `data:${mime};base64,${buf.toString('base64')}`;
    } catch { /* try the next one */ }
  }
  return null;
}

/**
 * A file DROPPED on the window, decoded from bytes rather than a path.
 *
 * Electron removed File.path, so a dropped file cannot be handed over as
 * something to open — the renderer reads it and sends the bytes. Both routes
 * meet at storeImage below, so a dropped image and a chosen one cannot end up
 * stored differently.
 */
async function setFromBuffer(kind, id, buffer) {
  return storeImage(kind, id, nativeImage.createFromBuffer(Buffer.from(buffer)));
}

/** An image picked through the OS file dialog, which does give a path. */
async function setFromImage(kind, id, sourcePath) {
  return storeImage(kind, id, nativeImage.createFromPath(sourcePath));
}

/**
 * Store a user-chosen image, whatever format it arrived in.
 *
 * nativeImage decodes anything Chromium can (png/jpg/webp/gif first frame) and
 * hands back a PNG, so the store stays one format. Downscaled to card size —
 * a 12 MP photo as a gallery card is 30x the bytes for zero extra pixels drawn.
 *
 * An undecodable file arrives here as an EMPTY image rather than a throw, so
 * the refusal has to be checked for; without it a PDF would be written as a
 * zero-byte PNG and the card would go permanently blank.
 */
async function storeImage(kind, id, image) {
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
  // A capture may already exist at the same key. read() prefers the PNG, but
  // leaving the JPEG behind means a rebuild could later resurrect it.
  await fsp.unlink(capturePathFor(kind, id)).catch(() => {});
  await rememberChosen(kind, id);
  return { ok: true, dataUrl: await read(kind, id) };
}

/**
 * Throw away captured artwork so the sweep makes it again.
 *
 * Everything this store holds was written at 640px wide until now, and a
 * card is wider than that on any normal window — so without this she would
 * keep the soft images she already has and only ever see the improvement on
 * a library she has not scanned yet.
 *
 * Images she chose BY HAND are kept, but only where they can be recognised:
 * the record of them starts with this version, and anything picked before it
 * is byte-for-byte indistinguishable from a captured frame. The caller says
 * so plainly rather than pretending otherwise.
 *
 * Returns how many files went, so the caller can say what happened.
 */
async function rebuild() {
  if (!artDir) return { removed: 0 };
  const keep = await readChosen();
  let removed = 0;
  let files = [];
  try { files = await fsp.readdir(artDir); } catch { return { removed: 0 }; }
  for (const name of files) {
    const match = /^([0-9a-f]{40})\.(png|jpg)$/.exec(name);
    if (!match) continue;                            // chosen.json, tmp files
    if (keep.has(match[1])) continue;
    try { await fsp.unlink(path.join(artDir, name)); removed += 1; } catch { /* gone already */ }
  }
  return { removed };
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
      /**
       * thumbnail=40 buffers forty frames from the seek point and hands back
       * the one furthest from the average of them — ffmpeg's own answer to
       * "pick a representative still". It costs about a second and a half of
       * decoding and it is the difference between landing on a fade and
       * landing on a shot. -q:v 3 is high-quality JPEG; the default is
       * noticeably soft on exactly the flat areas this look is full of.
       */
      '-vf', `thumbnail=40,scale=${CAPTURE_WIDTH}:-2`,
      '-q:v', '3',
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
  const target = capturePathFor(kind, id);
  // Unique per attempt: a rescan's fresh sweep can reach the item an old
  // sweep is still capturing, and two ffmpegs writing ONE tmp is corruption.
  const stem = `${target}.${crypto.randomBytes(4).toString('hex')}`;
  const tmp = `${stem}.tmp.jpg`;
  const spare = `${stem}.alt.jpg`;

  /**
   * SEVERAL PLACES IN THE FILE, AND KEEP THE BEST ONE.
   *
   * A single grab at a fixed 90 seconds lands on whatever is there, and what
   * is there is quite often a fade, a title card or an eyecatch — she was
   * getting black cards. So try a spread and judge each one. The first
   * usable frame wins immediately, so the common case still costs exactly
   * one decode; only a bad frame pays for another.
   *
   * The offsets need no duration: seeking past the end simply produces no
   * frame, which is already how a short file is handled. 10 seconds stays
   * last as the cold-open fallback for something shorter than the lot.
   */
  const offsets = [...new Set([atSeconds, atSeconds * 2, Math.round(atSeconds / 2), atSeconds * 3, 10])]
    .filter((s) => s >= 0);

  let got = false;
  let best = null;                                   // { file, spread }
  for (const at of offsets) {
    const into = best ? spare : tmp;
    if (!await captureOnce(ffmpeg, absPath, into, at)) continue;
    /**
     * "Non-empty" is not "a picture". The 45-second kill (or a full disk) can
     * leave a truncated file that stats fine — and this store is permanent
     * and skip-existing, so a bad frame would never be retried. Decode it.
     */
    const seen = measure(into);
    if (!seen) continue;
    if (!best || seen.spread > best.spread) {
      if (best && into === spare) await fsp.rename(spare, tmp).catch(() => {});
      best = { spread: seen.spread };
      got = true;
    }
    if (seen.usable) break;                          // good enough; stop reading
  }
  await fsp.unlink(spare).catch(() => {});

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

/**
 * Batch presence check for the library table's artwork column: ~1200 stats is
 * one pass of cheap metadata reads, where 1200 separate IPC calls would not be.
 */
async function stats(items) {
  const out = [];
  for (const item of items || []) {
    out.push(item && item.kind && item.id ? await has(item.kind, item.id) : false);
  }
  return out;
}

module.exports = {
  init, read, has, stats, setFromImage, setFromBuffer, capture, sweep, cancelSweep, planFor, keyFor,
  rebuild, measure, CAPTURE_WIDTH,
};
