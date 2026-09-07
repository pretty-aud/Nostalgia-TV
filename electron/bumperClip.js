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

/** The rule, in one place. */
const FRACTION = 0.12;
const FLOOR_SECONDS = 90;
const CAP_SECONDS = 600;

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

function init(options = {}) {
  cacheDir = options.dir || null;
  if (typeof options.findFfmpeg === 'function') findFfmpeg = options.findFfmpeg;
}

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
  await run([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', String(seek),
    '-i', absPath,
    '-frames:v', '1',
    // Height-limited rather than width-limited: this is a full-bleed
    // background, and it is the vertical that decides whether it looks soft.
    '-vf', "scale=-2:'min(1080,ih)'",
    '-q:v', '3',
    out,
  ], out, 45000);

  return out;
}

/**
 * A short H.264 clip from the chosen point, silent.
 *
 * The audio is dropped because mpv is already playing the bumper's cue over
 * this; two soundtracks at once is not a subtle bug.
 */
async function clipFor(absPath, durationSeconds, clipSeconds) {
  if (!cacheDir) throw new Error('bumperClip.init was never called');
  const stat = await fsp.stat(absPath);
  const seek = seekFor(durationSeconds, clipSeconds);
  const out = path.join(cacheDir, `${cacheKey(absPath, stat, `clip${clipSeconds}`, seek)}.mp4`);

  try {
    if ((await fsp.stat(out)).size > 0) return out;
  } catch { /* not cut yet */ }

  const existing = jobs.get(out);
  if (existing) return existing;

  await fsp.mkdir(cacheDir, { recursive: true });
  const job = run([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', String(seek),
    '-i', absPath,
    '-t', String(clipSeconds),
    '-an',                       // mpv owns the sound
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
  ], out, 120000).finally(() => jobs.delete(out));

  jobs.set(out, job);
  return job;
}

module.exports = {
  FRACTION,
  FLOOR_SECONDS,
  CAP_SECONDS,
  seekFor,
  init,
  stillFor,
  clipFor,
};
