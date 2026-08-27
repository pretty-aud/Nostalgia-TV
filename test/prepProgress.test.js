import { describe, it, expect } from 'vitest';
import { preparingCopy, describeRemaining } from '../src/shared/prepProgress.js';

const MINUTES = (n) => n * 60 * 1000;
const FILM = MINUTES(109);          // HellBoy, the file this was written for

describe('what the wait says', () => {
  it('names how far in and how far there is to go', () => {
    const { fraction, text } = preparingCopy(MINUTES(45.8), FILM, 16 * 60);

    expect(fraction).toBeCloseTo(0.42, 2);
    expect(text).toMatch(/^45:48 of 1:49:00/);
    expect(text).toMatch(/about 22 minutes left/);
  });

  it('withholds the estimate until there is enough to estimate FROM', () => {
    // One tick into a forty-minute job the projection is wild, and a confidently
    // wrong number is worse than no number at all.
    const early = preparingCopy(MINUTES(0.2), FILM, 3);

    expect(early.text).not.toMatch(/left/);
    expect(early.text).toMatch(/of 1:49:00/);
  });

  it('withholds it when barely any of the FILE is done, however long it has run', () => {
    // Elapsed time alone is not enough: a job stuck at 0.3% for a minute would
    // otherwise project a confident five hours.
    const stalled = preparingCopy(MINUTES(0.3), FILM, 90);

    expect(stalled.text).not.toMatch(/left/);
  });

  it('survives a file whose duration is unknown', () => {
    // ffprobe does not always report one. The bar cannot mean anything then, so
    // fraction is null and the caller leaves it alone rather than faking motion.
    const { fraction, text } = preparingCopy(MINUTES(12), 0, 300);

    expect(fraction).toBeNull();
    expect(text).toBe('12:00 converted');
  });

  it('cannot report more than finished', () => {
    // ffmpeg's last tick can overshoot the probed duration slightly.
    const { fraction } = preparingCopy(MINUTES(200), FILM, 600);

    expect(fraction).toBe(1);
  });

  it('handles nonsense without throwing', () => {
    expect(preparingCopy(null, null, null).text).toBe('0:00 converted');
    expect(preparingCopy(-5, FILM, -1).fraction).toBe(0);
  });
});

describe('how long is left, in words', () => {
  it('does not invite you to watch it be wrong at the short end', () => {
    expect(describeRemaining(43)).toBe('a minute');
    expect(describeRemaining(89)).toBe('a minute');
  });

  it('counts in minutes through the useful range', () => {
    expect(describeRemaining(MINUTES(22) / 1000)).toBe('22 minutes');
    expect(describeRemaining(MINUTES(59) / 1000)).toBe('59 minutes');
  });

  it('switches to hours when minutes stop being readable', () => {
    expect(describeRemaining(MINUTES(95) / 1000)).toBe('1h 35m');
    expect(describeRemaining(MINUTES(120) / 1000)).toBe('2 hours');
  });

  it('says nothing rather than something silly', () => {
    expect(describeRemaining(0)).toBeNull();
    expect(describeRemaining(-10)).toBeNull();
    expect(describeRemaining(Infinity)).toBeNull();
  });
});
