import { describe, it, expect } from 'vitest';
import {
  createState,
  refillQueue,
  peek,
  advance,
  previous,
  nudgeCursor,
  resetProgress,
  reconcileCursors,
  skipCurrent,
  blockAhead,
  applySettings,
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

/** A state with a committed queue, the way the app always has one. */
function seeded(shows, patch = {}, seed = 7) {
  const rng = mulberry32(seed);
  const state = { ...createState('/tv'), ...patch };
  // Deck by default here: these suites reason about ONE queued episode per
  // show, and under blocks a show holds several consecutive slots — which
  // changes what "dropped from the queue" and "put back" mean.
  state.settings = { ...state.settings, mode: 'deck', ...(patch.settings || {}) };
  state.cursors = Object.fromEntries(shows.map((s) => [s.id, { index: 0, lastRelPath: null }]));
  const filled = refillQueue(shows, state, { rng });
  return { ...state, queue: filled.queue, deck: filled.deck };
}

describe('marathon mode', () => {
  it('plays only the chosen show', () => {
    const shows = makeShows(4, 6);
    let state = seeded(shows);
    state = applySettings(shows, state, { marathonShowId: 'show-2' }, { rng: mulberry32(3) });

    const upcoming = peek(shows, state, 6);
    expect(upcoming).toHaveLength(6);
    expect(new Set(upcoming.map((i) => i.showId))).toEqual(new Set(['show-2']));
  });

  it('keeps that show in episode order', () => {
    const shows = makeShows(3, 5);
    let state = seeded(shows);
    state = applySettings(shows, state, { marathonShowId: 'show-1' }, { rng: mulberry32(3) });
    expect(peek(shows, state, 5).map((i) => i.episodeIndex)).toEqual([0, 1, 2, 3, 4]);
  });

  it('takes effect immediately rather than a dozen episodes later', () => {
    // The queue is committed ahead, so without rebuilding it the old mixed
    // rotation would keep playing and the button would look broken.
    const shows = makeShows(4, 6);
    let state = seeded(shows);
    const before = peek(shows, state, 1)[0];
    state = applySettings(shows, state, { marathonShowId: 'show-3' }, { rng: mulberry32(3) });
    const after = peek(shows, state, 1)[0];

    expect(before.showId).not.toBe('show-3'); // control: it was mixed before
    expect(after.showId).toBe('show-3');
  });

  it('overrides a show having been switched off', () => {
    const shows = makeShows(3, 4);
    let state = seeded(shows);
    state = applySettings(shows, state, { disabledShows: ['show-1'] }, { rng: mulberry32(3) });
    state = applySettings(shows, state, { marathonShowId: 'show-1' }, { rng: mulberry32(3) });

    // The alternative is an empty channel, which is never the intent.
    expect(peek(shows, state, 3).map((i) => i.showId)).toEqual(['show-1', 'show-1', 'show-1']);
  });

  it('returns to the full rotation when switched off', () => {
    const shows = makeShows(4, 6);
    let state = seeded(shows);
    state = applySettings(shows, state, { marathonShowId: 'show-0' }, { rng: mulberry32(3) });
    state = applySettings(shows, state, { marathonShowId: null }, { rng: mulberry32(3) });

    expect(new Set(peek(shows, state, 8).map((i) => i.showId)).size).toBeGreaterThan(1);
  });
});

describe('resetProgress', () => {
  it('sends one show back to its first episode', () => {
    const shows = makeShows(3, 8);
    let state = seeded(shows);
    for (let i = 0; i < 6; i += 1) state = advance(shows, state, { rng: mulberry32(5) }).state;

    const before = state.cursors['show-1'].index;
    expect(before).toBeGreaterThan(0); // control: it had actually moved

    state = resetProgress(shows, state, 'show-1', { rng: mulberry32(5) });
    expect(state.cursors['show-1'].index).toBe(0);
  });

  it('leaves the other shows where they were', () => {
    const shows = makeShows(3, 8);
    let state = seeded(shows);
    for (let i = 0; i < 6; i += 1) state = advance(shows, state, { rng: mulberry32(5) }).state;

    const untouched = state.cursors['show-2'].index;
    state = resetProgress(shows, state, 'show-1', { rng: mulberry32(5) });
    expect(state.cursors['show-2'].index).toBe(untouched);
  });

  it('drops the reset show from the committed queue', () => {
    // Otherwise the queue still holds the episodes we just rewound past, and
    // the show carries on from where it was for another full round.
    const shows = makeShows(3, 8);
    let state = seeded(shows);
    for (let i = 0; i < 5; i += 1) state = advance(shows, state, { rng: mulberry32(5) }).state;

    state = resetProgress(shows, state, 'show-0', { rng: mulberry32(5) });
    const queuedForShow0 = state.queue.filter((item) => item.showId === 'show-0');
    for (const item of queuedForShow0) expect(item.episodeIndex).toBeLessThan(3);
  });

  it('resets every show when given no show id', () => {
    const shows = makeShows(3, 8);
    let state = seeded(shows);
    for (let i = 0; i < 9; i += 1) state = advance(shows, state, { rng: mulberry32(5) }).state;

    state = resetProgress(shows, state, null, { rng: mulberry32(5) });
    for (const show of shows) expect(state.cursors[show.id].index).toBe(0);
    expect(state.history).toEqual([]);
    expect(peek(shows, state, 3).every((i) => i.episodeIndex === 0)).toBe(true);
  });

  it('clears a saved mid-episode position inside the show it reset', () => {
    const shows = makeShows(2, 4);
    let state = seeded(shows);
    state = { ...state, resume: { relPath: shows[0].episodes[2].relPath, position: 400 } };

    state = resetProgress(shows, state, 'show-0', { rng: mulberry32(5) });
    expect(state.resume).toBeNull();
  });

  it('leaves a resume position belonging to a different show alone', () => {
    const shows = makeShows(2, 4);
    let state = seeded(shows);
    const resume = { relPath: shows[1].episodes[1].relPath, position: 120 };
    state = { ...state, resume };

    state = resetProgress(shows, state, 'show-0', { rng: mulberry32(5) });
    expect(state.resume).toEqual(resume);
  });

  it('ignores an unknown show id rather than wiping everything', () => {
    const shows = makeShows(2, 4);
    let state = seeded(shows);
    for (let i = 0; i < 3; i += 1) state = advance(shows, state, { rng: mulberry32(5) }).state;
    const before = JSON.stringify(state.cursors);

    state = resetProgress(shows, state, 'no-such-show', { rng: mulberry32(5) });
    expect(JSON.stringify(state.cursors)).toBe(before);
  });
});

describe('nudgeCursor', () => {
  it('passes over a show\'s next episode', () => {
    const shows = makeShows(3, 10);
    let state = seeded(shows);
    expect(state.cursors['show-0'].index).toBe(0);

    state = nudgeCursor(shows, state, 'show-0', 1, { rng: mulberry32(2) });
    expect(state.cursors['show-0'].index).toBe(1);
  });

  it('re-deals the queue so the change is visible immediately', () => {
    const shows = makeShows(3, 10);
    let state = seeded(shows);
    state = nudgeCursor(shows, state, 'show-0', 3, { rng: mulberry32(2) });

    const queued = state.queue.filter((item) => item.showId === 'show-0');
    expect(queued.length).toBeGreaterThan(0);
    expect(queued[0].episodeIndex).toBe(3);
  });

  it('steps backwards', () => {
    const shows = makeShows(2, 10);
    let state = seeded(shows);
    state = nudgeCursor(shows, state, 'show-0', 5, { rng: mulberry32(2) });
    state = nudgeCursor(shows, state, 'show-0', -2, { rng: mulberry32(2) });
    expect(state.cursors['show-0'].index).toBe(3);
  });

  it('wraps from the pilot back to the finale instead of sticking at zero', () => {
    const shows = makeShows(2, 10);
    let state = seeded(shows);
    state = nudgeCursor(shows, state, 'show-0', -1, { rng: mulberry32(2) });
    expect(state.cursors['show-0'].index).toBe(9);
  });

  it('wraps past the finale back to the pilot', () => {
    const shows = makeShows(2, 6);
    let state = seeded(shows);
    state = nudgeCursor(shows, state, 'show-0', 6, { rng: mulberry32(2) });
    expect(state.cursors['show-0'].index).toBe(0);
  });

  it('records a lastRelPath a rescan can re-anchor from', () => {
    // reconcileCursors resumes at found + 1, so the stored path must be the
    // episode BEFORE the new position or a rescan shifts the show by one.
    const shows = makeShows(2, 8);
    let state = seeded(shows);
    state = nudgeCursor(shows, state, 'show-0', 4, { rng: mulberry32(2) });
    expect(state.cursors['show-0'].lastRelPath).toBe(shows[0].episodes[3].relPath);
  });

  it('leaves other shows untouched', () => {
    const shows = makeShows(3, 8);
    let state = seeded(shows);
    const before = state.cursors['show-2'].index;
    state = nudgeCursor(shows, state, 'show-0', 2, { rng: mulberry32(2) });
    expect(state.cursors['show-2'].index).toBe(before);
  });
});

describe('previous', () => {
  it('puts the episode that just played back at the front', () => {
    const shows = makeShows(3, 8);
    let state = seeded(shows);
    const first = advance(shows, state, { rng: mulberry32(4) });
    state = first.state;
    const second = advance(shows, state, { rng: mulberry32(4) });
    state = second.state;

    state = previous(shows, state);
    const head = peek(shows, state, 1)[0];
    expect(head.relPath).toBe(second.item.relPath);
  });

  it('rewinds the cursor of the show it stepped back into, not the current one', () => {
    // Every rotation mode except marathon means the previous episode belonged
    // to a different show, so a cursor walk would rewind the wrong one.
    const shows = makeShows(3, 8);
    let state = seeded(shows);
    const played = advance(shows, state, { rng: mulberry32(4) });
    state = played.state;
    expect(state.cursors[played.item.showId].index).toBe(played.item.episodeIndex + 1);

    state = previous(shows, state);
    expect(state.cursors[played.item.showId].index).toBe(played.item.episodeIndex);
  });

  it('does nothing when nothing has played yet', () => {
    const shows = makeShows(2, 4);
    const state = seeded(shows);
    expect(previous(shows, state)).toBe(state);
  });

  it('walks back more than one step', () => {
    const shows = makeShows(3, 8);
    let state = seeded(shows);
    const played = [];
    for (let i = 0; i < 3; i += 1) {
      const result = advance(shows, state, { rng: mulberry32(4) });
      state = result.state;
      played.push(result.item.relPath);
    }
    state = previous(shows, state);
    state = previous(shows, state);
    expect(peek(shows, state, 1)[0].relPath).toBe(played[1]);
  });
});

describe('reconcileCursors preserves progress across an incomplete scan', () => {
  it('keeps the place of a show that this scan did not find', () => {
    // The scanner skips folders it cannot read, so a drive still spinning up or
    // a sleeping network share silently drops shows from the result. Rebuilding
    // cursors from only what was scanned erased their progress — and
    // loadLibrary persists straight afterwards, making it permanent.
    const shows = makeShows(3, 8);
    const state = {
      ...createState('/tv'),
      cursors: {
        'show-0': { index: 5, lastRelPath: shows[0].episodes[4].relPath },
        'show-1': { index: 3, lastRelPath: shows[1].episodes[2].relPath },
        'show-2': { index: 7, lastRelPath: shows[2].episodes[6].relPath },
      },
    };

    // show-1 was unreadable this time round.
    const scanned = [shows[0], shows[2]];
    const cursors = reconcileCursors(scanned, state);

    expect(cursors['show-1']).toEqual({ index: 3, lastRelPath: shows[1].episodes[2].relPath });
    expect(cursors['show-0'].index).toBe(5);
    expect(cursors['show-2'].index).toBe(7);
  });

  it('still re-anchors the shows it DID find', () => {
    // The preservation must not come at the cost of the re-anchoring this
    // function exists to do.
    const shows = makeShows(2, 8);
    const state = {
      ...createState('/tv'),
      cursors: { 'show-0': { index: 99, lastRelPath: shows[0].episodes[2].relPath } },
    };
    const cursors = reconcileCursors(shows, state);
    expect(cursors['show-0'].index).toBe(3); // resumes AFTER the last one played
  });

  it('gives a genuinely new show a fresh cursor', () => {
    const shows = makeShows(2, 5);
    const cursors = reconcileCursors(shows, { ...createState('/tv'), cursors: {} });
    expect(cursors['show-0']).toEqual({ index: 0, lastRelPath: null });
  });

  it('survives a scan that returned nothing at all', () => {
    // The worst case: the whole drive was unavailable for one launch.
    const shows = makeShows(3, 6);
    const state = {
      ...createState('/tv'),
      cursors: { 'show-0': { index: 4, lastRelPath: shows[0].episodes[3].relPath } },
    };
    expect(reconcileCursors([], state)['show-0'].index).toBe(4);
  });
});

describe('reconcileCursors recovers from history', () => {
  const withHistory = (shows, cursors, history) => ({ ...createState('/tv'), cursors, history });

  it('puts back a show whose cursor was zeroed but which history says played', () => {
    // The exact shape an earlier bug left behind: index 0, no anchor, while
    // history still records two episodes played. Restarting a series someone is
    // part-way through is the worst possible reading of that.
    const shows = makeShows(2, 10);
    const state = withHistory(shows,
      { 'show-0': { index: 0, lastRelPath: null } },
      [{ showId: 'show-0', episodeIndex: 1, relPath: shows[0].episodes[1].relPath }]);

    expect(reconcileCursors(shows, state)['show-0'].index).toBe(2);
  });

  it('re-anchors by PATH, so it survives the library being re-sorted', () => {
    // Adding episodes moves everything: the index in history is stale, the path
    // is not. Here the remembered episode now sits at position 5.
    const shows = makeShows(1, 10);
    const state = withHistory(shows,
      { 'show-0': { index: 0, lastRelPath: null } },
      [{ showId: 'show-0', episodeIndex: 99, relPath: shows[0].episodes[5].relPath }]);

    expect(reconcileCursors(shows, state)['show-0'].index).toBe(6);
  });

  it('leaves a healthy cursor alone', () => {
    // History must never drag a show BACKWARDS from where its cursor already is.
    const shows = makeShows(1, 10);
    const state = withHistory(shows,
      { 'show-0': { index: 7, lastRelPath: shows[0].episodes[6].relPath } },
      [{ showId: 'show-0', episodeIndex: 1, relPath: shows[0].episodes[1].relPath }]);

    expect(reconcileCursors(shows, state)['show-0'].index).toBe(7);
  });

  it('still starts a genuinely new show at zero', () => {
    const shows = makeShows(2, 6);
    const cursors = reconcileCursors(shows, withHistory(shows, {}, []));
    expect(cursors['show-0']).toEqual({ index: 0, lastRelPath: null });
  });

  it('uses the MOST RECENT history entry for a show', () => {
    // History is newest-first; taking the oldest would rewind the show.
    const shows = makeShows(1, 10);
    const state = withHistory(shows, {}, [
      { showId: 'show-0', episodeIndex: 4, relPath: shows[0].episodes[4].relPath },
      { showId: 'show-0', episodeIndex: 0, relPath: shows[0].episodes[0].relPath },
    ]);
    expect(reconcileCursors(shows, state)['show-0'].index).toBe(5);
  });

  it('ignores history for a show that is not in this scan', () => {
    const shows = makeShows(1, 5);
    const state = withHistory(shows, {}, [{ showId: 'gone', episodeIndex: 3, relPath: 'Gone/x.mp4' }]);
    expect(reconcileCursors(shows, state)['gone']).toBeUndefined();
  });
});


describe('skipCurrent', () => {
  /** Play one episode for real, so the cursor and history are as the app leaves them. */
  const playOne = (shows, state) => {
    const result = advance(shows, state, { rng: mulberry32(6) });
    return { state: result.state, item: result.item };
  };

  it('counting it leaves the show advanced, so it never returns', () => {
    const shows = makeShows(3, 10);
    let state = seeded(shows);
    const { state: afterPlay, item } = playOne(shows, state);
    const at = afterPlay.cursors[item.showId].index;

    const out = skipCurrent(shows, afterPlay, item, { countIt: true, rng: mulberry32(6) });
    expect(out.state.cursors[item.showId].index).toBe(at);
    expect(out.state.queue.some((q) => q.relPath === item.relPath)).toBe(false);
  });

  it('not counting it puts the show back on that episode', () => {
    const shows = makeShows(3, 10);
    const { state: afterPlay, item } = playOne(shows, seeded(shows));

    const out = skipCurrent(shows, afterPlay, item, { countIt: false, rng: mulberry32(6) });
    expect(out.state.cursors[item.showId].index).toBe(item.episodeIndex);
    // and it is queued again, rather than lost
    expect(out.state.queue.some((q) => q.relPath === item.relPath)).toBe(true);
  });

  it('not counting it also takes the play back out of history', () => {
    // Otherwise history claims an episode was watched that was skipped, and the
    // two records of the same fact disagree.
    const shows = makeShows(2, 8);
    const { state: afterPlay, item } = playOne(shows, seeded(shows));
    expect(afterPlay.history[0].relPath).toBe(item.relPath); // control

    const out = skipCurrent(shows, afterPlay, item, { countIt: false, rng: mulberry32(6) });
    expect(out.state.history.some((h) => h.relPath === item.relPath)).toBe(false);
  });

  it('counting it KEEPS the play in history', () => {
    const shows = makeShows(2, 8);
    const { state: afterPlay, item } = playOne(shows, seeded(shows));
    const out = skipCurrent(shows, afterPlay, item, { countIt: true, rng: mulberry32(6) });
    expect(out.state.history[0].relPath).toBe(item.relPath);
  });

  it('drops the whole block, not just the one episode', () => {
    // In blocks mode the queue holds several of a show in a row. Skipping one
    // only for the next of the same show to start immediately is not skipping.
    const shows = makeShows(4, 12);
    let state = applySettings(shows, seeded(shows), { mode: 'blocks', blockSize: 3 }, { rng: mulberry32(2) });
    const { state: afterPlay, item } = playOne(shows, state);
    expect(blockAhead(afterPlay, item.showId)).toBeGreaterThan(0); // control: block remains

    const out = skipCurrent(shows, afterPlay, item, { countIt: true, rng: mulberry32(2) });
    expect(out.dropped).toBeGreaterThan(0);
    // Whatever plays next is a DIFFERENT show.
    expect(out.state.queue[0].showId).not.toBe(item.showId);
  });

  it('leaves that show\'s episodes further back in the queue alone', () => {
    // Those belong to a later turn; skipping now must not cancel them.
    const shows = makeShows(2, 20);
    let state = applySettings(shows, seeded(shows), { mode: 'blocks', blockSize: 2 }, { rng: mulberry32(8) });
    const { state: afterPlay, item } = playOne(shows, state);

    const out = skipCurrent(shows, afterPlay, item, { countIt: true, rng: mulberry32(8) });
    expect(out.state.queue.some((q) => q.showId === item.showId)).toBe(true);
  });

  it('does nothing without an episode on screen', () => {
    const shows = makeShows(2, 5);
    const state = seeded(shows);
    expect(skipCurrent(shows, state, null, { rng: mulberry32(1) }).state).toBe(state);
  });
});

describe('blockAhead', () => {
  it('counts only the consecutive run at the head', () => {
    const state = { queue: [
      { showId: 'a', episodeIndex: 0 }, { showId: 'a', episodeIndex: 1 },
      { showId: 'b', episodeIndex: 0 }, { showId: 'a', episodeIndex: 2 },
    ] };
    expect(blockAhead(state, 'a')).toBe(2);
    expect(blockAhead(state, 'b')).toBe(0);
  });
});
