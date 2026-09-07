import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_SETTINGS, openingScheduleId, applySettings, createState,
} from '../src/shared/scheduler.js';

/**
 * WHICH SCHEDULE THE CHANNEL OPENS ON.
 *
 * Two settings decide it. activeScheduleId is what is in force right now and is
 * written whenever she changes it; rememberLastSchedule decides whether opening
 * the app leaves that alone or replaces it with defaultScheduleId.
 *
 * The rule itself lives in boot(), which cannot be imported — it reaches for
 * window and the DOM. So the DEFAULTS are asserted here, and the rule is
 * asserted against boot's source text. That is weaker than running it and is
 * stated plainly rather than dressed up: it catches the rule being deleted or
 * inverted, not every way it could be subtly wrong.
 */
const JS = readFileSync(new URL('../src/renderer/index.js', import.meta.url), 'utf8');

describe('the defaults for opening on a schedule', () => {
  /**
   * TRUE, and this is the one that matters. The app has always carried on with
   * whatever was last in force, because activeScheduleId simply persisted. A
   * default of false would silently change the behaviour of every existing
   * install on the first launch after this ships — a new setting must not do
   * that to somebody's channel.
   */
  it('remembers the last schedule, which is what the app already did', () => {
    expect(DEFAULT_SETTINGS.rememberLastSchedule).toBe(true);
  });

  it('has no default schedule until one is chosen', () => {
    expect(DEFAULT_SETTINGS.defaultScheduleId).toBe(null);
  });

  /**
   * FLAT keys, like every other per-feature setting. boot() merges saved
   * settings exactly one level deep, so anything nested under an object comes
   * back missing its fields when it was written before they existed.
   */
  it('keeps both keys flat, not nested', () => {
    const source = readFileSync(new URL('../src/shared/scheduler.js', import.meta.url), 'utf8');
    expect(source).toMatch(/^\s*rememberLastSchedule: true,$/m);
    expect(source).toMatch(/^\s*defaultScheduleId: null,$/m);
  });
});

/**
 * The three interstitial sections are one now. They are one subject — what the
 * channel does in the gap between programmes — and splitting them meant
 * deciding which of three places a setting lived in, where the honest answer
 * was usually "any of them".
 */
describe('the settings rail', () => {
  const HTML = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
  const heads = [...HTML.matchAll(/class="setgroup__head[^"]*">([^<]+)</g)].map((m) => m[1].trim());

  it('has one heading for everything between programmes', () => {
    expect(heads.filter((h) => /^(Bumpers|Promos|Up next)$/.test(h))).toEqual(['Bumpers']);
  });

  it('keeps the old names as sub-headings inside it, not as rail entries', () => {
    // The rail is built from .setgroup__head only, so an h4 is invisible to it
    // — which is what lets the three keep their names without three entries.
    for (const name of ['Up next', 'Promos']) {
      expect(HTML).toContain(`<h4 class="setsub">${name}</h4>`);
    }
  });

  it('gives schedules a heading of their own', () => {
    expect(heads).toContain('Schedules');
  });

  it('moved the editor button there rather than duplicating it', () => {
    expect((HTML.match(/id="btnOpenSchedule"/g) || []).length).toBe(1);
  });
});

/**
 * Every dropdown in Settings has to look like the others.
 *
 * .select is what makes a <select> match the panel; without it Chromium draws
 * the platform control, which on Windows is a light grey box in a dark sheet.
 * Two shipped that way — the box office's Backdrop and this schedule menu —
 * and neither was noticed until a screenshot put them beside a styled one,
 * because nothing about them is broken. They are just wrong.
 */
describe('the dropdowns in settings', () => {
  const HTML = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');

  /**
   * EVERY select in the file, not "every select inside settings".
   *
   * The first version tried to cut the settings body out with a regex and
   * matched a fragment containing no selects at all — a lazy `[\s\S]*?` stops
   * at the first nested closing div, not the matching one. It passed with the
   * bug still in the markup. HTML is not regular and this test is not going to
   * pretend otherwise: every select in the app should carry the class, so ask
   * that instead. Comments are stripped, or a <select> mentioned in prose
   * counts as a control.
   */
  it('are all styled, none left as the platform control', () => {
    const markup = HTML.replace(/<!--[\s\S]*?-->/g, '');
    const bare = [...markup.matchAll(/<select(?![^>]*class="select")[^>]*>/g)].map((m) => m[0]);
    expect(bare, 'these selects will draw as light grey boxes in a dark sheet').toEqual([]);
  });
});

/**
 * WHICH SCHEDULE, as a decision rather than as source text.
 *
 * The first version of these greped boot() for the shape of an `if`. That
 * catches the rule being deleted and nothing else — it passed while the rule
 * was in the wrong place entirely, setting the schedule before the library
 * loaded, where nothing rebuilt the queue. The decision lives in the scheduler
 * now precisely so it can be asked rather than read.
 */
describe('choosing the schedule to open on', () => {
  const SCHEDULES = [{ id: 'sat', name: 'Saturday' }, { id: 'late', name: 'Late night' }];

  it('carries on with whatever was in force, when remembering', () => {
    expect(openingScheduleId({
      rememberLastSchedule: true, activeScheduleId: 'late', defaultScheduleId: 'sat',
      schedules: SCHEDULES,
    })).toBe('late');
  });

  it('takes the default instead, when not', () => {
    expect(openingScheduleId({
      rememberLastSchedule: false, activeScheduleId: 'late', defaultScheduleId: 'sat',
      schedules: SCHEDULES,
    })).toBe('sat');
  });

  it('falls back to the shuffle when the default names a deleted schedule', () => {
    // A saved id outlives the schedule it names. Pointed at one that is gone,
    // the channel would be filtered to a set of shows that no longer exists.
    expect(openingScheduleId({
      rememberLastSchedule: false, activeScheduleId: 'late', defaultScheduleId: 'gone',
      schedules: SCHEDULES,
    })).toBe(null);
  });

  it('opens on the shuffle when no default was ever chosen', () => {
    expect(openingScheduleId({
      rememberLastSchedule: false, activeScheduleId: 'late', schedules: SCHEDULES,
    })).toBe(null);
  });

  it('remembers by default, which is what the app already did', () => {
    // No key at all — an older settings file. It must not start overriding.
    expect(openingScheduleId({ activeScheduleId: 'late' })).toBe('late');
  });
});

/**
 * AND IT HAS TO REACH THE QUEUE.
 *
 * This is the one that matters, and the one the source-grep version could not
 * ask. The original rule set the schedule before loadLibrary, on the belief
 * that loading would build a queue from it — loadLibrary only PRUNES the saved
 * queue and never rebuilds it. So the setting changed, the sidebar showed the
 * default, and the channel went on playing last session's running order until
 * the old queue drained: right everywhere except in what actually played.
 */
describe('applying it', () => {
  const shows = ['alpha', 'beta', 'gamma'].map((id) => ({
    id,
    name: id,
    episodes: Array.from({ length: 4 }, (_, i) => ({
      relPath: `${id}/S01E0${i + 1}.mkv`, showId: id, showName: id, season: 1, episode: i + 1,
    })),
  }));

  /**
   * The settings go in as the PATCH, not onto the state.
   *
   * applySettings rebuilds only when a reshape key CHANGED against the state it
   * was given — so putting them on the state and passing an empty patch changes
   * nothing, builds nothing, and hands back the empty queue createState made.
   * Which is exactly what the first version of this test did, and it read as
   * the code failing rather than the fixture never starting.
   */
  const withQueue = (settings) => applySettings(
    shows, createState('D:/TV'), settings, { rng: () => 0.42 },
  );

  it('discards a queue built from the schedule that is being left behind', () => {
    const schedules = [{ id: 'only-alpha', name: 'Alpha', items: ['alpha'] }];
    // A session that ended on a schedule limited to one show.
    const ended = withQueue({ schedules, activeScheduleId: 'only-alpha' });
    expect(ended.queue.length).toBeGreaterThan(0);
    expect([...new Set(ended.queue.map((q) => q.showId))]).toEqual(['alpha']);

    // Opening with the carry-on off and no default: back to everything.
    const opened = applySettings(shows, ended, {
      activeScheduleId: openingScheduleId({
        ...ended.settings, rememberLastSchedule: false, defaultScheduleId: null,
      }),
      marathonShowId: null,
    }, { rng: () => 0.42 });

    expect(new Set(opened.queue.map((q) => q.showId)).size).toBeGreaterThan(1);
  });

  /**
   * A marathon overrides the rotation entirely, so one left running from last
   * session would beat the default and make "always start on this" untrue in
   * the case that looks most like a bug.
   */
  it('clears a marathon left running from the last session', () => {
    const ended = withQueue({ marathonShowId: 'beta' });
    expect([...new Set(ended.queue.map((q) => q.showId))]).toEqual(['beta']);

    const opened = applySettings(shows, ended, {
      activeScheduleId: null, marathonShowId: null,
    }, { rng: () => 0.42 });
    expect(opened.settings.marathonShowId).toBe(null);
    expect(new Set(opened.queue.map((q) => q.showId)).size).toBeGreaterThan(1);
  });
});
