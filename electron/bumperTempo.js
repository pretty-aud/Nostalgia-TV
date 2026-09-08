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

/**
 * The fallback when a track has no tempo this can find — ambient, rubato, or
 * simply too short. 90 BPM is a plain, mid-tempo pulse: the card still cuts on
 * a regular beat, it just is not claiming to have heard one.
 */
const FALLBACK_BPM = 90;

/**
 * FOUR BEATS TO THE BAR, ASSUMED, and stated rather than detected.
 *
 * Telling 3/4 from 4/4 needs downbeat detection, which is a different and much
 * harder problem than tempo — it depends on harmonic change and stress, not on
 * periodicity, and a wrong answer would put every cut on the wrong beat of the
 * bar rather than merely somewhere odd. Almost everything this style will be
 * pointed at is in four. If a waltz turns up, the cuts land on beats rather
 * than bars and nobody can tell.
 */
const BEATS_PER_BAR = 4;

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

  const bpms = reads.map((r) => r.bpm);
  const spread = (Math.max(...bpms) - Math.min(...bpms)) / bpms[0];
  if (spread > AGREE) {
    return {
      bpm: FALLBACK_BPM,
      confident: false,
      reason: `unstable across ranges (${bpms.map((b) => b.toFixed(0)).join('/')})`,
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
  return { ...reads[0], confident: true, reason: 'stable' };
}

/**
 * The beat times a card should cut on, in seconds from the moment playback
 * starts — which is `startAt` into the file, not its beginning.
 *
 * THE HOOK AND THE GRID HAVE TO AGREE. bumperMusic.pickStart chooses where in
 * the track to come in, and that offset is almost never on a beat. Without
 * folding it in here, every cut would be out by the same constant, which is the
 * failure that looks most like "the beat detection does not work".
 */
function gridFrom(tempo, startAt, seconds) {
  const period = 60 / (tempo.bpm || FALLBACK_BPM);

  const beats = [];
  /**
   * WITHOUT A TRUSTED PHASE THE GRID STARTS AT ZERO.
   *
   * An unconfident read has no meaningful phase — there was no peak to take one
   * from — so aligning to it would be aligning to a number that came from
   * nowhere, and would push the first cut an arbitrary fraction of a beat late
   * for no reason. Starting at zero at least makes the first pop land with the
   * music coming in.
   */
  const first = tempo.confident
    ? (tempo.phase || 0) + Math.ceil(Math.max(0, startAt - (tempo.phase || 0)) / period) * period - startAt
    : 0;

  for (let t = first; t < seconds; t += period) {
    if (t >= 0) beats.push(Number(t.toFixed(3)));
  }
  return { period, beats, barLength: period * BEATS_PER_BAR };
}

/**
 * Analyse a file. Cached on path, size and mtime — the same key bumperMusic
 * uses, so a track edited in place is re-read and an untouched one never is.
 */
const cache = new Map();

async function tempoFor(absPath, stat) {
  const key = `${absPath}|${stat ? stat.size : 0}|${stat ? Number(stat.mtimeMs) : 0}`;
  if (cache.has(key)) return cache.get(key);

  const ffmpeg = deps.findFfmpeg ? await deps.findFfmpeg() : null;
  if (!ffmpeg) {
    const out = { bpm: FALLBACK_BPM, confident: false, reason: 'no ffmpeg' };
    cache.set(key, out);
    return out;
  }

  const args = [
    '-v', 'error', '-i', absPath,
    '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1', '-',
  ];

  let result;
  try {
    const child = (deps.run || spawn)(ffmpeg, args);
    const energy = await envelopeFrom(child.stdout);
    const onsets = onsetEnvelope(energy);
    result = tempoOf(onsets);
    if (result.confident) result.phase = beatPhase(onsets, result.period || result.lag);
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
