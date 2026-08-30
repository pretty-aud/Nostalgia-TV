import { describe, it, expect } from 'vitest';
import {
  createState,
  refillQueue,
  applySettings,
  activeSchedule,
  blockSizeFor,
} from '../src/shared/scheduler.js';

/**
 * Set schedules: a fixed running order instead of a shuffle.
 *
 * The whole feature rides on one idea — a schedule IS the deck, in its own
 * order, refilled from the top when it empties. These tests pin the rules that
 * make that safe to rely on, because every one of them is a way the channel
 * could silently play something other than what the column says.
 */

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

const makeShows = (ids, episodesEach = 20) => ids.map((id) => ({
  id,
  name: id.toUpperCase(),
  episodeCount: episodesEach,
  episodes: Array.from({ length: episodesEach }, (_, e) => ({
    relPath: `${id}/E${e + 1}.mp4`,
    fileName: `E${e + 1}.mp4`,
    showName: id.toUpperCase(),
    season: 1,
    episode: e + 1,
    index: e,
  })),
}));

const SHOWS = makeShows(['bat', 'sup', 'flash']);

function stateWith(settings) {
  const base = createState('X:/lib');
  return { ...base, settings: { ...base.settings, ...settings } };
}

const schedule = (over = {}) => ({
  id: 'sched-1', name: 'Saturday', blockSize: 2, items: ['bat', 'sup'], ...over,
});

/** The show of each queued item, in order. */
const order = (queue) => queue.map((q) => q.showId);

describe('activeSchedule', () => {
  it('resolves the selected schedule', () => {
    const s = { schedules: [schedule()], activeScheduleId: 'sched-1' };
    expect(activeSchedule(s).name).toBe('Saturday');
  });

  it('returns null when nothing is selected', () => {
    expect(activeSchedule({ schedules: [schedule()], activeScheduleId: null })).toBe(null);
  });

  it('returns null for an id that no longer exists', () => {
    // Deleting the active schedule must fall back to shuffling, not empty the
    // channel — the id outlives the object it points at.
    expect(activeSchedule({ schedules: [], activeScheduleId: 'sched-1' })).toBe(null);
  });
});

describe('blockSizeFor', () => {
  it('takes the size from the schedule, not the global setting', () => {
    const s = { blockSize: 2, schedules: [schedule({ blockSize: 5 })], activeScheduleId: 'sched-1' };
    expect(blockSizeFor(s)).toBe(5);
  });

  it('falls back to the global setting with no schedule', () => {
    expect(blockSizeFor({ blockSize: 3, activeScheduleId: null })).toBe(3);
  });

  it('never returns a block size below one', () => {
    // A zero would deal nothing and spin the refill loop against its guard.
    expect(blockSizeFor({ blockSize: 0 })).toBe(1);
    expect(blockSizeFor({ schedules: [schedule({ blockSize: 0 })], activeScheduleId: 'sched-1' })).toBe(1);
  });
});

describe('a schedule deals in its own order', () => {
  it('follows the column top to bottom', () => {
    const state = stateWith({ schedules: [schedule({ blockSize: 1 })], activeScheduleId: 'sched-1' });
    const { queue } = refillQueue(SHOWS, state, { rng: mulberry32(1), target: 4 });
    expect(order(queue)).toEqual(['bat', 'sup', 'bat', 'sup']);
  });

  it('gives a show two blocks when its card appears twice', () => {
    // The point of allowing repeats: bat, sup, bat is a real running order.
    const s = schedule({ blockSize: 1, items: ['bat', 'sup', 'bat'] });
    const state = stateWith({ schedules: [s], activeScheduleId: 'sched-1' });
    const { queue } = refillQueue(SHOWS, state, { rng: mulberry32(1), target: 6 });
    expect(order(queue)).toEqual(['bat', 'sup', 'bat', 'bat', 'sup', 'bat']);
  });

  it('keeps back-to-back cards back to back', () => {
    // The shuffle path deliberately swaps a repeated head away. A schedule must
    // NOT: two of the same card in a row is an instruction, not clumping.
    const s = schedule({ blockSize: 1, items: ['bat', 'bat', 'sup'] });
    const state = stateWith({ schedules: [s], activeScheduleId: 'sched-1' });
    const { queue } = refillQueue(SHOWS, state, { rng: mulberry32(7), target: 3 });
    expect(order(queue)).toEqual(['bat', 'bat', 'sup']);
  });

  it('loops back to the top at the end', () => {
    const state = stateWith({ schedules: [schedule({ blockSize: 1 })], activeScheduleId: 'sched-1' });
    const { queue } = refillQueue(SHOWS, state, { rng: mulberry32(3), target: 8 });
    expect(order(queue)).toEqual(['bat', 'sup', 'bat', 'sup', 'bat', 'sup', 'bat', 'sup']);
  });

  it('advances episodes in broadcast order across the loop', () => {
    // The rotation repeats; the EPISODES must not.
    const state = stateWith({ schedules: [schedule({ blockSize: 1 })], activeScheduleId: 'sched-1' });
    const { queue } = refillQueue(SHOWS, state, { rng: mulberry32(3), target: 6 });
    const bat = queue.filter((q) => q.showId === 'bat').map((q) => q.episodeIndex);
    expect(bat).toEqual([0, 1, 2]);
  });

  it('deals blockSize episodes per card', () => {
    const state = stateWith({ schedules: [schedule({ blockSize: 3 })], activeScheduleId: 'sched-1' });
    const { queue } = refillQueue(SHOWS, state, { rng: mulberry32(1), target: 6 });
    expect(order(queue)).toEqual(['bat', 'bat', 'bat', 'sup', 'sup', 'sup']);
  });
});

describe('what a schedule overrides', () => {
  it('plays a show that is switched off', () => {
    const state = stateWith({
      schedules: [schedule({ blockSize: 1 })],
      activeScheduleId: 'sched-1',
      disabledShows: ['bat'],
    });
    const { queue } = refillQueue(SHOWS, state, { rng: mulberry32(1), target: 4 });
    expect(order(queue)).toContain('bat');
  });

  it('plays a show that is locked', () => {
    const state = stateWith({
      schedules: [schedule({ blockSize: 1 })],
      activeScheduleId: 'sched-1',
      locks: { 'show:bat': { showId: 'sup' } },
    });
    const { queue } = refillQueue(SHOWS, state, { rng: mulberry32(1), target: 4 });
    expect(order(queue)).toContain('bat');
  });

  it('NARROWS to the schedule: a show left off never plays', () => {
    // 'flash' is enabled and unlocked, and must still not appear.
    const state = stateWith({ schedules: [schedule({ blockSize: 1 })], activeScheduleId: 'sched-1' });
    const { queue } = refillQueue(SHOWS, state, { rng: mulberry32(1), target: 8 });
    expect(order(queue)).not.toContain('flash');
  });

  it('outranks random mode', () => {
    // mode is the rotation for when nothing is specified; a schedule specifies.
    const state = stateWith({
      mode: 'random',
      schedules: [schedule({ blockSize: 1 })],
      activeScheduleId: 'sched-1',
    });
    const { queue } = refillQueue(SHOWS, state, { rng: mulberry32(9), target: 6 });
    expect(order(queue)).toEqual(['bat', 'sup', 'bat', 'sup', 'bat', 'sup']);
  });

  it('is itself outranked by a marathon', () => {
    const state = stateWith({
      schedules: [schedule({ blockSize: 1 })],
      activeScheduleId: 'sched-1',
      marathonShowId: 'flash',
    });
    const { queue } = refillQueue(SHOWS, state, { rng: mulberry32(1), target: 4 });
    expect(new Set(order(queue))).toEqual(new Set(['flash']));
  });
});

describe('falling back', () => {
  it('shuffles normally when the active schedule was deleted', () => {
    const state = stateWith({ schedules: [], activeScheduleId: 'sched-1' });
    const { queue } = refillQueue(SHOWS, state, { rng: mulberry32(5), target: 6 });
    // Every show is eligible again, including the one no schedule named.
    expect(queue.length).toBe(6);
    expect(new Set(order(queue)).size).toBeGreaterThan(1);
  });

  it('stops rather than spinning when every scheduled show is gone', () => {
    const state = stateWith({
      schedules: [schedule({ items: ['ghost'] })],
      activeScheduleId: 'sched-1',
    });
    const { queue } = refillQueue(SHOWS, state, { rng: mulberry32(1), target: 6 });
    expect(queue).toEqual([]);
  });
});

describe('applySettings rebuilds when the schedule changes', () => {
  it('takes effect immediately on selection', () => {
    const base = stateWith({ mode: 'blocks', blockSize: 2 });
    const seeded = { ...base, ...refillQueue(SHOWS, base, { rng: mulberry32(2) }) };
    expect(seeded.queue.length).toBeGreaterThan(0);

    const next = applySettings(SHOWS, seeded, {
      schedules: [schedule({ blockSize: 1 })],
      activeScheduleId: 'sched-1',
    }, { rng: mulberry32(2) });

    expect(order(next.queue).slice(0, 4)).toEqual(['bat', 'sup', 'bat', 'sup']);
  });

  it('takes effect when the running schedule is edited', () => {
    // Reordering the column of the schedule already playing has to show up in
    // Up next, or the editor looks broken.
    const s = schedule({ blockSize: 1 });
    const base = stateWith({ schedules: [s], activeScheduleId: 'sched-1' });
    const seeded = { ...base, ...refillQueue(SHOWS, base, { rng: mulberry32(2) }) };

    const next = applySettings(SHOWS, seeded, {
      schedules: [{ ...s, items: ['flash', 'sup'] }],
    }, { rng: mulberry32(2) });

    expect(order(next.queue)[0]).toBe('flash');
  });

  it('returns to a shuffle when the schedule is switched off', () => {
    const base = stateWith({ schedules: [schedule({ blockSize: 1 })], activeScheduleId: 'sched-1' });
    const seeded = { ...base, ...refillQueue(SHOWS, base, { rng: mulberry32(2) }) };
    expect(order(seeded.queue)).not.toContain('flash');

    const next = applySettings(SHOWS, seeded, { activeScheduleId: null }, { rng: mulberry32(2) });
    // 'flash' is back in the running once nothing is narrowing the channel.
    expect(next.queue.length).toBeGreaterThan(0);
    expect(order(next.queue)).toContain('flash');
  });
});
