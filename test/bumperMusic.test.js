import { describe, it, expect } from 'vitest';
import {
  CLIP_SECONDS,
  AUDIO_EXTENSIONS,
  parseEnvelope,
  pickStart,
  chooseTrack,
  trackTitle,
} from '../electron/bumperMusic.js';
import { isVideoFile } from '../src/shared/parseEpisode.js';

/**
 * Picking fifteen seconds out of a song.
 *
 * The scoring is driven with SYNTHETIC envelopes rather than real mp3s. Real
 * files tell you what the heuristic did to five particular songs; they cannot
 * tell you what it would do to a shape she has not got a file of yet — and the
 * one defect this code has actually had was a shape, not a song.
 */

/**
 * Build an envelope from [seconds, lufs] segments, sampled at 10Hz — the rate
 * ebur128 actually reports at.
 */
function envelope(segments) {
  const points = [];
  let t = 0;
  for (const [seconds, lufs] of segments) {
    for (let i = 0; i < seconds * 10; i += 1) {
      points.push({ t: Number(t.toFixed(1)), lufs });
      t += 0.1;
    }
  }
  return points;
}

describe('reading ebur128', () => {
  /**
   * The real line, verbatim from a run against her folder. A TARGET field sits
   * between the timestamp and the loudness, so the obvious adjacent-token
   * regex matches nothing — and "no output" is indistinguishable from the
   * filter being missing, which is where the time goes.
   */
  const REAL = '[Parsed_ebur128_0 @ 0000021512026880] t: 39.899977  TARGET:-23 LUFS'
    + '    M: -12.2 S: -12.4     I: -13.1 LUFS       LRA:   2.0 LU';

  it('reads a timestamp and a momentary loudness past the TARGET field', () => {
    expect(parseEnvelope(REAL)).toEqual([{ t: 39.899977, lufs: -12.2 }]);
  });

  it('reads negative and positive loudness alike', () => {
    const line = '[Parsed_ebur128_0 @ x] t: 1.0  TARGET:-23 LUFS    M: -70.0 S: -1.0';
    expect(parseEnvelope(line)[0].lufs).toBe(-70);
  });

  /**
   * What the DEFAULT log level produces. Without -loglevel verbose the filter
   * prints only this, and an empty envelope must stay empty rather than
   * becoming a confident zero.
   */
  it('returns nothing for the summary-only output of a default-loglevel run', () => {
    expect(parseEnvelope('[Parsed_ebur128_0 @ 0x1] Summary:\n\n  Integrated loudness:')).toEqual([]);
  });
});

describe('choosing where to start', () => {
  it('starts at the top of anything shorter than the bumper', () => {
    // She may drop stings in this folder. A negative window must never be
    // computable, and the card simply runs on after a short cut ends.
    expect(pickStart(envelope([[8, -14]]))).toBe(0);
    expect(pickStart(envelope([[CLIP_SECONDS, -14]]))).toBe(0);
  });

  it('takes the loud even stretch over a quiet one', () => {
    const start = pickStart(envelope([[40, -30], [40, -11]]));
    expect(start).toBeGreaterThanOrEqual(38);
  });

  it('refuses a window that is mostly silence, however loud the rest is', () => {
    // 20s of near-silence then a loud tail. A window straddling the join
    // averages well and would sound broken.
    const start = pickStart(envelope([[20, -68], [40, -12]]));
    expect(start).toBeGreaterThanOrEqual(20);
  });

  /**
   * THE ONE THAT WAS MEASURED WRONG.
   *
   * A track that opens from near-silence hands the onset term an enormous
   * bonus — the "rise" it detects is just the file starting. Unclamped, that
   * beat the actual body of the song every time: Vibe-Units in her folder
   * scored onset +44.0 against a typical +8 and picked 0.6s.
   *
   * The clamp is what makes the loud body win. Control, run: raise
   * MAX_ONSET_BONUS to 99 and this returns a start inside the first second.
   */
  it('does not let a quiet opening beat the body of the song', () => {
    const start = pickStart(envelope([[3, -58], [25, -22], [40, -12]]));
    expect(start).toBeGreaterThan(5);
  });

  it('gives a number that can be handed to mpv as a start offset', () => {
    const start = pickStart(envelope([[40, -30], [40, -11]]));
    expect(Number.isFinite(start)).toBe(true);
    expect(start).toBeGreaterThanOrEqual(0);
  });

  it('survives an empty envelope rather than throwing', () => {
    expect(pickStart([])).toBe(0);
  });

  /**
   * The window has to FIT. A start chosen too near the end runs the music out
   * before the card does, and the bumper finishes in silence — which reads as
   * the audio dropping out rather than as a bad choice of start.
   *
   * Her five real tracks all satisfy this today; nothing was making them.
   */
  it('never starts so late that the music runs out before the card does', () => {
    for (const shape of [
      [[30, -40], [30, -10]],            // loudest part is the tail
      [[10, -12], [50, -30], [10, -8]],  // loudest part is the last few seconds
      [[16, -9]],                        // barely longer than the clip
    ]) {
      const points = envelope(shape);
      const duration = points[points.length - 1].t;
      expect(pickStart(points) + CLIP_SECONDS).toBeLessThanOrEqual(duration);
    }
  });
});

describe('dealing a track', () => {
  const TRACKS = ['/m/a.mp3', '/m/b.mp3', '/m/c.mp3'];

  it('never deals the track that just played', () => {
    // Every draw, not one lucky draw: a random pick that happens to miss the
    // last track once proves nothing.
    for (let i = 0; i < 50; i += 1) {
      expect(chooseTrack(TRACKS, '/m/b.mp3', () => i / 50)).not.toBe('/m/b.mp3');
    }
  });

  it('repeats rather than playing nothing when the folder holds one track', () => {
    expect(chooseTrack(['/m/only.mp3'], '/m/only.mp3')).toBe('/m/only.mp3');
  });

  it('deals nothing from an empty folder', () => {
    expect(chooseTrack([], null)).toBe(null);
  });

  it('can reach every track in the folder', () => {
    const seen = new Set();
    for (let i = 0; i < 30; i += 1) seen.add(chooseTrack(TRACKS, null, () => i / 30));
    expect(seen.size).toBe(TRACKS.length);
  });
});

describe('what counts as music', () => {
  /**
   * An .mp3 must never become a programme. The two lists are deliberately
   * separate — parseEpisode's list governs what the library scan turns into a
   * show, and an overlap would put her bumper music in the rotation.
   */
  it('is never treated as a programme by the library scan', () => {
    // Asserted through isVideoFile, the function the scan actually calls,
    // rather than against the extension Set — which is module-private, so
    // importing it yields undefined and the check quietly tests nothing.
    const mistaken = [...AUDIO_EXTENSIONS].filter((ext) => isVideoFile(`track${ext}`));
    expect(mistaken).toEqual([]);
  });

  it('names a track by its filename without the extension', () => {
    expect(trackTitle('C:/m/Dust Devil - D Code.mp3')).toBe('Dust Devil - D Code');
  });
});
