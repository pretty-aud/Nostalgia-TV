import { describe, it, expect } from 'vitest';
import {
  createState,
  refillQueue,
  peek,
  advance,
  skip,
  playNow,
  applySettings,
  reconcileCursors,
  pruneQueue,
  formatEpisodeLabel,
} from '../src/shared/scheduler.js';

/** Deterministic PRNG so a failure is reproducible rather than "sometimes". */
function mulberry32(seed) {
  let a = seed;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeShows(showCount, episodesEach) {
  return Array.from({ length: showCount }, (_, s) => ({
    id: `show-${s}`,
    name: `Show ${s}`,
    episodeCount: episodesEach,
    episodes: Array.from({ length: episodesEach }, (_, e) => ({
      relPath: `Show ${s}/S01E${String(e + 1).padStart(2, '0')}.mp4`,
      fileName: `S01E${String(e + 1).padStart(2, '0')}.mp4`,
      showName: `Show ${s}`,
      season: 1,
      episode: e + 1,
      title: `Episode ${e + 1}`,
      index: e,
      confidence: 'high',
    })),
  }));
}

/**
 * Seed a state's committed schedule. Carries BOTH queue and deck, because the
 * deck is the round-robin position — a caller that keeps only the queue silently
 * degrades the schedule to pure random.
 */
function primeQueue(shows, state, rng) {
  const filled = refillQueue(shows, state, { rng });
  state.queue = filled.queue;
  state.deck = filled.deck;
  return state;
}

/** Drive the channel for n episodes and return what actually played. */
function runChannel(shows, n, seed = 42, settingsPatch = {}) {
  // Deck unless a test says otherwise: these suites describe the round-robin,
  // one-episode-per-turn rotation, and inheriting the app's default mode made
  // them silently start testing something else the day that default changed.
  settingsPatch = { mode: 'deck', ...settingsPatch };
  const rng = mulberry32(seed);
  let state = createState('/fake');
  state.settings = { ...state.settings, ...settingsPatch };
  primeQueue(shows, state, rng);
  const played = [];
  for (let i = 0; i < n; i += 1) {
    const result = advance(shows, state, { rng });
    state = result.state;
    if (!result.item) break;
    played.push(result.item);
  }
  return { played, state };
}

describe('rule 1: shows appear in a randomised order', () => {
  it('does not simply cycle the shows in library order', () => {
    const shows = makeShows(8, 20);
    const { played } = runChannel(shows, 24);
    const inOrder = played.slice(0, 8).map((p) => p.showId);
    const libraryOrder = shows.slice(0, 8).map((s) => s.id);
    expect(inOrder).not.toEqual(libraryOrder);
  });

  it('produces different orders from different seeds', () => {
    const shows = makeShows(8, 20);
    const a = runChannel(shows, 16, 1).played.map((p) => p.showId).join();
    const b = runChannel(shows, 16, 999).played.map((p) => p.showId).join();
    expect(a).not.toEqual(b);
  });

  it('never plays the same show twice in a row', () => {
    const shows = makeShows(8, 30);
    for (const seed of [1, 2, 3, 42, 777, 12345]) {
      const { played } = runChannel(shows, 120, seed);
      for (let i = 1; i < played.length; i += 1) {
        expect(played[i].showId).not.toBe(played[i - 1].showId);
      }
    }
  });

  it('gives every show a turn before any show comes back around', () => {
    const showCount = 8;
    const shows = makeShows(showCount, 40);
    const { played } = runChannel(shows, showCount * 5);
    for (let w = 0; w < 5; w += 1) {
      const window = played.slice(w * showCount, (w + 1) * showCount);
      expect(new Set(window.map((p) => p.showId)).size).toBe(showCount);
    }
  });
});

describe('rule 2: episodes of a show always advance in order', () => {
  it('plays each show strictly in broadcast order', () => {
    const shows = makeShows(8, 12);
    for (const seed of [1, 7, 42, 2024]) {
      const { played } = runChannel(shows, 96, seed);
      const perShow = new Map();
      for (const item of played) {
        if (!perShow.has(item.showId)) perShow.set(item.showId, []);
        perShow.get(item.showId).push(item.episodeIndex);
      }
      for (const [, indices] of perShow) {
        // Every step forward by exactly one, except a wrap back to 0 at the end.
        for (let i = 1; i < indices.length; i += 1) {
          const expected = indices[i - 1] + 1;
          const wrapped = indices[i] === 0 && indices[i - 1] === 11;
          expect(wrapped || indices[i] === expected).toBe(true);
        }
      }
    }
  });

  it('starts every show at its first episode', () => {
    const shows = makeShows(5, 10);
    const { played } = runChannel(shows, 5);
    for (const item of played) expect(item.episodeIndex).toBe(0);
  });

  it('never skips an episode even across a full library loop', () => {
    const shows = makeShows(3, 4);
    const { played } = runChannel(shows, 24);
    const seq = played.filter((p) => p.showId === 'show-0').map((p) => p.episodeIndex);
    expect(seq).toEqual(expect.arrayContaining([0, 1, 2, 3]));
    expect(seq.slice(0, 4)).toEqual([0, 1, 2, 3]);
  });
});

describe('the bumper must not lie', () => {
  it('plays exactly what peek promised, in that order', () => {
    const shows = makeShows(8, 20);
    const rng = mulberry32(5);
    let state = createState('/fake');
    primeQueue(shows, state, rng);

    for (let round = 0; round < 20; round += 1) {
      const promised = peek(shows, state, 3).map((p) => `${p.showId}:${p.episodeIndex}`);
      const delivered = [];
      for (let i = 0; i < 3; i += 1) {
        const result = advance(shows, state, { rng });
        state = result.state;
        delivered.push(`${result.item.showId}:${result.item.episodeIndex}`);
      }
      expect(delivered).toEqual(promised);
    }
  });

  it('peek returns three items when the library can supply them', () => {
    const shows = makeShows(8, 20);
    const rng = mulberry32(3);
    const state = createState('/fake');
    primeQueue(shows, state, rng);
    expect(peek(shows, state, 3)).toHaveLength(3);
  });

  it('decorates each upcoming item with what the bumper renders', () => {
    const shows = makeShows(4, 5);
    const rng = mulberry32(8);
    const state = createState('/fake');
    primeQueue(shows, state, rng);
    const [next] = peek(shows, state, 1);
    expect(next.showName).toMatch(/^Show \d$/);
    expect(next.label).toBe('S01E01');
    expect(next.title).toBe('Episode 1');
  });
});

describe('block mode', () => {
  it('plays consecutive episodes of one show before moving on', () => {
    const shows = makeShows(6, 20);
    const { played } = runChannel(shows, 36, 11, { mode: 'blocks', blockSize: 2 });
    for (let i = 0; i < played.length - 1; i += 2) {
      expect(played[i].showId).toBe(played[i + 1].showId);
      expect(played[i + 1].episodeIndex).toBe(played[i].episodeIndex + 1);
    }
  });
});

describe('random mode', () => {
  it('still refuses back-to-back repeats and still advances in order', () => {
    const shows = makeShows(6, 20);
    const { played } = runChannel(shows, 60, 21, { mode: 'random' });
    for (let i = 1; i < played.length; i += 1) {
      expect(played[i].showId).not.toBe(played[i - 1].showId);
    }
    const seq = played.filter((p) => p.showId === 'show-1').map((p) => p.episodeIndex);
    for (let i = 1; i < seq.length; i += 1) {
      expect(seq[i]).toBe(seq[i - 1] + 1);
    }
  });
});

describe('exhaustion', () => {
  it('drops a finished show from rotation when looping is off', () => {
    const shows = [
      ...makeShows(1, 2),
      { ...makeShows(2, 10)[1], id: 'long', name: 'Long' },
    ];
    const rng = mulberry32(4);
    let state = createState('/fake');
    state.settings = { ...state.settings, loopWhenExhausted: false };
    primeQueue(shows, state, rng);
    const played = [];
    for (let i = 0; i < 12; i += 1) {
      const result = advance(shows, state, { rng });
      state = result.state;
      if (!result.item) break;
      played.push(result.item);
    }
    expect(played.filter((p) => p.showId === 'show-0')).toHaveLength(2);
  });

  it('wraps a finished show back to episode one when looping is on', () => {
    const shows = makeShows(2, 3);
    const { played } = runChannel(shows, 12, 6, { loopWhenExhausted: true });
    const seq = played.filter((p) => p.showId === 'show-0').map((p) => p.episodeIndex);
    expect(seq.slice(0, 4)).toEqual([0, 1, 2, 0]);
  });

  it('terminates instead of hanging on an empty library', () => {
    const state = createState('/fake');
    expect(refillQueue([], state, { rng: mulberry32(1) }).queue).toEqual([]);
  });

  it('handles a single show without spinning forever', () => {
    const shows = makeShows(1, 3);
    const { queue } = refillQueue(shows, createState('/fake'), { rng: mulberry32(1) });
    expect(queue.length).toBeGreaterThan(0);
    expect(queue.every((q) => q.showId === 'show-0')).toBe(true);
  });
});

describe('disabled shows', () => {
  it('never schedules a show the user switched off', () => {
    const shows = makeShows(5, 10);
    const { played } = runChannel(shows, 40, 9, { disabledShows: ['show-2', 'show-4'] });
    expect(played.some((p) => p.showId === 'show-2')).toBe(false);
    expect(played.some((p) => p.showId === 'show-4')).toBe(false);
  });

  it('rebuilds the committed queue immediately when a show is switched off', () => {
    const shows = makeShows(5, 10);
    const rng = mulberry32(2);
    let state = createState('/fake');
    primeQueue(shows, state, rng);
    state = applySettings(shows, state, { disabledShows: ['show-1'] }, { rng });
    expect(state.queue.some((q) => q.showId === 'show-1')).toBe(false);
  });

  it('rebuilds the queue when the mode changes, so the toggle is not inert', () => {
    const shows = makeShows(5, 10);
    const rng = mulberry32(2);
    let state = createState('/fake');
    primeQueue(shows, state, rng);
    const before = state.queue.map((q) => `${q.showId}:${q.episodeIndex}`).join();
    state = applySettings(shows, state, { mode: 'blocks', blockSize: 3 }, { rng });
    expect(state.queue.map((q) => `${q.showId}:${q.episodeIndex}`).join()).not.toBe(before);
  });

  it('leaves the queue alone for a cosmetic setting change', () => {
    const shows = makeShows(5, 10);
    const rng = mulberry32(2);
    let state = createState('/fake');
    primeQueue(shows, state, rng);
    const before = state.queue.map((q) => q.relPath).join();
    state = applySettings(shows, state, { bumperSeconds: 4 }, { rng });
    expect(state.queue.map((q) => q.relPath).join()).toBe(before);
  });
});

describe('skip and play-now', () => {
  it('skip does not consume progress for the skipped episode', () => {
    const shows = makeShows(4, 10);
    const rng = mulberry32(13);
    let state = createState('/fake');
    primeQueue(shows, state, rng);
    const skipped = peek(shows, state, 1)[0];
    state = skip(shows, state, { rng });
    expect(state.cursors[skipped.showId]).toBeUndefined();
    const nextUp = peek(shows, state, 1)[0];
    expect(`${nextUp.showId}:${nextUp.episodeIndex}`)
      .not.toBe(`${skipped.showId}:${skipped.episodeIndex}`);
  });

  it('play-now jumps the queue without losing what was already committed', () => {
    const shows = makeShows(4, 10);
    const rng = mulberry32(17);
    let state = createState('/fake');
    primeQueue(shows, state, rng);
    const originalNext = state.queue[0];
    state = playNow(shows, state, 'show-3', 5);
    expect(state.queue[0]).toMatchObject({ showId: 'show-3', episodeIndex: 5 });
    expect(state.queue[1]).toEqual(originalNext);
  });
});

describe('history is dated', () => {
  it('stamps every entry with when it played', () => {
    // Without this, "it was showing an older episode when I logged on" cannot
    // be checked against anything: the history is an ordered list with no
    // dates, so a save that never happened looks exactly like one that
    // happened and was later overwritten.
    const shows = makeShows(2, 4);
    let state = createState('/fake');
    state = refillQueue(shows, state, { rng: mulberry32(9) });

    const first = advance(shows, state, { rng: mulberry32(9), now: 1_700_000_000_000 });
    expect(first.state.history[0].at).toBe(1_700_000_000_000);

    const second = advance(shows, first.state, { rng: mulberry32(9), now: 1_700_000_060_000 });
    expect(second.state.history[0].at).toBe(1_700_000_060_000);
    // Newest first, so the pair reads as a timeline rather than needing a sort.
    expect(second.state.history[1].at).toBe(1_700_000_000_000);
  });

  it('falls back to the real clock when no time is injected', () => {
    const shows = makeShows(1, 3);
    let state = createState('/fake');
    state = refillQueue(shows, state, { rng: mulberry32(3) });
    const before = Date.now();
    const { state: after } = advance(shows, state, { rng: mulberry32(3) });
    expect(after.history[0].at).toBeGreaterThanOrEqual(before);
  });
});

describe('surviving a rescan', () => {
  it('re-anchors progress by file path when an episode is inserted', () => {
    const before = makeShows(1, 5);
    const state = createState('/fake');
    state.cursors = {
      'show-0': { index: 3, lastRelPath: 'Show 0/S01E03.mp4' },
    };
    // A new episode appears earlier in the run, shifting every index by one.
    const after = makeShows(1, 5);
    after[0].episodes.unshift({
      relPath: 'Show 0/S01E00-special.mp4',
      fileName: 'S01E00-special.mp4',
      season: 1,
      episode: 0,
      title: 'Special',
      index: 0,
      confidence: 'high',
    });
    after[0].episodes.forEach((ep, i) => { ep.index = i; });

    const cursors = reconcileCursors(after, state);
    // Index alone would have pointed at E03 again; the path re-anchors to E04.
    expect(after[0].episodes[cursors['show-0'].index].relPath).toBe('Show 0/S01E04.mp4');
    expect(before).toBeDefined();
  });

  it('starts a brand new show at episode one', () => {
    const shows = makeShows(2, 5);
    const state = createState('/fake');
    state.cursors = { 'show-0': { index: 2, lastRelPath: 'Show 0/S01E02.mp4' } };
    const cursors = reconcileCursors(shows, state);
    expect(cursors['show-1']).toEqual({ index: 0, lastRelPath: null });
  });

  it('drops queued items whose file has gone away', () => {
    const shows = makeShows(2, 3);
    const queue = [
      { showId: 'show-0', episodeIndex: 0, relPath: 'Show 0/S01E01.mp4' },
      { showId: 'show-9', episodeIndex: 0, relPath: 'Gone/S01E01.mp4' },
      { showId: 'show-1', episodeIndex: 0, relPath: 'Show 1/RENAMED.mp4' },
    ];
    expect(pruneQueue(shows, queue)).toEqual([queue[0]]);
  });

  it('clamps a saved cursor that now runs past the end of the show', () => {
    const shows = makeShows(1, 2);
    const state = createState('/fake');
    state.cursors = { 'show-0': { index: 99, lastRelPath: null } };
    expect(reconcileCursors(shows, state)['show-0'].index).toBe(2);
  });
});

describe('formatEpisodeLabel', () => {
  it('formats a normal episode', () => {
    expect(formatEpisodeLabel({ season: 2, episode: 4 })).toBe('S02E04');
  });
  it('formats a multi-episode span', () => {
    expect(formatEpisodeLabel({ season: 1, episode: 1, episodeEnd: 2 })).toBe('S01E01-E02');
  });
  it('falls back to an episode number with no season', () => {
    expect(formatEpisodeLabel({ season: null, episode: 7 })).toBe('Ep 7');
  });
  it('falls back to the filename when nothing parsed', () => {
    expect(formatEpisodeLabel({ season: null, episode: null, fileName: 'weird.mp4' }))
      .toBe('weird.mp4');
  });
});
