'use strict';

/**
 * THE BACKDROP FOR A MINIMAL LOFI CARD: her own footage, cut to length.
 *
 * Not bumperClip.js, and the difference is not cosmetic. That module cuts a
 * backdrop out of an EPISODE, and its whole seek rule — 22% in, floored at
 * three minutes, capped at fifteen — exists to skip opening credits. Pointed at
 * a twelve-second stock clip it would seek past the end of the file every time.
 *
 * ── What her folder actually contains ────────────────────────────────────
 *
 * Measured, not assumed, because the brief said "10 seconds to an hour" and the
 * folder says otherwise:
 *
 *   durations   9.0s to 23.6s      — nothing remotely near an hour
 *   codecs      ProRes x4, MJPEG, MPEG-4, H.264 x9
 *   size        mostly 4096x2304 or 3840x2160
 *
 * Two consequences. A TRANSCODE IS MANDATORY, not an optimisation: Chromium
 * plays H.264, VP8 and VP9, so six of her fifteen files cannot be shown at all
 * without one, and 4K ProRes would be a poor idea even if it could. And most
 * clips are barely longer than the bumper, so "seek somewhere interesting" is
 * mostly not a choice that exists — which is why the seek rule below is a
 * fraction of the available headroom rather than a fixed offset.
 *
 * ── Short sources ────────────────────────────────────────────────────────
 *
 * Two of her fifteen are shorter than a fifteen-second card. Her ruling, given
 * skip / loop / slow: SLOW THEM TO FIT. So a source under the target is retimed
 * with setpts rather than dropped or looped — no restart seam, nothing in the
 * folder goes unused, and a timelapse slowed a little still reads as one.
 * There is a floor on that: past a point it stops being footage and becomes a
 * slideshow, and below the floor the clip is skipped after all.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

/**
 * Stills are welcome — she said "images and videos". They have no duration, so
 * they are held for the whole card rather than cut.
 */
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi']);
const STILL_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif']);

/**
 * NO SEEK. The clip is used from its beginning.
 *
 * An earlier version carried a seek rule inherited from the box office, which
 * cuts a backdrop out of an EPISODE and skips a third of the way in to clear
 * the opening credits. That reasoning does not transfer: a stock clip has no
 * credits, no titles and no dead opening — it is a chosen shot, and its
 * beginning is as good as anywhere. Seeking into it would only mean showing
 * less of what she picked, for no reason anyone could name.
 */

/** Below this, retiming stops looking like slow motion and starts looking broken. */
const MIN_SPEED = 0.55;

/** The card is 1080p at most; a 4K source is scaled down on the way through. */
const MAX_WIDTH = 1920;

let deps = { dir: null, findFfmpeg: null, findFfprobe: null, run: null };

function init(options = {}) {
  deps = { ...deps, ...options };
}

/** Everything usable in the folder, videos and stills together. */
async function listSources(dir) {
  if (!dir) return [];
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const usable = names.filter((name) => {
    const ext = path.extname(name).toLowerCase();
    return VIDEO_EXTENSIONS.has(ext) || STILL_EXTENSIONS.has(ext);
  });

  /**
   * ONE ENTRY PER SHOT, even when a converted copy sits beside its original.
   *
   * scripts/transcode-footage.mjs writes an H.264 `.mp4` next to a source the
   * browser cannot decode and deliberately leaves the original alone, so her
   * folder holds AdobeStock_287229496.mov (ProRes) AND .mp4 (H.264) — the same
   * twelve seconds of footage twice. Listed naively that shot is twice as
   * likely to be dealt as any other, and half the time it is dealt as the copy
   * that shows nothing at all.
   *
   * Grouped by basename, and .mp4 wins. Not because mp4 is special but because
   * that is the extension the converter writes; a folder with only originals is
   * unaffected, since each basename then has exactly one file.
   */
  const byBase = new Map();
  for (const name of usable) {
    const base = path.basename(name, path.extname(name));
    const ext = path.extname(name).toLowerCase();
    const held = byBase.get(base);
    if (!held || (ext === '.mp4' && path.extname(held).toLowerCase() !== '.mp4')) {
      byBase.set(base, name);
    }
  }

  return [...byBase.values()].map((name) => path.join(dir, name)).sort();
}

function isStill(absPath) {
  return STILL_EXTENSIONS.has(path.extname(absPath).toLowerCase());
}

/**
 * Where to start, and how fast to run, for a source of known length.
 *
 * Pure, so the arithmetic that decides whether a nine-second clip can fill a
 * fifteen-second card has a test rather than a screenshot.
 */
function planFor(durationSeconds, wanted) {
  const duration = Number(durationSeconds) || 0;
  if (!Number.isFinite(duration) || duration <= 0) return null;

  // Long enough: play it from the top and stop when the card does.
  if (duration >= wanted) return { seek: 0, speed: 1, take: wanted };

  /**
   * SLOW IT, her ruling. speed < 1 means the clip plays slower and therefore
   * lasts longer; setpts multiplies presentation timestamps by 1/speed.
   */
  const speed = duration / wanted;
  if (speed < MIN_SPEED) return null;      // too short to stretch without it showing
  return { seek: 0, speed: Number(speed.toFixed(4)), take: duration };
}

/** The ffmpeg arguments that cut one backdrop. */
function clipArgs(absPath, plan, wanted, out) {
  const filters = [`scale=${MAX_WIDTH}:-2:flags=bicubic`];
  // setpts BEFORE the trim length is applied, so -t counts output seconds.
  if (plan.speed !== 1) filters.unshift(`setpts=${(1 / plan.speed).toFixed(6)}*PTS`);

  return [
    '-y',
    // Fast seek, BEFORE -i: an input seek jumps by keyframe rather than
    // decoding everything up to the point, which on 4K ProRes is the difference
    // between instant and several seconds.
    ...(plan.seek > 0 ? ['-ss', String(plan.seek)] : []),
    '-i', absPath,
    '-t', String(wanted),
    '-an', '-sn', '-dn',           // no sound: the music is the sound
    '-map', '0:v:0',
    '-map_chapters', '-1',
    '-vf', filters.join(','),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',         // or Chromium shows nothing at all
    '-movflags', '+faststart',
    out,
  ];
}

/**
 * `.part` BEFORE the extension, never after.
 *
 * ffmpeg infers the output format from the extension, so "clip.mp4.part" makes
 * it fail to guess a muxer and write nothing — which reads exactly like a
 * missing file. The box office lost an afternoon to this.
 */
function partialOf(outPath) {
  const ext = path.extname(outPath);
  return `${outPath.slice(0, -ext.length)}.part${ext}`;
}

function keyFor(absPath, stat, wanted) {
  const base = path.basename(absPath).replace(/[^a-z0-9]+/gi, '-').slice(0, 40);
  const stamp = stat ? `${stat.size}-${Math.trunc(stat.mtimeMs)}` : '0';
  return `lofi-${base}-${stamp}-${Math.round(wanted * 1000)}.mp4`;
}

/**
 * Deal a backdrop: pick a source, cut it to length, hand back a media URL.
 *
 * WRITE ASIDE AND RENAME. A half-written mp4 is indistinguishable from a
 * finished one to every later existence check, so an ffmpeg killed partway
 * through — the app closing mid-card — would poison that cache entry for good
 * and the card would fall back to black for ever after.
 */
async function readyBackdrop(dir, seconds, lastSource) {
  const sources = await listSources(dir);
  if (!sources.length) return null;

  // Avoid an immediate repeat unless the folder genuinely holds one file.
  const pool = sources.length > 1 ? sources.filter((s) => s !== lastSource) : sources;
  const chosen = pool[Math.floor(Math.random() * pool.length)];

  if (isStill(chosen)) return { kind: 'still', source: chosen, absPath: chosen };

  const ffmpeg = deps.findFfmpeg ? await deps.findFfmpeg() : null;
  const ffprobe = deps.findFfprobe ? await deps.findFfprobe() : null;
  if (!ffmpeg || !ffprobe || !deps.dir) return null;

  await fsp.mkdir(deps.dir, { recursive: true });
  const stat = await fsp.stat(chosen).catch(() => null);
  const out = path.join(deps.dir, keyFor(chosen, stat, seconds));
  if (fs.existsSync(out)) return { kind: 'video', source: chosen, absPath: out };

  const duration = await probeDuration(ffprobe, chosen);
  const plan = planFor(duration, seconds);
  if (!plan) return null;                    // too short to stretch without it showing

  const partial = partialOf(out);
  await new Promise((resolve, reject) => {
    const child = (deps.run || require('child_process').spawn)(
      ffmpeg, clipArgs(chosen, plan, seconds, partial),
    );
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`))));
  });
  await fsp.rename(partial, out);
  return { kind: 'video', source: chosen, absPath: out };
}

function probeDuration(ffprobe, absPath) {
  return new Promise((resolve) => {
    const child = (deps.run || require('child_process').spawn)(ffprobe, [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', absPath,
    ]);
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => resolve(0));
    child.on('close', () => resolve(Number(String(out).trim()) || 0));
  });
}

/** Where the cut clips live, so main can put it on allowedRoots. */
function directory() {
  return deps.dir;
}

module.exports = {
  init,
  directory,
  readyBackdrop,
  listSources,
  isStill,
  planFor,
  clipArgs,
  partialOf,
  keyFor,
  VIDEO_EXTENSIONS,
  STILL_EXTENSIONS,
  MIN_SPEED,
  MAX_WIDTH,
};
