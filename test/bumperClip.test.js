import { describe, it, expect } from 'vitest';
import {
  seekFor, FRACTION, FLOOR_SECONDS, CAP_SECONDS,
} from '../electron/bumperClip.js';

/**
 * Where the background is taken from.
 *
 * Driven by RUNTIME rather than by files, because the interesting cases are
 * the ones her library has few of — a forty-second promo, a three-hour film —
 * and a rule checked only against whatever happens to be in a fixture folder
 * is a rule checked against nothing in particular.
 */
describe('choosing where to take the background from', () => {
  const MINUTE = 60;

  it('takes a proportion of the runtime for an ordinary episode', () => {
    // 22 minutes -> about 2m40, comfortably past a title sequence.
    expect(seekFor(22 * MINUTE)).toBeCloseTo(22 * MINUTE * FRACTION, 1);
  });

  it('never takes from the first ninety seconds, however short the file', () => {
    // A three-minute promo at 12% would be sampled at 21s, which is its own
    // title card — the floor is what stops the background being a caption.
    expect(seekFor(6 * MINUTE)).toBe(FLOOR_SECONDS);
    expect(seekFor(3 * MINUTE)).toBe(FLOOR_SECONDS);
  });

  /**
   * THE SPOILER GUARD. Without the cap a two-and-a-half hour film is sampled
   * eighteen minutes in, which is past the setup, and a bumper is not the
   * place to find out what happens.
   */
  it('never takes from more than ten minutes in, however long the file', () => {
    expect(seekFor(150 * MINUTE)).toBe(CAP_SECONDS);
    expect(seekFor(90 * MINUTE)).toBe(CAP_SECONDS);
  });

  it('is the cap that bites for a feature film, not the proportion', () => {
    // 100 minutes at 12% is 12 minutes; the answer must be 10, or the cap is
    // decorative.
    expect(100 * MINUTE * FRACTION).toBeGreaterThan(CAP_SECONDS);
    expect(seekFor(100 * MINUTE)).toBe(CAP_SECONDS);
  });

  describe('and leaving room for the clip itself', () => {
    /**
     * A file can be too short for its own rule. Asking for 90 seconds into a
     * 100-second file leaves ten seconds, and asking for a ten-second clip
     * from there leaves none — ffmpeg returns a fragment, or nothing, and the
     * card gets a <video> pointed at an empty file, which renders as a black
     * rectangle with no error.
     */
    it('does not start a ten-second clip closer than ten seconds to the end', () => {
      for (const duration of [100, 95, 60, 30, 12]) {
        expect(seekFor(duration, 10) + 10).toBeLessThanOrEqual(duration);
      }
    });

    it('gives up the rule and takes the middle of a very short file', () => {
      // 30 seconds cannot honour a 90-second floor. The middle is the best
      // available answer for something that has no "past the credits".
      expect(seekFor(30, 10)).toBe(10);
    });

    it('takes the top of anything shorter than the clip', () => {
      expect(seekFor(8, 10)).toBe(0);
      expect(seekFor(10, 10)).toBe(0);
    });
  });

  describe('and refusing to guess', () => {
    it('takes the top when the runtime is unknown', () => {
      // ffprobe fails on a file often enough that this is a real path, and a
      // NaN reaching ffmpeg as -ss makes it read the whole file.
      for (const bad of [undefined, null, 0, -5, NaN, 'twelve']) {
        expect(seekFor(bad)).toBe(0);
      }
    });
  });
});
