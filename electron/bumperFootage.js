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
 * How far into a clip to start, as a fraction of what is SPARE.
 *
 * Not a fixed offset. With a 16-second source and a 15-second card there is one
 * second of headroom, and any constant seek would run off the end; with a long
 * source there is plenty. Taking a fraction of the spare works at both ends and
 * needs no special case.
 *
 * A third rather than a half so a short clip still opens near its beginning,
 * where stock footage tends to be steadiest.
 */
const SEEK_FRACTION = 0.34;

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
  return names
    .filter((name) => {
      const ext = path.extname(name).toLowerCase();
      return VIDEO_EXTENSIONS.has(ext) || STILL_EXTENSIONS.has(ext);
    })
    .map((name) => path.join(dir, name))
    .sort();
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

  if (duration >= wanted) {
    const spare = duration - wanted;
    return { seek: Number((spare * SEEK_FRACTION).toFixed(3)), speed: 1, take: wanted };
  }

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

module.exports = {
  init,
  listSources,
  isStill,
  planFor,
  clipArgs,
  partialOf,
  keyFor,
  VIDEO_EXTENSIONS,
  STILL_EXTENSIONS,
  SEEK_FRACTION,
  MIN_SPEED,
  MAX_WIDTH,
};
