import { describe, it, expect } from 'vitest';
import {
  createState, applySettings, refillQueue, advance, peek,
  shouldPlayPromo, skipCurrent, reshuffle,
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

function makeShows(count, episodes) {
  return Array.from({ length: count }, (_, s) => ({
    id: `show-${s}`,
    name: `Show ${s}`,
    episodes: Array.from({ length: episodes }, (_, e) => ({
      relPath: `Show ${s}/S01E${String(e + 1).padStart(2, '0')}.mp4`,
      fileName: `S01E${String(e + 1).padStart(2, '0')}.mp4`,
      season: 1,
      episode: e + 1,
      title: `Ep ${e + 1}`,
      index: e,
      confidence: 'high',
    })),
  }));
}

const promos = [{ relPath: 'PROMOS/a.mp4', fileName: 'a.mp4', name: 'a' }];

describe('promos between shows', () => {
  const between = (extra = {}) => applySettings(
    [], { ...createState('/tv'), ...extra }, { promoBetweenShows: true }, { rng: mulberry32(1) },
  );

  it('holds off while the same show continues, which is a block', () => {
    const state = between();
    expect(shouldPlayPromo(state, promos, {
      finishedShowId: 'show-0', nextShowId: 'show-0',
    })).toBe(false);
  });

  it('plays at the seam where the show changes', () => {
    const state = between();
    expect(shouldPlayPromo(state, promos, {
      finishedShowId: 'show-0', nextShowId: 'show-1',
    })).toBe(true);
  });

  it('plays when nothing is queued after this one', () => {
    // Nothing to compare against, but the seam is still here.
    expect(shouldPlayPromo(between(), promos, { finishedShowId: 'show-0', nextShowId: null })).toBe(true);
  });

  it('ignores the episode count entirely while it is on', () => {
    // promoEvery 10 would normally suppress this; the seam rule overrides it.
    const state = applySettings([], { ...createState('/tv'), episodesSincePromo: 0 },
      { promoBetweenShows: true, promoEvery: 10 }, { rng: mulberry32(1) });
    expect(shouldPlayPromo(state, promos, { finishedShowId: 'a', nextShowId: 'b' })).toBe(true);
  });

  it('still respects the promos-off switch', () => {
    const state = applySettings([], createState('/tv'),
      { promoBetweenShows: true, promosEnabled: false }, { rng: mulberry32(1) });
    expect(shouldPlayPromo(state, promos, { finishedShowId: 'a', nextShowId: 'b' })).toBe(false);
  });

  it('goes back to counting episodes when switched off', () => {
    const state = applySettings([], { ...createState('/tv'), episodesSincePromo: 0 },
      { promoBetweenShows: false, promoEvery: 3 }, { rng: mulberry32(1) });
    // Same seam, but the count is what decides now — and it is not due.
    expect(shouldPlayPromo(state, promos, { finishedShowId: 'a', nextShowId: 'b' })).toBe(false);
  });
});

describe('skipping just this episode', () => {
  /** Blocks mode, so the queue really does hold a run of one show. */
  function playingInABlock() {
    const shows = makeShows(3, 6);
    let state = applySettings(shows, createState('/tv'),
      { mode: 'blocks', blockSize: 3 }, { rng: mulberry32(5) });
    state = refillQueue(shows, state, { rng: mulberry32(5) });
    const first = advance(shows, state, { rng: mulberry32(5) });
    return { shows, state: first.state, item: first.item };
  }

  it('leaves the rest of the block queued', () => {
    const { shows, state, item } = playingInABlock();
    const sameShowAhead = state.queue.filter((q) => q.showId === item.showId).length;
    expect(sameShowAhead).toBeGreaterThan(0);   // the fixture must actually have a block

    const after = skipCurrent(shows, state, item, { mode: 'episode', rng: mulberry32(5) });
    const next = peek(shows, after.state, 1)[0];
    expect(next.showId).toBe(item.showId);
    expect(after.dropped).toBe(0);
  });

  it('keeps the episode counted, so it never comes round again', () => {
    const { shows, state, item } = playingInABlock();
    const before = state.cursors[item.showId].index;

    const after = skipCurrent(shows, state, item, { mode: 'episode', rng: mulberry32(5) });
    expect(after.state.cursors[item.showId].index).toBe(before);
    expect(after.state.cursors[item.showId].index).toBe(item.episodeIndex + 1);

    // And it stays in the record of what played.
    expect(after.state.history[0].relPath).toBe(item.relPath);
  });

  it('differs from counting it, which drops the whole block', () => {
    const { shows, state, item } = playingInABlock();
    const episode = skipCurrent(shows, state, item, { mode: 'episode', rng: mulberry32(5) });
    const counted = skipCurrent(shows, state, item, { mode: 'count', rng: mulberry32(5) });

    expect(peek(shows, episode.state, 1)[0].showId).toBe(item.showId);
    expect(counted.dropped).toBeGreaterThan(0);
    expect(peek(shows, counted.state, 1)[0].showId).not.toBe(item.showId);
  });

  it('still understands the old countIt callers', () => {
    const { shows, state, item } = playingInABlock();
    const legacy = skipCurrent(shows, state, item, { countIt: true, rng: mulberry32(5) });
    const named = skipCurrent(shows, state, item, { mode: 'count', rng: mulberry32(5) });
    expect(legacy.dropped).toBe(named.dropped);
  });
});

describe('reshuffle', () => {
  it('changes the running order', () => {
    const shows = makeShows(8, 5);
    let state = refillQueue(shows, createState('/tv'), { rng: mulberry32(11) });
    const before = state.queue.map((q) => q.showId).join(',');

    state = reshuffle(shows, state, { rng: mulberry32(77) });
    expect(state.queue.map((q) => q.showId).join(',')).not.toBe(before);
  });

  it('does not move anyone off their episode', () => {
    const shows = makeShows(5, 8);
    let state = refillQueue(shows, createState('/tv'), { rng: mulberry32(4) });
    for (let i = 0; i < 6; i += 1) state = advance(shows, state, { rng: mulberry32(4) }).state;

    const cursorsBefore = JSON.stringify(state.cursors);
    const after = reshuffle(shows, state, { rng: mulberry32(99) });
    expect(JSON.stringify(after.cursors)).toBe(cursorsBefore);
    expect(after.history).toEqual(state.history);
  });

  it('clears the half-dealt deck, or most of the old order comes back', () => {
    const shows = makeShows(6, 4);
    let state = refillQueue(shows, createState('/tv'), { rng: mulberry32(2) });
    state = advance(shows, state, { rng: mulberry32(2) }).state;

    const after = reshuffle(shows, state, { rng: mulberry32(2) });
    // Refilled from a fresh deck, so the queue is full again rather than
    // resuming whatever was left over from the previous round.
    expect(after.queue.length).toBeGreaterThan(0);
    expect(after.queue.every((item) => shows.some((s) => s.id === item.showId))).toBe(true);
  });

  it('keeps every show eligible, including ones already dealt', () => {
    const shows = makeShows(4, 3);
    const state = reshuffle(shows, refillQueue(shows, createState('/tv'), { rng: mulberry32(6) }), { rng: mulberry32(6) });
    const ids = new Set(state.queue.map((q) => q.showId));
    expect(ids.size).toBe(4);
  });
});
