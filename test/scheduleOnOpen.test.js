import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFAULT_SETTINGS } from '../src/shared/scheduler.js';

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

describe('the rule boot applies', () => {
  it('does nothing at all when the last schedule is being remembered', () => {
    // The whole rule is inside a negated check: remembering is the absence of
    // an action, not an action of its own. If this ever becomes an else branch
    // that assigns something, "carry on where I left off" has stopped meaning
    // "leave it alone".
    expect(JS).toMatch(/if \(!state\.settings\.rememberLastSchedule\)/);
  });

  it('checks the default still exists before using it', () => {
    // A saved id outlives the schedule it names — deleting one and reopening
    // must not leave the channel pointed at a schedule that is gone.
    expect(JS).toMatch(/schedules \|\| \[\]\)\.some\(\(s\) => s\.id === wanted\)/);
    expect(JS).toMatch(/activeScheduleId: exists \? wanted : null/);
  });

  it('settles the schedule BEFORE the library builds a queue', () => {
    // Changing it afterwards would mean reshaping a queue just committed from
    // the wrong running order.
    const rule = JS.indexOf('rememberLastSchedule');
    const load = JS.indexOf('await loadLibrary(state.rootPath)');
    expect(rule).toBeGreaterThan(-1);
    expect(load).toBeGreaterThan(-1);
    expect(rule).toBeLessThan(load);
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
