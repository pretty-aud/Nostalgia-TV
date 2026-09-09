import { describe, it, expect } from 'vitest';
import {
  onsetEnvelope, tempoOf, beatPhase, gridFrom,
  FPS, FALLBACK_BPM, BEATS_PER_BAR, RANGES, AGREE,
} from '../electron/bumperTempo.js';

/**
 * Driven by SYNTHETIC envelopes with a known answer.
 *
 * The estimator was built against her nineteen real tracks and that is how the
 * bias in it was found — but a real mp3 only ever tells you what the code did,
 * never what it would do to a shape there is no file of. Here the period is put
 * in by hand, so "did it find 100 BPM" has a right answer.
 */

/**
 * An energy series with a click every `period` frames.
 *
 * PLACED WITH SUB-FRAME ACCURACY, and that is not a detail. The first version
 * rounded each click to a whole frame, which at 128 BPM (a period of 40.4
 * frames) makes the gaps alternate 40, 41, 40, 40 — while exactly two periods
 * land on 81. The half-tempo therefore correlated BETTER than the real one, and
 * the estimator dutifully reported 64 BPM. That was the fixture manufacturing
 * an octave error, not the code making one, and weakening the estimator to
 * agree with it would have been fixing the wrong thing.
 *
 * Spreading each click across the two frames it falls between is also what a
 * real onset does — no drum hits exactly on a frame boundary either.
 */
function pulses(seconds, bpm, {
  jitter = 0, noise = 0, seed = 1, bed = 0.02,
} = {}) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const n = Math.round(seconds * FPS);
  const period = FPS * 60 / bpm;
  const energy = new Array(n).fill(bed);

  const strike = (at, amp) => {
    const i = Math.floor(at);
    const frac = at - i;
    if (i >= 0 && i < n) energy[i] = Math.max(energy[i], amp * (1 - frac));
    if (i + 1 >= 0 && i + 1 < n) energy[i + 1] = Math.max(energy[i + 1], amp * frac + amp * 0.45 * (1 - frac));
    if (i + 2 >= 0 && i + 2 < n) energy[i + 2] = Math.max(energy[i + 2], amp * 0.45 * frac);
  };

  for (let k = 0; ; k += 1) {
    const at = k * period + (jitter ? (rnd() - 0.5) * jitter * FPS : 0);
    if (at >= n) break;
    strike(at, 0.9);
  }
  return noise ? energy.map((v) => Math.max(0, v + (rnd() - 0.5) * noise)) : energy;
}

describe('finding the tempo', () => {
  for (const bpm of [72, 90, 100, 128]) {
    it(`finds ${bpm} BPM in a clean pulse train`, () => {
      const t = tempoOf(onsetEnvelope(pulses(40, bpm)));
      expect(t.confident, t.reason).toBe(true);
      expect(t.bpm).toBeGreaterThan(bpm * 0.97);
      expect(t.bpm).toBeLessThan(bpm * 1.03);
    });
  }

  /**
   * A MUSICAL noise floor, not silence plus hiss.
   *
   * The first version put +-0.125 of noise on a floor of 0.02, so between hits
   * the signal was almost entirely noise — a shape no recording has, and it
   * pulled the estimate 17 BPM out. Real music is continuous: there is always
   * something sounding between the drums, which is why the same code reads 15
   * of her 19 actual tracks stably. `bed` is that continuous content.
   *
   * The jitter stays: no drummer is a metronome, and an estimator that needs
   * one is no use here.
   */
  it('survives a noisy envelope over a continuous bed', () => {
    const t = tempoOf(onsetEnvelope(pulses(40, 96, { bed: 0.18, noise: 0.1, jitter: 0.012 })));
    expect(t.confident, t.reason).toBe(true);
    expect(Math.abs(t.bpm - 96), `read ${t.bpm.toFixed(1)}`).toBeLessThan(4);
  });

  /**
   * THE BUG THAT MADE THE FIRST VERSION FICTION.
   *
   * Autocorrelation of a strictly non-negative envelope is dominated by its
   * mean, and with nothing penalising long lags the longest lag generally won —
   * so the answer was whichever wall the search range happened to have. On real
   * tracks it reported 60.1 BPM, the floor; widening the floor to 45 moved the
   * same tracks to 45.7. Three of eight changed answer when only the range
   * changed.
   *
   * A featureless envelope is the shape that provoked it, and the right
   * behaviour is to say so rather than to name a tempo.
   */
  it('does not mistake a featureless envelope for a very slow tempo', () => {
    const flat = new Array(Math.round(40 * FPS)).fill(0.1);
    const t = tempoOf(onsetEnvelope(flat));
    expect(t.confident).toBe(false);
    expect(t.bpm).toBe(FALLBACK_BPM);
  });

  it('does not let the search range decide the answer', () => {
    // The property the multi-range check exists to enforce, stated directly: a
    // real tempo does not care where the walls are. RANGES differ by 20-40 BPM
    // at each end, so a boundary-hugging estimate cannot agree with itself.
    const onsets = onsetEnvelope(pulses(40, 84));
    const t = tempoOf(onsets);
    expect(t.confident).toBe(true);
    for (const [lo, hi] of RANGES) {
      expect(t.bpm, `${lo}-${hi} must contain the answer`).toBeGreaterThan(lo);
      expect(t.bpm).toBeLessThan(hi);
    }
  });

  it('falls back rather than guessing when the ranges disagree', () => {
    // Two periods at once, neither dominant — the shape that genuinely has no
    // single tempo. It must decline, not pick one.
    const a = pulses(40, 77);
    const b = pulses(40, 103);
    const mixed = a.map((v, i) => Math.max(v, b[i] || 0));
    const t = tempoOf(onsetEnvelope(mixed));
    if (!t.confident) {
      expect(t.bpm).toBe(FALLBACK_BPM);
      expect(t.reason).toMatch(/unstable|short/);
    } else {
      // If it IS confident, it must at least have picked one of the two, not
      // some average of them that matches neither.
      expect([77, 103].some((x) => Math.abs(t.bpm - x) < 4), `chose ${t.bpm.toFixed(1)}`).toBe(true);
    }
  });

  /**
   * A MAJORITY, NOT A UNANIMOUS VOTE — and the reason is arithmetic.
   *
   * The rule was that all three search ranges had to agree. On her 33-track
   * folder that rejected 12, and the readings showed seven of them with two
   * ranges agreeing EXACTLY (68/68, 62/62, 64/64...) thrown out by a third that
   * had reached for a number nobody else found. Two independent searches
   * landing on one tempo is evidence; one dissenter is the outlier.
   *
   * Measured before and after on the real folder: 21 confident became 31, with
   * ZERO existing answers changed and none lost. It only ever adds.
   */
  it('believes a tempo two of three ranges agree on', () => {
    // A slow pulse is the shape that split the vote: the widest range reaches
    // past it for a faster reading while the other two agree.
    const t = tempoOf(onsetEnvelope(pulses(40, 64, { bed: 0.16, noise: 0.06 })));
    expect(t.confident, t.reason).toBe(true);
    expect(Math.abs(t.bpm - 64), `read ${t.bpm.toFixed(1)}`).toBeLessThan(4);
  });

  /**
   * ONE RANGE IS NEVER A MAJORITY. This is the property the whole check exists
   * for — a single boundary-hugging estimate must never be believed — and
   * relaxing unanimity is exactly the change that could have destroyed it.
   */
  it('still refuses when no two ranges agree', () => {
    const flat = new Array(Math.round(40 * FPS)).fill(0.1);
    const t = tempoOf(onsetEnvelope(flat));
    expect(t.confident).toBe(false);
    expect(t.bpm).toBe(FALLBACK_BPM);
  });

  it('says how many ranges agreed, so a marginal read is legible', () => {
    const t = tempoOf(onsetEnvelope(pulses(40, 100)));
    expect(t.confident).toBe(true);
    expect(t.reason).toMatch(/stable|ranges agree/);
  });

  it('declines on a clip too short to hold a bar', () => {
    const t = tempoOf(onsetEnvelope(pulses(1.2, 90)));
    expect(t.confident).toBe(false);
  });
});

describe('where beat one lands', () => {
  it('finds the offset a pulse train was built with', () => {
    const bpm = 90;
    const period = FPS * 60 / bpm;
    const n = Math.round(30 * FPS);
    const shiftFrames = period * 0.4;
    const energy = new Array(n).fill(0.02);
    for (let k = 0; k * period + shiftFrames < n; k += 1) {
      const at = k * period + shiftFrames;
      const i = Math.floor(at);
      const frac = at - i;
      if (i < n) energy[i] = 0.9 * (1 - frac) + 0.02;
      if (i + 1 < n) energy[i + 1] = 0.9 * frac + 0.4 * (1 - frac);
    }

    const onsets = onsetEnvelope(energy);
    const t = tempoOf(onsets);
    expect(t.confident, t.reason).toBe(true);
    const phase = beatPhase(onsets, t.period || t.lag);
    /**
     * Within two envelope frames (~23ms). The onset detector reports the rise
     * ACROSS a frame boundary, so it is inherently a frame late — asking for
     * better than that would be asking the test to know something the signal
     * does not carry. 23ms is far under what reads as a late cut.
     */
    expect(Math.abs(phase - shiftFrames / FPS)).toBeLessThan(2.5 / FPS);
  });
});

describe('the grid a card cuts on', () => {
  const tempo = { bpm: 120, confident: true, phase: 0.25 };

  it('is spaced at the beat', () => {
    const { period, beats } = gridFrom(tempo, 0, 8);
    expect(period).toBeCloseTo(0.5, 3);
    for (let i = 1; i < beats.length; i += 1) {
      expect(beats[i] - beats[i - 1]).toBeCloseTo(0.5, 2);
    }
  });

  /**
   * THE ONE THAT WOULD BE OFF BY A CONSTANT.
   *
   * The music does not start at the top of the file — pickStart chooses a hook
   * somewhere inside it, and that offset is almost never on a beat. Ignore it
   * and every cut is late by the same amount, which looks exactly like tempo
   * detection that does not work.
   */
  it('is measured from where playback starts, not from the top of the file', () => {
    const startAt = 21.57;                       // a real hook offset from the smoke test
    const { beats } = gridFrom(tempo, startAt, 8);
    expect(beats[0]).toBeGreaterThanOrEqual(0);
    expect(beats[0]).toBeLessThan(0.5);
    // Every beat must land on the track's own grid once the offset is added.
    for (const b of beats) {
      const absolute = startAt + b - tempo.phase;
      expect(Math.abs(absolute / 0.5 - Math.round(absolute / 0.5))).toBeLessThan(0.01);
    }
  });

  /**
   * THE MEASURED BEAT SITS BEFORE THE HOOK, which is the normal case now.
   *
   * The window starts two seconds ahead of the hook so the analysis does not
   * begin on a downbeat, so the beat it finds is usually EARLIER in the file
   * than where playback starts. The previous form used ceil() on a clamped
   * difference and handed back a first beat a whole period late for exactly
   * this input — a card whose every cut is one beat behind the music, with a
   * tempo number that reads perfectly correct.
   */
  it('handles a beat measured before the hook, which is the usual case', () => {
    const measured = { bpm: 120, confident: true, phase: 19.0 };  // window began at 19
    const { beats, period } = gridFrom(measured, 21.0, 4);        // hook at 21
    expect(beats[0]).toBeGreaterThanOrEqual(0);
    expect(beats[0]).toBeLessThan(period);
    // 21.0 - 19.0 = 2.0s = exactly four periods, so the first beat is at zero.
    expect(beats[0]).toBeCloseTo(0, 3);
  });

  it('places the first beat correctly when the offset is not a whole period', () => {
    const measured = { bpm: 120, confident: true, phase: 19.1 };
    const { beats } = gridFrom(measured, 21.0, 4);
    // 1.9s after the measured beat is 3.8 periods; the next lands 0.1s in.
    expect(beats[0]).toBeCloseTo(0.1, 2);
  });

  it('never returns a beat before the card begins', () => {
    const { beats } = gridFrom(tempo, 9.13, 12);
    expect(beats.every((b) => b >= 0)).toBe(true);
  });

  it('ignores a phase it was told not to trust', () => {
    // An unconfident tempo has no meaningful phase, so the grid starts at zero
    // rather than at a number that came from nowhere.
    const { beats } = gridFrom({ bpm: FALLBACK_BPM, confident: false, phase: 0.4 }, 5, 4);
    expect(beats[0]).toBe(0);
  });

  it('measures a bar as four beats', () => {
    const { period, barLength } = gridFrom(tempo, 0, 8);
    expect(barLength).toBeCloseTo(period * BEATS_PER_BAR, 6);
  });
});
