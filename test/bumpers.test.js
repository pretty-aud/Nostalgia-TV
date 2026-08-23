import { describe, it, expect } from 'vitest';
import { buildLibrary, isBumperPath } from '../src/shared/parseEpisode.js';
import { createState, nextBumper } from '../src/shared/scheduler.js';

function mulberry32(seed) {
  let a = seed;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const paths = (...relPaths) => relPaths.map((relPath) => ({ relPath, absPath: `D:/TV/${relPath}` }));
const clips = (n) => Array.from({ length: n }, (_, i) => ({
  relPath: `BUMPERS/clip${i + 1}.mp4`, fileName: `clip${i + 1}.mp4`, name: `clip${i + 1}`,
}));

/** Deal `count` clips, returning the names in order. */
function deal(count, clipList, seed = 11, state = createState('/tv')) {
  const rng = mulberry32(seed);
  const out = [];
  let s = state;
  for (let i = 0; i < count; i += 1) {
    const result = nextBumper(clipList, s, { rng });
    s = result.state;
    out.push(result.bumper ? result.bumper.relPath : null);
  }
  return { order: out, state: s };
}

describe('isBumperPath', () => {
  it('matches the top-level bumpers folder', () => {
    expect(isBumperPath('BUMPERS/sting.mp4')).toBe(true);
    expect(isBumperPath('bumpers/sting.mp4')).toBe(true);
    expect(isBumperPath('Bumper/sting.mp4')).toBe(true);
  });

  it('only matches at the TOP level', () => {
    // A show's own subfolder called bumpers is that show's business.
    expect(isBumperPath('Seinfeld/Bumpers/S01E01.mkv')).toBe(false);
  });

  it('does not match an episode that merely happens to be named bumpers', () => {
    expect(isBumperPath('Seinfeld/bumpers.mkv')).toBe(false);
    expect(isBumperPath('bumpers.mkv')).toBe(false);
  });
});

describe('buildLibrary with a BUMPERS folder', () => {
  it('keeps bumpers out of the shows entirely', () => {
    // The failure this guards: BUMPERS becomes a "show" and takes its turn in
    // the rotation, so the channel plays six stings in a row as an episode.
    const { shows, bumpers } = buildLibrary(paths(
      'Seinfeld/S01E01.mkv',
      'BUMPERS/sting-a.mp4',
      'BUMPERS/sting-b.mp4',
    ), { rootName: 'TV' });

    expect(shows.map((s) => s.name)).toEqual(['Seinfeld']);
    expect(shows.some((s) => /bumper/i.test(s.name))).toBe(false);
    expect(bumpers).toHaveLength(2);
  });

  it('does not count bumpers as episodes', () => {
    const { shows } = buildLibrary(paths(
      'Seinfeld/S01E01.mkv',
      'BUMPERS/a.mp4', 'BUMPERS/b.mp4', 'BUMPERS/c.mp4',
    ), { rootName: 'TV' });
    expect(shows.reduce((n, s) => n + s.episodes.length, 0)).toBe(1);
  });

  it('returns an empty list when there is no bumpers folder', () => {
    const { bumpers } = buildLibrary(paths('Seinfeld/S01E01.mkv'), { rootName: 'TV' });
    expect(bumpers).toEqual([]);
  });

  it('still treats a show subfolder named bumpers as that show', () => {
    const { shows, bumpers } = buildLibrary(
      paths('Seinfeld/Bumpers/S01E01.mkv'),
      { rootName: 'TV' },
    );
    expect(bumpers).toEqual([]);
    expect(shows[0].name).toBe('Seinfeld');
  });
});

describe('nextBumper', () => {
  it('plays every clip once before repeating any', () => {
    const list = clips(5);
    const { order } = deal(5, list);
    expect(new Set(order).size).toBe(5);
  });

  it('reshuffles for the next round instead of repeating the same order', () => {
    const list = clips(6);
    const { order } = deal(12, list);
    const first = order.slice(0, 6);
    const second = order.slice(6);
    expect(new Set(second).size).toBe(6);        // still complete
    expect(second).not.toEqual(first);           // but not the same order
  });

  it('never plays the same clip twice in a row across a deck boundary', () => {
    // The one repeat a shuffle exists to prevent, and the most noticeable.
    for (let seed = 1; seed <= 40; seed += 1) {
      const { order } = deal(24, clips(4), seed);
      for (let i = 1; i < order.length; i += 1) {
        expect(order[i]).not.toBe(order[i - 1]);
      }
    }
  });

  it('returns null when there are no clips, rather than stalling', () => {
    const result = nextBumper([], createState('/tv'), { rng: mulberry32(1) });
    expect(result.bumper).toBeNull();
  });

  it('copes with a single clip', () => {
    const { order } = deal(3, clips(1));
    expect(order).toEqual(['BUMPERS/clip1.mp4', 'BUMPERS/clip1.mp4', 'BUMPERS/clip1.mp4']);
  });

  it('drops clips that no longer exist from a saved deck', () => {
    // A deck persisted before a clip was deleted must not hand the player a
    // path that is no longer on disk.
    const state = { ...createState('/tv'), bumperDeck: ['BUMPERS/gone.mp4', 'BUMPERS/clip2.mp4'] };
    const result = nextBumper(clips(3), state, { rng: mulberry32(2) });
    expect(result.bumper.relPath).toBe('BUMPERS/clip2.mp4');
  });

  it('records what it dealt so the deck survives a restart', () => {
    const list = clips(4);
    const result = nextBumper(list, createState('/tv'), { rng: mulberry32(9) });
    expect(result.state.lastBumperRelPath).toBe(result.bumper.relPath);
    expect(result.state.bumperDeck).toHaveLength(3);
  });
});
