import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * THE SEAM BETWEEN PROGRAMMES EXISTS ONCE.
 *
 * She reported that after a film the sting and the promo played and the up-next
 * card did not. Nothing was failing a condition: rollIntoChannel had its own
 * hand-written copy of the chain — playBumperClip -> playPromoClip -> playNext
 * — which is three of its four steps, and the fourth was simply never typed.
 *
 * That is a whole class of bug this file exists for. A duplicated sequence does
 * not drift loudly; it drifts by omission, and the omission looks exactly like
 * a feature that was never built for that path.
 *
 * Source text rather than behaviour, and stated plainly: the chain is built
 * from callbacks into mpv, the DOM and a real clock, so running it here would
 * mean rebuilding the app. What CAN be asserted cheaply is that there is one
 * copy of it — which is the property that was actually violated.
 */
const JS = readFileSync(new URL('../src/renderer/index.js', import.meta.url), 'utf8');

/** Comments quote the old chain to explain the bug; they are not code. */
const CODE = JS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the transition between programmes', () => {
  it('is written once, not once per entrance', () => {
    // CALLS only. The first version counted `function playBumperClip(` too and
    // reported two chains where there is one — a test that fails on correct
    // code teaches people to ignore it.
    const chains = CODE.match(/(?<!function\s)playBumperClip\(\s*\(\)/g) || [];
    expect(chains, 'more than one bumper->promo chain means one of them will lose a step')
      .toHaveLength(1);
  });

  it('is a named function, so another entrance can call it', () => {
    expect(CODE).toMatch(/function runTransition\(\)/);
  });

  /**
   * BOTH ENTRANCES. The end of a channel episode, and a film handed back from
   * the library — the second is the one that was missing the card.
   */
  it('is what the library hand-back runs', () => {
    const roll = CODE.slice(CODE.indexOf('function rollIntoChannel()'));
    const body = roll.slice(0, roll.indexOf('\n}'));
    expect(body, 'rollIntoChannel must not rebuild the chain').toMatch(/runTransition\(\)/);
    expect(body, 'and must not call playNext directly, which skips the card AND any due film')
      .not.toMatch(/playNext\(\)/);
  });

  it('is what the end of an episode runs', () => {
    const ended = CODE.slice(CODE.indexOf('function onEpisodeEnded()'));
    const body = ended.slice(0, ended.indexOf('\nfunction '));
    expect(body).toMatch(/runTransition\(\)/);
  });

  /**
   * THE SECOND HOLE IN THE COPY, which nobody had hit yet.
   *
   * playNext() has no movieIsDue branch — only the transition does. So a film
   * the channel had already scheduled was silently dropped on the way back from
   * the library, and the clock just waited for the next one. Calling the real
   * transition fixes that as a side effect, and this pins it.
   */
  it('is the only place that decides whether a due film plays', () => {
    const decisions = CODE.match(/movieIsDue\(state\)/g) || [];
    expect(decisions.length, 'a second movieIsDue check means two places can disagree')
      .toBeLessThanOrEqual(2);
    const run = CODE.slice(CODE.indexOf('function runTransition()'));
    expect(run.slice(0, run.indexOf('\n}\n'))).toMatch(/movieIsDue\(state\)/);
  });

  /**
   * The card dispatch itself. __debug.playUpNext keeps its own copy on purpose
   * — it raises ONE card for review rather than running a transition — so this
   * asks that both copies go through the same map rather than that only one
   * exists. An if-chain in either is the shape that shipped a style drawing
   * somebody else's card.
   */
  it('dispatches every card through the driver map', () => {
    const dispatches = CODE.match(/CARD_DRIVERS\[/g) || [];
    expect(dispatches.length).toBeGreaterThanOrEqual(2);
    expect(CODE).not.toMatch(/else if \(isFixedLength\([^)]*\)\)\s*show/);
  });
});
