'use strict';

/**
 * THE MUSIC BED FOR A VIDEO UP-NEXT STYLE, and where in the song to start.
 *
 * [adult swim] used a different piece of music under every schedule bump, and
 * the point of this is that the channel does the same: a track is dealt from a
 * folder she chooses, and a fifteen-second stretch of it is picked
 * automatically. Nobody is asked which fifteen seconds — the same way Reels
 * offers you a start point rather than a waveform editor.
 *
 * ── Why not just start at zero ───────────────────────────────────────────
 *
 * Because these are full songs, two to four minutes each. Fifteen seconds from
 * the top of a track is usually an intro fading in from nothing, which under a
 * schedule card sounds like the audio is broken. What is wanted is a stretch
 * that is loud, EVEN, and that begins on a rise rather than in the middle of a
 * held note.
 *
 * ── The analysis ─────────────────────────────────────────────────────────
 *
 * ffmpeg's ebur128 filter prints momentary loudness roughly every 100ms. That
 * is the whole envelope, and it is enough. Measured on the five tracks in her
 * test folder: 136ms to 184ms for a complete pass over a three-minute song, so
 * this is cheap enough to do on demand, and it is cached anyway.
 *
 * Two things about that filter that cost time to find, both now load-bearing:
 * it prints NOTHING at the default log level (only a closing "Summary:"), so
 * -loglevel verbose is required; and a TARGET field sits between the timestamp
 * and the loudness, so the obvious regex matches nothing and reads exactly
 * like the filter being absent.
 *
 * ── Why this does not join shouldPause() ─────────────────────────────────
 *
 * The artwork and ingest sweeps stand down while anything plays, because two
 * ffmpegs against her external drive is the failure mode that whole design
 * exists to avoid. This is a different animal: one short audio-only decode of
 * a local file, once per track for the life of the cache, on demand. Latching
 * it off during playback would mean it could never run at all — the only time
 * it is ever wanted is immediately before a bumper.
 */

const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const path = require('node:path');

/** How long every video-style bumper runs. */
const CLIP_SECONDS = 15;

/**
 * What counts as music in the folder she points at.
 *
 * Deliberately its own list rather than a shared one: VIDEO_EXTENSIONS in
 * parseEpisode.js governs what becomes a programme, and an .mp3 must never
 * start being scanned as one.
 */
const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.oga', '.opus', '.wav', '.wma',
]);

/**
 * Loudness envelope out of ebur128's stderr.
 *
 * A line looks like:
 *   [Parsed_ebur128_0 @ 0000021512026880] t: 39.899977  TARGET:-23 LUFS    M: -12.2 S: -12.4 …
 *
 * The TARGET field between t: and M: is why this is not the two-token regex it
 * looks like it should be. Exported for its own test — a parser that silently
 * matches nothing turns every later step into "the analysis found nothing"
 * rather than "the parser is wrong".
 */
function parseEnvelope(stderr) {
  const points = [];
  for (const line of String(stderr).split(/\r?\n/)) {
    const match = /t:\s*([\d.]+).*?\bM:\s*(-?[\d.]+)/.exec(line);
    if (match) points.push({ t: Number(match[1]), lufs: Number(match[2]) });
  }
  return points;
}

/** ebur128 reports digital silence as a large negative number, not -Infinity. */
const SILENT = -70;

/**
 * The best place to start, given an envelope.
 *
 * Pure, and separated from the ffmpeg call precisely so it can be driven with
 * a synthetic envelope in a test. Scoring an audio heuristic against real mp3s
 * only tells you what it did, never what it would do to a shape you have not
 * got a file of.
 *
 * Three terms, and the third one is the one that had to be reined in:
 *
 *  - MEAN loudness, because a bumper wants the body of the song, not a verse
 *    that trails off.
 *  - CONSISTENCY, penalising variance, because fifteen seconds that are half
 *    silence sound broken however loud the other half is.
 *  - ONSET, rewarding a start that is louder than the second before it, which
 *    is what makes an entry sound deliberate rather than mid-phrase.
 *
 * The onset term is CLAMPED, and that is not tidiness. Unclamped, a track that
 * opens from digital silence scored a bonus of +44 against a typical +8, so
 * the beginning of the file won every time — and it won for the wrong reason,
 * because the "rise" it detected was just the file starting. Measured on
 * Vibe-Units in her folder: it picked 0.6s with onset +44.0.
 */
const MAX_ONSET_BONUS = 6;

function pickStart(envelope, clipSeconds = CLIP_SECONDS) {
  if (!envelope.length) return 0;
  const duration = envelope[envelope.length - 1].t;
  // Nothing to choose between: a sting shorter than the bumper plays from the
  // top, and the card simply runs on in silence after it. She may drop short
  // cuts in this folder, and a negative window length must not be computable.
  if (duration <= clipSeconds) return 0;

  const perSecond = envelope.length / (duration || 1);
  const span = Math.max(2, Math.round(clipSeconds * perSecond));
  const step = Math.max(1, Math.round(0.5 * perSecond));
  const lookBack = Math.max(1, Math.round(1 * perSecond));

  let best = null;
  for (let i = 0; i + span < envelope.length; i += step) {
    const window = envelope.slice(i, i + span).map((p) => p.lufs).filter((v) => v > SILENT);
    // Mostly silence: not a candidate at any loudness.
    if (window.length < span / 2) continue;

    const mean = window.reduce((a, b) => a + b, 0) / window.length;
    const spread = Math.sqrt(
      window.reduce((a, b) => a + ((b - mean) ** 2), 0) / window.length,
    );

    const before = envelope.slice(Math.max(0, i - lookBack), i)
      .map((p) => p.lufs).filter((v) => v > SILENT);
    const beforeMean = before.length
      ? before.reduce((a, b) => a + b, 0) / before.length
      : mean;
    const onset = Math.min(MAX_ONSET_BONUS, Math.max(0, mean - beforeMean));

    const total = mean + (onset * 1.5) - (spread * 0.5);
    if (!best || total > best.total) best = { total, at: envelope[i].t };
  }

  return best ? Number(best.at.toFixed(2)) : 0;
}

/**
 * Run the analysis. Rejects rather than guessing if ffmpeg is not there —
 * a silent fallback to zero would ship as "the music always starts at the
 * intro" and never be traced back to a missing binary.
 */
function runEbur128(ffmpegPath, absPath, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      '-hide_banner',
      // REQUIRED. At the default level ebur128 prints only its closing
      // "Summary:" and not one per-frame line, which reads as a missing filter.
      '-loglevel', 'verbose',
      '-i', absPath,
      '-af', 'ebur128',
      '-f', 'null', '-',
    ], { windowsHide: true });

    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`ebur128 timed out on ${path.basename(absPath)}`));
    }, timeoutMs);

    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(stderr);
    });
  });
}

/**
 * Keyed on path AND size AND mtime, the same way the ffprobe memo is.
 *
 * Path alone would hand back a stale answer for a file she replaced with a
 * different recording under the same name, and the symptom — the music
 * starting somewhere arbitrary — is not one anybody would connect to a cache.
 */
const startCache = new Map();

async function startFor(absPath, ffmpegPath) {
  const stat = await fsp.stat(absPath);
  const key = `${absPath}:${stat.size}:${stat.mtimeMs}`;
  if (startCache.has(key)) return startCache.get(key);

  const stderr = await runEbur128(ffmpegPath, absPath);
  const envelope = parseEnvelope(stderr);
  if (!envelope.length) {
    throw new Error(`no loudness data for ${path.basename(absPath)} — is this an audio file?`);
  }
  const start = pickStart(envelope);
  startCache.set(key, start);
  return start;
}

/** Every playable track in the folder, natural-sorted so a deal is repeatable. */
async function listTracks(dir) {
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];   // an unplugged drive or a folder she moved is not an error here
  }
  return entries
    .filter((entry) => entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(dir, entry.name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

/**
 * Choose a track, avoiding the one that just played.
 *
 * Not the persisted deck the bumper and promo clips use. Those decks exist so
 * every clip is seen once before any repeats, which matters for a handful of
 * stings you would notice repeating. Music under a card is background — what
 * would be noticed is the SAME song twice running, and that is all this
 * prevents. `lastPath` is passed in rather than held here so the caller
 * decides how long the memory lasts.
 */
function chooseTrack(tracks, lastPath, random = Math.random) {
  if (tracks.length === 0) return null;
  if (tracks.length === 1) return tracks[0];
  const fresh = tracks.filter((track) => track !== lastPath);
  const pool = fresh.length ? fresh : tracks;
  return pool[Math.floor(random() * pool.length)] || pool[0];
}

/** A track's name, without the extension, for anything that wants to show it. */
function trackTitle(absPath) {
  return path.basename(absPath, path.extname(absPath));
}

module.exports = {
  CLIP_SECONDS,
  AUDIO_EXTENSIONS,
  MAX_ONSET_BONUS,
  parseEnvelope,
  pickStart,
  startFor,
  listTracks,
  chooseTrack,
  trackTitle,
};
