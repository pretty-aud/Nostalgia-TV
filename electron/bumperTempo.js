'use strict';

/**
 * THE BEAT GRID: where the cuts land in a Minimal Lofi bumper.
 *
 * The card's text pops on and off ON THE BEAT of whatever track was dealt, so
 * this has to answer two questions about an arbitrary mp3: how fast is it, and
 * where does a beat actually fall. Tempo alone is not enough — a grid at the
 * right speed and the wrong phase is off on every single cut.
 *
 * ── Why not the envelope bumperMusic already has ─────────────────────────
 *
 * ebur128 prints roughly every 100ms, so ~10 points per second. That is enough
 * to find a tempo and nowhere near enough to place one: a cut 100ms off the
 * beat is plainly late to anyone watching. Decoding to raw mono PCM at 22kHz
 * and taking RMS every 256 samples gives 86 points per second — eight times the
 * resolution, for about 150ms of work on a four-minute track. Measured on her
 * nineteen tracks: 46ms to 257ms each, and it is cached anyway.
 *
 * ── The bias that made the first version fiction ─────────────────────────
 *
 * Autocorrelating the onset envelope directly reported 60.1 BPM for two tracks
 * — which was the floor of the search range. Widening the range to 45 moved
 * those answers to 45.7 and 44.9. The estimator was not finding a tempo; it was
 * running to whichever wall it was given, because autocorrelation of a strictly
 * non-negative signal is dominated by its MEAN and nothing penalised long lags.
 * Three of eight tracks changed answer when only the range changed.
 *
 * Two standard fixes: zero-mean the envelope, which removes the DC term
 * outright, and weight by a log-normal prior around 100 BPM, which is the usual
 * remedy for a tempo that correlates equally well at half and double speed.
 *
 * ── And the confidence measure that came out of it ───────────────────────
 *
 * The peak's height above the mean does NOT separate the good reads from the
 * bad — some wrong answers score higher than right ones. What does separate
 * them is asking the same question three times with different walls: a real
 * tempo does not care where the search range ends. Anything that moves is an
 * artifact, and is treated as unknown rather than trusted. On her nineteen
 * tracks that accepts 15 and rejects 4, and the four it rejects are the two
 * genuinely ambiguous ones plus one track only 18 seconds long.
 */

const { spawn } = require('child_process');
const { gridFrom, BEATS_PER_BAR, FALLBACK_BPM } = require('../src/shared/beatGrid.js');

/** 22kHz mono is far more than onsets need, and an eighth of the data. */
const SAMPLE_RATE = 22050;
/** 256 samples per frame -> 86.1 envelope points per second. */
const HOP = 256;
const FPS = SAMPLE_RATE / HOP;

/**
 * The range actually shipped, plus two others used only to test stability.
 * The shipped one is first; its answer is the one returned.
 */
const RANGES = [[60, 180], [50, 190], [70, 160]];

/** Tempos disagreeing by more than this across ranges are not believed. */
const AGREE = 0.02;



let deps = { findFfmpeg: null, run: null };

function init(options = {}) {
  deps = { ...deps, ...options };
}

/**
 * Raw mono PCM to an RMS energy envelope, without ever holding the audio.
 *
 * A four-minute track is about 10MB of PCM. It is reduced to 86 floats per
 * second as it arrives, so peak memory is one chunk rather than the file.
 */
function envelopeFrom(stream) {
  return new Promise((resolve, reject) => {
    const energy = [];
    let carry = Buffer.alloc(0);
    const frameBytes = HOP * 2;

    stream.on('data', (chunk) => {
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      let off = 0;
      while (off + frameBytes <= buf.length) {
        let sum = 0;
        for (let i = 0; i < HOP; i += 1) {
          const s = buf.readInt16LE(off + i * 2) / 32768;
          sum += s * s;
        }
        energy.push(Math.sqrt(sum / HOP));
        off += frameBytes;
      }
      carry = buf.subarray(off);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve(energy));
  });
}

/**
 * Energy to onset strength: the half-wave-rectified rise in log energy, with a
 * local mean removed so a loud chorus does not outvote a quiet verse, and then
 * zero-meaned so the autocorrelation below has no DC term to chase.
 *
 * Pure, and exported, because an audio heuristic driven only by real mp3s tells
 * you what it did and never what it would do to a shape you have no file of.
 */
function onsetEnvelope(energy) {
  const db = energy.map((e) => 20 * Math.log10(e + 1e-9));
  const rise = new Array(db.length).fill(0);
  for (let i = 1; i < db.length; i += 1) rise[i] = Math.max(0, db[i] - db[i - 1]);

  const W = Math.round(FPS * 0.5);
  const local = rise.map((v, i) => {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - W); j < Math.min(rise.length, i + W); j += 1) { sum += rise[j]; n += 1; }
    return Math.max(0, v - (n ? sum / n : 0));
  });

  const mean = local.reduce((a, v) => a + v, 0) / (local.length || 1);
  return local.map((v) => v - mean);
}

/**
 * At least this many periods must fit in the envelope before a lag is believed.
 * Two pulses are not a tempo; they are two pulses.
 */
const MIN_PERIODS = 6;

/**
 * A double-tempo reading is preferred when it scores at least this fraction of
 * the slower one. See the octave note in peakIn.
 */
const OCTAVE_PREFERENCE = 0.72;

/** The best-scoring lag in one search range. */
function peakIn(onsets, minBpm, maxBpm) {
  const minLag = Math.max(2, Math.round(FPS * 60 / maxBpm));
  const longest = Math.floor(onsets.length / MIN_PERIODS);
  const maxLag = Math.min(longest, Math.round(FPS * 60 / minBpm));
  if (maxLag <= minLag) return null;

  const scored = new Map();
  let best = null;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let sum = 0;
    for (let i = 0; i + lag < onsets.length; i += 1) sum += onsets[i] * onsets[i + lag];
    const bpm = 60 * FPS / lag;
    /**
     * A log-normal prior on tempo, one octave wide about 100 BPM. Half and
     * double a tempo correlate equally well — the periodicity is genuinely
     * there at both — so something has to break the tie, and "music is usually
     * near 100" is the assumption every tempo estimator makes.
     */
    const prior = Math.exp(-0.5 * ((Math.log2(bpm / 100) / 0.9) ** 2));
    const score = (sum / (onsets.length - lag)) * prior;
    scored.set(lag, score);
    if (!best || score > best.score) best = { lag, bpm, score };
  }

  /**
   * OCTAVE RESOLUTION, and the prior alone does not do it.
   *
   * Every multiple of the true period correlates too — at twice the lag, every
   * pulse still lines up — and for a strictly regular rhythm the slower reading
   * often scores HIGHER, because it is averaged over fewer overlapping terms.
   * A clean 128 BPM pulse train read as 64 for exactly this reason, in two of
   * the three search ranges.
   *
   * So when half the winning lag is also in range and holds most of its score,
   * take the faster reading. Real music breaks this tie by itself, with
   * off-beats that only fit the faster grid; synthetic rhythm and very sparse
   * music do not, and those are the cases that need the rule.
   */
  let chosen = best;
  for (let i = 0; i < 2; i += 1) {
    const half = Math.round(chosen.lag / 2);
    if (half < minLag || !scored.has(half)) break;
    if (scored.get(half) < chosen.score * OCTAVE_PREFERENCE) break;
    chosen = { lag: half, bpm: 60 * FPS / half, score: scored.get(half) };
  }

  /**
   * A FRACTIONAL PERIOD, and over fifteen seconds this is the difference
   * between cutting on the beat and cutting late.
   *
   * The lag is a whole number of envelope frames, but a tempo is not. A 90 BPM
   * track has a period of 57.42 frames; grid it at 57 and every beat is 0.42
   * frames early, which by the twenty-second beat is nine frames — 105ms, and
   * plainly late to anyone watching. Measured directly: onsets at 23, 80, 137,
   * 195 against a grid predicting 23, 80, 137, 194.
   *
   * Parabolic interpolation through the three scores around the peak recovers
   * the sub-frame position, which is the standard fix and costs nothing.
   */
  const a = scored.get(chosen.lag - 1);
  const b = chosen.score;
  const c = scored.get(chosen.lag + 1);
  let period = chosen.lag;
  if (a !== undefined && c !== undefined) {
    const denom = a - 2 * b + c;
    if (denom !== 0) {
      const delta = 0.5 * (a - c) / denom;
      if (Math.abs(delta) <= 1) period = chosen.lag + delta;
    }
  }

  return { ...chosen, period, bpm: 60 * FPS / period };
}

/**
 * WHERE BEAT ONE LANDS. Slide a pulse train at the found period across the
 * envelope and keep the offset that collects the most onset strength.
 *
 * Returned in seconds from the start of the FILE. Callers wanting a grid from
 * some other point must fold that in themselves; gridFrom() below does it.
 */
function beatPhase(onsets, period) {
  let bestOffset = 0;
  let bestScore = -Infinity;
  // Quarter-frame steps: about 3ms, finer than the envelope itself resolves,
  // so the search is not the thing limiting accuracy.
  for (let off = 0; off < period; off += 0.25) {
    let sum = 0;
    let n = 0;
    for (let t = off; t < onsets.length; t += period) {
      sum += onsets[Math.round(t)];
      n += 1;
    }
    /**
     * THE MEAN, NOT THE SUM — the same bias as the tempo search, in a second
     * place. The envelope is zero-meaned, so most of its values are negative;
     * a larger offset collects FEWER terms and therefore a less negative total,
     * which would quietly push the answer toward the end of the range.
     */
    const score = n ? sum / n : -Infinity;
    if (score > bestScore) { bestScore = score; bestOffset = off; }
  }
  return bestOffset / FPS;
}

/**
 * Tempo from an onset envelope, believed only if it survives three ranges.
 *
 * Pure, so a test can hand it a synthetic envelope with a known period and get
 * a defined answer, including for the shapes that have no tempo at all.
 */
function tempoOf(onsets) {
  const reads = RANGES.map(([lo, hi]) => peakIn(onsets, lo, hi)).filter(Boolean);
  if (reads.length < RANGES.length) {
    return { bpm: FALLBACK_BPM, confident: false, reason: 'too short to analyse' };
  }

  /**
   * A MAJORITY, NOT A UNANIMOUS VOTE.
   *
   * The rule was that all three ranges had to agree within AGREE, and on her
   * 33-track folder that rejected 12. The readings show why: seven of them had
   * two ranges agreeing EXACTLY — 68/68, 62/62, 64/64, 66/66, 67/67 — and were
   * thrown out by the third, which in almost every case was the widest range
   * reaching for a number nobody else found. A tempo two independent searches
   * land on is not an artifact; one dissenting search is the outlier.
   *
   * What this deliberately does NOT do is loosen AGREE or narrow the ranges.
   * The tolerance is 2% because a 50% disagreement is a different answer, not
   * noise. And the ranges being far apart is the whole mechanism — it is what
   * caught the original bug, where the estimator simply ran to whichever wall
   * it was given. Making them more similar to pass more tracks would disarm
   * the check while appearing to improve it.
   *
   * The agreeing pair's own reading is returned, not the outlier's.
   */
  const agreed = pickMajority(reads);
  if (!agreed) {
    const bpms = reads.map((r) => r.bpm);
    return {
      bpm: FALLBACK_BPM,
      confident: false,
      reason: `no two ranges agree (${bpms.map((b) => b.toFixed(0)).join('/')})`,
    };
  }

  /**
   * SPREAD, NOT REBUILT. The first version listed the fields it wanted —
   * bpm and lag — which silently dropped the fractional `period` that peakIn
   * had just gone to the trouble of interpolating, so the phase search fell
   * back to the integer lag and drifted exactly as before. The fix was
   * invisible because nothing referenced a missing field; it just quietly
   * stopped being better.
   */
  return { ...agreed.read, confident: true, reason: agreed.reason };
}

/**
 * The largest set of range-readings that agree with each other within AGREE.
 *
 * Returns the FIRST reading of that set — the ranges are ordered with the
 * shipped one first, so when it is part of the majority its own answer is the
 * one used, fractional period and all.
 *
 * Two is enough out of three. One reading alone is not a majority and never
 * qualifies, which is what keeps a single boundary-hugging estimate from being
 * believed — the failure this whole check exists for.
 */
function pickMajority(reads) {
  let best = null;
  for (const candidate of reads) {
    const cluster = reads.filter(
      (r) => Math.abs(r.bpm - candidate.bpm) / candidate.bpm <= AGREE,
    );
    if (cluster.length < 2) continue;
    if (!best || cluster.length > best.cluster.length) {
      best = { cluster, read: cluster[0] };
    }
  }
  if (!best) return null;
  return {
    read: best.read,
    reason: best.cluster.length === reads.length
      ? 'stable'
      : `${best.cluster.length} of ${reads.length} ranges agree`,
  };
}


/**
 * Analyse a file. Cached on path, size and mtime — the same key bumperMusic
 * uses, so a track edited in place is re-read and an untouched one never is.
 */
const cache = new Map();

/**
 * How much audio to analyse, and how far before the hook to start.
 *
 * A 20-second window holds 1723 envelope frames, which still leaves peakIn's
 * MIN_PERIODS floor room for a 60 BPM read, so all three ranges resolve and the
 * stability check keeps its meaning. It costs about 55ms and 320KB against
 * 250ms and 5.7MB for a whole track — and unlike the whole track, that cost
 * does not grow with the file.
 *
 * The two seconds of lead-in exist so the window does not begin exactly on the
 * hook, where a track often enters on a downbeat that the local-mean
 * subtraction would then flatten.
 */
const WINDOW_SECONDS = 20;
const LEAD_IN = 2;

async function tempoFor(absPath, stat, hookSeconds = 0) {
  const from = Math.max(0, (Number(hookSeconds) || 0) - LEAD_IN);
  /**
   * THE HOOK IS PART OF THE KEY. The analysis is now of one window rather than
   * of the file, so two different hooks in the same track are two different
   * questions — and a cache that answered the first for the second would put
   * the grid a bar out with nothing to show for it.
   */
  const key = `${absPath}|${stat ? stat.size : 0}|${stat ? Number(stat.mtimeMs) : 0}|${from.toFixed(1)}`;
  if (cache.has(key)) return cache.get(key);

  const ffmpeg = deps.findFfmpeg ? await deps.findFfmpeg() : null;
  if (!ffmpeg) {
    /**
     * NOT CACHED, and that is the point.
     *
     * init() is called once at startup; if it has not run, findFfmpeg is null
     * and this branch is reached for reasons that have nothing to do with the
     * track. Caching it would answer "no ffmpeg" for that file for the rest of
     * the session even after wiring was fixed — a feature that stays broken
     * after the bug is gone, which is the hardest kind to believe.
     */
    return { bpm: FALLBACK_BPM, confident: false, reason: 'no ffmpeg (is init() wired?)' };
  }

  const args = [
    '-v', 'error',
    // BEFORE -i. An input seek jumps rather than decoding everything up to the
    // point, which is the whole saving on a four-minute track.
    '-ss', String(from),
    '-i', absPath,
    '-t', String(WINDOW_SECONDS),
    '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1', '-',
  ];

  let result;
  try {
    const child = (deps.run || spawn)(ffmpeg, args);
    const energy = await envelopeFrom(child.stdout);
    const onsets = onsetEnvelope(energy);
    result = tempoOf(onsets);
    if (result.confident) {
      /**
       * ABSOLUTE, not relative to the window.
       *
       * beatPhase answers "how far into what I analysed", and what was analysed
       * began at `from`. Storing that relative number and extrapolating from
       * file zero at play time is the defect this whole rewrite exists to
       * remove: her hooks run out to 222 seconds, and at that distance the
       * ~1.9% step between adjacent integer lags is 4.2 seconds — six and a
       * half beats. The cuts would come out perfectly regular and uniformly
       * wrong, which is the failure that looks exactly like beat detection not
       * working, and staring at the BPM would tell you nothing.
       *
       * Measured near the hook and kept as a time in the file, the
       * extrapolation is never more than twenty seconds long.
       */
      result.phase = from + beatPhase(onsets, result.period || result.lag);
      result.windowFrom = from;
    }
  } catch (error) {
    result = { bpm: FALLBACK_BPM, confident: false, reason: `analysis failed: ${error.message}` };
  }

  cache.set(key, result);
  return result;
}

module.exports = {
  init,
  tempoFor,
  onsetEnvelope,
  tempoOf,
  beatPhase,
  gridFrom,
  envelopeFrom,
  SAMPLE_RATE,
  HOP,
  FPS,
  RANGES,
  AGREE,
  FALLBACK_BPM,
  BEATS_PER_BAR,
};
