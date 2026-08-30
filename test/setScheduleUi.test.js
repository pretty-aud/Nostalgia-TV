import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The set-schedule window must keep out of the sidebar's CSS namespace.
 *
 * It did not, at first, and the failure was silent in the worst way. The
 * sidebar's "Up next" rows already own `.sched__drop`, `.sched__body`,
 * `.sched__name` and `.sched__n`, and `.sched__drop` is deliberately
 * `opacity: 0` until its row is hovered. Reusing the name made the remove
 * button on every schedule card INVISIBLE while remaining present, sized,
 * focusable and clickable — nothing in the markup or the JS looked wrong, and
 * the only way to find it was to measure a computed style. The same collision
 * also put a second click handler on it, belonging to the sidebar.
 *
 * So the rule is structural: the window's classes are `setsched__*`, and a
 * bare `sched__*` inside its markup is a bug, not a style choice.
 */

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const read = (...p) => fs.readFileSync(path.join(here, '..', ...p), 'utf8');

const html = read('src', 'renderer', 'index.html');
const css = read('src', 'renderer', 'styles.css');

/** Just the two dialogs this feature adds. */
function scheduleMarkup() {
  const start = html.indexOf('<!-- Set schedules: build a fixed running order by hand.');
  const end = html.indexOf('<!-- Rewritten whenever subtitle settings change', start);
  expect(start, 'the set-schedule markup block').toBeGreaterThan(-1);
  expect(end, 'the end of the set-schedule markup block').toBeGreaterThan(start);
  return html.slice(start, end);
}

const classesIn = (text) => new Set(
  [...text.matchAll(/\bsetsched__[a-z-]+/g)].map((m) => m[0]),
);

describe('set-schedule window keeps its own namespace', () => {
  it('finds the markup block at all', () => {
    // A control: every assertion below is vacuous if this slice comes back empty.
    const markup = scheduleMarkup();
    expect(markup.length).toBeGreaterThan(500);
    expect(markup).toMatch(/id="scheduleModal"/);
    expect(markup).toMatch(/id="marathonModal"/);
  });

  it('uses no bare sched__ class, which the sidebar owns', () => {
    // The exact bug: `.sched__drop` is opacity:0 until its sidebar row is
    // hovered, so borrowing the name hides the control completely.
    const bare = [...scheduleMarkup().matchAll(/class="[^"]*\bsched__[a-z-]+/g)].map((m) => m[0]);
    expect(bare).toEqual([]);
  });

  it('leaves the sidebar classes alone', () => {
    // The other half of the mistake would be "fixing" the collision by renaming
    // the SIDEBAR, which would silently unstyle Up next.
    for (const owned of ['.sched__drop', '.sched__body', '.sched__name', '.sched__n']) {
      expect(css, owned).toContain(`${owned} `);
    }
  });

  it('has a stylesheet rule for every class the window uses', () => {
    // A class with no rule is the same invisible-control failure wearing a
    // different hat.
    const used = classesIn(scheduleMarkup());
    expect(used.size).toBeGreaterThan(6);
    for (const name of used) {
      expect(css, `${name} has no CSS rule`).toContain(`.${name}`);
    }
  });

  it('styles the classes the renderer builds at runtime', () => {
    // Cards are created in JS, so they never appear in the markup above.
    for (const name of ['setsched__card', 'setsched__pos', 'setsched__eps', 'setsched__drop']) {
      expect(css, `${name} has no CSS rule`).toContain(`.${name}`);
    }
  });

  it('keeps the remove control visible', () => {
    // Pin the property that was actually wrong. A rule that sets the schedule
    // card's remove button to opacity 0 is the original bug returning.
    const rule = /\.setsched__drop\s*\{[^}]*\}/.exec(css);
    expect(rule, 'no .setsched__drop rule at all').not.toBe(null);
    expect(rule[0]).not.toMatch(/opacity:\s*0\b/);
  });
});
