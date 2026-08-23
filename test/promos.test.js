import { describe, it, expect } from 'vitest';
import { buildLibrary, isPromoPath } from '../src/shared/parseEpisode.js';
import {
  createState, nextPromo, shouldPlayPromo, countEpisodeForPromo, applySettings,
} from '../src/shared/scheduler.js';

function mulberry32(seed) {
  let a = seed;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const paths = (...rel) => rel.map((relPath) => ({ relPath, absPath: `D:/TV/${relPath}` }));
const clips = (n, folder = 'PROMOS') => Array.from({ length: n }, (_, i) => ({
  relPath: `${folder}/p${i + 1}.mp4`, fileName: `p${i + 1}.mp4`, name: `p${i + 1}`,
}));

/** Run `count` episode transitions, returning which ones played a promo. */
function runTransitions(count, promos, settings) {
  let state = applySettings([], { ...createState('/tv') }, settings, { rng: mulberry32(1) });
  const played = [];
  for (let i = 0; i < count; i += 1) {
    if (shouldPlayPromo(state, promos)) {
      const picked = nextPromo(promos, state, { rng: mulberry32(i + 2) });
      state = countEpisodeForPromo(picked.state, true);
      played.push(picked.promo ? picked.promo.relPath : null);
    } else {
      state = countEpisodeForPromo(state, false);
      played.push(null);
    }
  }
  return played;
}

describe('isPromoPath', () => {
  it('matches the top-level promos folder', () => {
    expect(isPromoPath('PROMOS/trailer.mp4')).toBe(true);
    expect(isPromoPath('promo/trailer.mp4')).toBe(true);
  });

  it('does not match a show subfolder or a loose file', () => {
    expect(isPromoPath('Seinfeld/Promos/S01E01.mkv')).toBe(false);
    expect(isPromoPath('promos.mp4')).toBe(false);
  });
});

describe('buildLibrary with a PROMOS folder', () => {
  it('keeps promos out of the shows, alongside bumpers', () => {
    const { shows, bumpers, promos } = buildLibrary(paths(
      'Seinfeld/S01E01.mkv',
      'BUMPERS/sting.mp4',
      'PROMOS/coming-up.mp4',
      'PROMOS/trailer.mp4',
    ), { rootName: 'TV' });

    expect(shows.map((s) => s.name)).toEqual(['Seinfeld']);
    expect(bumpers).toHaveLength(1);
    expect(promos).toHaveLength(2);
  });

  it('returns an empty list when there is no promos folder', () => {
    expect(buildLibrary(paths('Seinfeld/S01E01.mkv'), { rootName: 'TV' }).promos).toEqual([]);
  });
});

describe('promo frequency', () => {
  it('plays between every episode by default', () => {
    const played = runTransitions(5, clips(3), {});
    expect(played.every(Boolean)).toBe(true);
  });

  it('plays every Nth episode when asked to', () => {
    // "Every 3" must mean a promo on the 3rd, 6th, 9th — not the 1st.
    const played = runTransitions(9, clips(4), { promoEvery: 3 });
    expect(played.map(Boolean)).toEqual([false, false, true, false, false, true, false, false, true]);
  });

  it('plays nothing when promos are switched off', () => {
    const played = runTransitions(6, clips(3), { promosEnabled: false });
    expect(played.every((p) => p === null)).toBe(true);
  });

  it('plays nothing when the folder is empty, however it is configured', () => {
    expect(runTransitions(4, [], {}).every((p) => p === null)).toBe(true);
  });

  it('does not carry a stale count across being switched off and on', () => {
    // Otherwise turning promos back on fires one immediately, or swallows one.
    let state = applySettings([], createState('/tv'), { promoEvery: 4 }, { rng: mulberry32(1) });
    state = countEpisodeForPromo(state, false);
    state = countEpisodeForPromo(state, false);
    state = applySettings([], state, { promosEnabled: false }, { rng: mulberry32(1) });
    expect(shouldPlayPromo(state, clips(2))).toBe(false);
    state = applySettings([], state, { promosEnabled: true }, { rng: mulberry32(1) });
    // Two episodes counted, gap of four: still not due.
    expect(shouldPlayPromo(state, clips(2))).toBe(false);
  });
});

describe('nextPromo', () => {
  it('plays every promo once before repeating', () => {
    const list = clips(5);
    let state = createState('/tv');
    const seen = [];
    for (let i = 0; i < 5; i += 1) {
      const picked = nextPromo(list, state, { rng: mulberry32(9) });
      state = picked.state;
      seen.push(picked.promo.relPath);
    }
    expect(new Set(seen).size).toBe(5);
  });

  it('keeps its own deck, independent of the bumper deck', () => {
    // Sharing one deck would make promos and bumpers fall into step and arrive
    // as the same pair every time.
    const state = createState('/tv');
    const picked = nextPromo(clips(4), state, { rng: mulberry32(3) });
    expect(picked.state.promoDeck).toHaveLength(3);
    expect(picked.state.bumperDeck).toEqual([]);
  });

  it('never repeats a promo back to back across a deck boundary', () => {
    for (let seed = 1; seed <= 25; seed += 1) {
      let state = createState('/tv');
      const seen = [];
      for (let i = 0; i < 15; i += 1) {
        const picked = nextPromo(clips(3), state, { rng: mulberry32(seed + i) });
        state = picked.state;
        seen.push(picked.promo.relPath);
      }
      for (let i = 1; i < seen.length; i += 1) expect(seen[i]).not.toBe(seen[i - 1]);
    }
  });

  it('returns null when there are no promos, rather than stalling', () => {
    expect(nextPromo([], createState('/tv'), { rng: mulberry32(1) }).promo).toBeNull();
  });
});
