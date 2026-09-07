'use strict';

/**
 * THE BACKGROUND FOR A VIDEO UP-NEXT STYLE — a piece of what is coming next.
 *
 * The box office plays a snippet of the upcoming programme behind its type,
 * the way HBO's bumpers did. Two things have to be decided before any of that
 * can happen: WHERE in the programme to take it from, and in what form.
 *
 * ── Where: 12% in, floored at 90s, capped at 10 minutes ──────────────────
 *
 * Her rule, and each of the three parts is doing a job.
 *
 *   12%      scales with the runtime. A 22-minute episode comes from ~2m40,
 *            a 100-minute film from 12m. A flat offset cannot do both: five
 *            minutes into a 22-minute episode is a fifth of the way through
 *            the plot, and five minutes into a film is often still credits.
 *   floor 90s  a 40-second promo would otherwise be sampled at 5 seconds,
 *            which is the title card.
 *   cap 600s a long film would otherwise be sampled 20 minutes in, which is
 *            past the setup and into things she has not seen yet. The cap is
 *            the spoiler guard, and it is the reason this is not just "12%".
 *
 * ── In what form: a TRANSCODED clip, never the file itself ───────────────
 *
 * The obvious version — point a <video> at media://local/... and seek — works
 * on the fixture library and fails on hers. Chromium plays H.264 and little
 * else; her library is HEVC and AC3 in Matroska, which is the whole reason
 * this app carries mpv in the first place. A probe against the fixtures would
 * have gone green and the feature would have been blank on her machine, which
 * is the exact shape of bug this project keeps writing tests to avoid.
 *
 * mpv itself is not available either: it is busy playing the bumper's music,
 * and it plays one file at a time.
 *
 * So ffmpeg cuts a short H.264 clip in advance and the card plays that. The
 * cost is a transcode, which is why it is started EARLY — while the bumper
 * and promo clips before it are still on screen — and why there is a still
 * frame to fall back on when it is not ready.
 */

const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * The rule, in one place.
 *
 * DEEPER THAN IT STARTED, because the first numbers kept landing in opening
 * credits. 12% of a 24-minute episode is 2m53, and this library is largely
 * anime, where an opening routinely runs past three minutes once a cold open
 * is counted — so the "past the credits" rule was sampling the credits.
 *
 *   22%   a 24-minute episode now comes from 5m17, a 45-minute one from 9m54.
 *   180s  no sample from the first three minutes at all, which is the floor
 *         that actually clears a title sequence rather than just a logo.
 *   900s  the spoiler guard, raised from 600 so a feature is sampled fifteen
 *         minutes in rather than ten — still inside the first act of anything
 *         feature length, which is the point of having a cap.
 */
const FRACTION = 0.22;
const FLOOR_SECONDS = 180;
const CAP_SECONDS = 900;

/**
 * Where to take the background from, given a runtime.
 *
 * Pure, and separated from everything else so the rule can be checked against
 * runtimes there is no file of — a 40-second promo, a three-hour film — rather
 * than only against whatever happens to be in the fixture library.
 */
function seekFor(durationSeconds, clipSeconds = 0) {
  const duration = Number(durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) return 0;

  const wanted = Math.min(CAP_SECONDS, Math.max(FLOOR_SECONDS, duration * FRACTION));

  /**
   * It has to FIT. A 100-second file would otherwise be asked for a clip
   * starting at its 90-second floor, and ffmpeg would return two seconds of
   * video for a ten-second card — or nothing at all, for a file shorter than
   * the floor. Short files give up the rule and take the middle, which is the
   * best available answer for something that has no "past the credits".
   */
  const latest = duration - clipSeconds;
  if (latest <= 0) return 0;
  if (wanted > latest) return Math.max(0, Math.min(latest, (duration - clipSeconds) / 2));
  return Math.round(wanted * 100) / 100;
}

/** Where the cut pieces live. Set by init, like artwork's dir. */
let cacheDir = null;
let findFfmpeg = () => null;

/**
 * How a cut is actually performed, injectable — the same seam planeManager
 * takes its Window through, and for the same reason.
 *
 * Without it, nothing can observe WHAT this module asks ffmpeg to do without
 * running ffmpeg. A test that builds the argument list itself and checks that
 * instead is testing its own arithmetic: it passed while the module wrote
 * straight to the final filename, which is the bug it was written for.
 */
let runner = null;

function init(options = {}) {
  cacheDir = options.dir || null;
  if (typeof options.findFfmpeg === 'function') findFfmpeg = options.findFfmpeg;
  runner = typeof options.run === 'function' ? options.run : null;
}

const perform = (args, outPath, timeoutMs) => (runner
  ? runner(args, outPath, timeoutMs)
  : run(args, outPath, timeoutMs));

/** Somewhere to put it that changes when the file does. */
function cacheKey(absPath, stat, kind, seek) {
  const hash = crypto.createHash('sha1')
    .update(`${absPath}:${stat.size}:${stat.mtimeMs}:${kind}:${seek}`)
    .digest('hex');
  return hash;
}

/**
 * Run ffmpeg, resolving only when the output actually exists.
 *
 * Exit code alone is not enough: ffmpeg exits 0 having written a zero-byte
 * file often enough that trusting it produces a <video> pointed at nothing,
 * which renders as a black rectangle and no error.
 */
function run(args, outPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const exe = findFfmpeg();
    if (!exe) { reject(new Error('no ffmpeg')); return; }

    const child = spawn(exe, args, { windowsHide: true });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error('ffmpeg timed out'));
    }, timeoutMs);

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', async () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        const stat = await fsp.stat(outPath);
        if (stat.size > 0) resolve(outPath);
        else reject(new Error('ffmpeg wrote an empty file'));
      } catch {
        reject(new Error('ffmpeg wrote nothing'));
      }
    });
  });
}

/** In-flight and finished work, so the same clip is never cut twice. */
const jobs = new Map();

/**
 * The name a cut is written under before it is finished.
 *
 * ".part" goes BEFORE the extension, never after, and that is not cosmetic:
 * ffmpeg chooses its output format from the extension, so "clip.mp4.part" is a
 * file whose format it cannot guess and it writes nothing at all. Appending
 * .part broke both the clip and the still at once — every card came back with
 * no backdrop — and the only reason it took a minute rather than an evening is
 * that the swallowed error in the handler had just been unmasked.
 */
function partialOf(outPath) {
  const ext = path.extname(outPath);
  return `${outPath.slice(0, -ext.length)}.part${ext}`;
}

/**
 * A still frame from the chosen point, as a jpeg.
 *
 * Cheap — one frame, no encoding of consequence — and it is what the card
 * falls back to. Also the whole of the "still image" background mode.
 */
async function stillFor(absPath, durationSeconds) {
  if (!cacheDir) throw new Error('bumperClip.init was never called');
  const stat = await fsp.stat(absPath);
  const seek = seekFor(durationSeconds);
  const out = path.join(cacheDir, `${cacheKey(absPath, stat, 'still', seek)}.jpg`);

  try {
    if ((await fsp.stat(out)).size > 0) return out;
  } catch { /* not cut yet */ }

  await fsp.mkdir(cacheDir, { recursive: true });
  /**
   * -ss BEFORE -i, which is the difference between a seek and a decode. After
   * the input it decodes every frame up to the offset — twelve minutes of a
   * film, for one picture.
   */
  // Aside then renamed, for the reason clipFor gives at length: a file that is
  // still being written is a real file with a real size, and any readiness
  // check that asks only "does it exist" will hand out half a picture.
  const partial = partialOf(out);
  await perform([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', String(seek),
    '-i', absPath,
    '-frames:v', '1',
    // Height-limited rather than width-limited: this is a full-bleed
    // background, and it is the vertical that decides whether it looks soft.
    '-vf', "scale=-2:'min(1080,ih)'",
    '-q:v', '3',
    partial,
  ], partial, 45000).catch(async (error) => {
    await fsp.rm(partial, { force: true }).catch(() => {});
    throw error;
  });
  await fsp.rename(partial, out);

  return out;
}

/**
 * A short H.264 clip from the chosen point, silent.
 *
 * The audio is dropped because mpv is already playing the bumper's cue over
 * this; two soundtracks at once is not a subtle bug.
 */
/**
 * WHERE A CLIP LIVES — the one place that decides, used by both sides.
 *
 * Cutting and looking-up used to derive this separately, and they diverged
 * the first time somebody called the lookup with one argument missing. The
 * duration is part of the key (through the seek), so a lookup without it
 * computed a seek of zero and asked for a file that had never been written —
 * and since "no file" is a legitimate answer meaning "not cut yet", the card
 * fell back to a still every single time and nothing was wrong anywhere.
 *
 * One function, so there is nothing to keep in step. Same argument order as
 * clipFor for the same reason.
 */
async function clipPathFor(absPath, durationSeconds, clipSeconds) {
  if (!cacheDir) throw new Error('bumperClip.init was never called');
  const stat = await fsp.stat(absPath);
  const seek = seekFor(durationSeconds, clipSeconds);
  return path.join(cacheDir, `${cacheKey(absPath, stat, `clip${clipSeconds}`, seek)}.mp4`);
}

async function clipFor(absPath, durationSeconds, clipSeconds) {
  const out = await clipPathFor(absPath, durationSeconds, clipSeconds);
  const seek = seekFor(durationSeconds, clipSeconds);

  try {
    if ((await fsp.stat(out)).size > 0) return out;
  } catch { /* not cut yet */ }

  const existing = jobs.get(out);
  if (existing) return existing;

  await fsp.mkdir(cacheDir, { recursive: true });

  /**
   * WRITE ASIDE, THEN RENAME. A file only appears when it is finished.
   *
   * This is not tidiness. ffmpeg writes the mp4 progressively, so a clip that
   * is still being cut is a real file with a real size — and the readiness
   * check, which asked only whether the file was non-empty, said yes. The card
   * got a truncated mp4, the <video> refused to decode it, and the still
   * underneath showed through: "the background is still just stills", on the
   * FIRST play of every session, with everything reporting success.
   *
   * Measured with the debug preview: card one "clip decoding: NO", card two
   * "yes, 1280x720" — the difference being that by the second card the cut had
   * long finished. Renaming on the same volume is atomic, so existence and
   * completeness become the same fact, and it holds across restarts in a way
   * an in-memory flag would not.
   */
  const partial = partialOf(out);
  const job = perform(clipArgs(absPath, seek, clipSeconds, partial), partial, 120000)
    .then(async () => {
      await fsp.rename(partial, out);
      return out;
    })
    .catch(async (error) => {
      // Never leave a half-cut file behind to be retried around forever.
      await fsp.rm(partial, { force: true }).catch(() => {});
      throw error;
    })
    .finally(() => jobs.delete(out));

  jobs.set(out, job);
  return job;
}

/**
 * The ffmpeg call for a backdrop clip, as an argument list.
 *
 * Pulled out so it can be asserted. Every switch in here was found by cutting
 * a real episode and looking at what came out — none is a precaution — and
 * each would fail silently if it were dropped: the picture would still play in
 * the harness, and only her library would be wrong.
 */
function clipArgs(absPath, seek, clipSeconds, out) {
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', String(seek),
    '-i', absPath,
    '-t', String(clipSeconds),
    /**
     * EXACTLY ONE STREAM: the first video track, and nothing else.
     *
     * -an alone is not enough. Measured against a real episode — HEVC in
     * Matroska — the output carried a `bin_data` stream through into the mp4,
     * copied from whatever the container had alongside the picture. A <video>
     * asked to play a file with a stream it does not understand is not
     * reliably a working <video>, and that failure would appear only on her
     * library and never on the fixtures.
     *
     * -map picks the picture; -an, -sn and -dn refuse audio, subtitles and
     * data explicitly rather than hoping the muxer declines them.
     */
    '-map', '0:v:0',
    '-an', '-sn', '-dn',         // mpv owns the sound; nothing else is wanted
    /**
     * CHAPTERS, which -dn does not cover and -map does not exclude.
     *
     * Her episodes carry them, and ffmpeg turns a Matroska chapter list into
     * an MP4 chapter track — which ffprobe reports as a `bin_data` stream with
     * a `text` tag. It survived -map 0:v:0 -an -sn -dn, because chapters are
     * metadata rather than a mapped stream, and only this switch refuses them.
     */
    '-map_chapters', '-1',
    '-vf', "scale=-2:'min(720,ih)'",
    /**
     * veryfast and a loose CRF on purpose. This is a background behind type,
     * running for ten seconds, and it has to be READY — a slower preset buys
     * quality nobody can see at the cost of the clip missing its own card.
     */
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
    '-pix_fmt', 'yuv420p',       // or Chromium refuses 10-bit sources outright
    '-movflags', '+faststart',
    out,
  ];
}

/**
 * The cut clip if it exists RIGHT NOW, else null. Never starts one.
 *
 * Deliberately a separate call from clipFor. The card asks this on its way up
 * and must get an answer immediately: awaiting clipFor would make the card
 * wait for a transcode it was specifically designed not to wait for, and the
 * failure would look like the app hanging between programmes.
 *
 * It has to re-derive the same cache key, which means re-probing the duration
 * — cheap, because inspect() is memoised and prepare() has already probed this
 * file to play it.
 */
async function readyClip(absPath, durationSeconds, clipSeconds) {
  if (!cacheDir) return null;
  try {
    const out = await clipPathFor(absPath, durationSeconds, clipSeconds);
    return (await fsp.stat(out)).size > 0 ? out : null;
  } catch {
    return null;
  }
}

/** Where the cut pieces live, so the caller can allowlist it for media://. */
function directory() {
  return cacheDir;
}

module.exports = {
  FRACTION,
  FLOOR_SECONDS,
  CAP_SECONDS,
  seekFor,
  clipArgs,
  clipPathFor,
  init,
  directory,
  stillFor,
  clipFor,
  readyClip,
};
