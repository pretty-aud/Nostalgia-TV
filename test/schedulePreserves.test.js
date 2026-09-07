import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * A SAVED SCHEDULE MUST SURVIVE BEING LOOKED AT.
 *
 * renderSchedOrder used to open with
 *
 *     draft.items = draft.items.filter((id) => byId.has(id));
 *
 * which ran on every render, mutated the draft in place, and was then persisted
 * verbatim by commitDraft. A show the library could not see at that moment —
 * an external drive not yet spun up, a scan still running, a folder briefly
 * renamed — was struck out of her saved schedule the instant the editor drew
 * itself, and Save made it permanent. Nothing threw and no test failed.
 *
 * It is the same shape as the rebuild that destroyed her hand-placed card
 * pictures: delete first, re-derive after. The rule this file exists to hold is
 * that the editor never removes a block she did not remove.
 *
 * Source-text assertions, and that is stated rather than dressed up: the
 * function reaches for the DOM and cannot be imported. What they can prove is
 * that the destructive line is not there and has not come back, which is
 * exactly how it got in.
 */
const JS = readFileSync(new URL('../src/renderer/index.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

/** The body of renderSchedOrder, comments stripped — the argument is not the code. */
const renderOrder = (() => {
  const start = JS.indexOf('function renderSchedOrder(');
  expect(start, 'renderSchedOrder is gone — this file is testing nothing').toBeGreaterThan(-1);
  return JS.slice(start, JS.indexOf('\nfunction ', start + 10))
    .replace(/\/\*\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
})();

describe('opening the schedule editor', () => {
  it('never reassigns draft.items', () => {
    // Any assignment to the saved array is a rewrite of her data during a
    // render. There is no benign version of this in a function that draws.
    expect(renderOrder, 'renderSchedOrder must not rewrite the saved running order')
      .not.toMatch(/draft\.items\s*=/);
  });

  it('does not filter blocks out against the library', () => {
    expect(renderOrder).not.toMatch(/draft\.items\s*=\s*draft\.items\.filter/);
    expect(renderOrder, 'a filter here silently shortens a saved schedule')
      .not.toMatch(/\.filter\([^)]*byId\.has/);
  });

  it('renders a placeholder for a block the library cannot resolve', () => {
    // The block keeps its id, so saving preserves it and the schedule repairs
    // itself when the folder comes back.
    expect(renderOrder).toMatch(/byId\.get\(id\)\s*\|\|\s*\{[^}]*missing: true/);
  });

  it('marks that placeholder so it is visibly not an ordinary block', () => {
    expect(JS).toMatch(/dataset\.missing = 'true'/);
    expect(CSS).toMatch(/\.setsched__card\[data-missing="true"\]/);
  });
});

/**
 * THE DRAG SYSTEM, at the level a unit test can reach.
 *
 * Where a block lands is geometry and is measured in the engine by
 * scripts/shots/sched-drag.js. What belongs here is the structural property
 * that made the bug possible: cards owning drop handlers, so that everything
 * between them fell through to a container that appended to the end.
 */
describe('where a dragged block lands', () => {
  const wireCard = JS.slice(JS.indexOf('function wireCardDrag('), JS.indexOf('function wireColumnDrops('));

  it('gives no card a drop or dragover handler of its own', () => {
    // 8px of list padding, an 8px gap between every pair of cards and a 220px
    // floor all belonged to the container while these existed — which is most
    // of the column, and all of it meant "put it last".
    expect(wireCard, 'a per-card target reopens the dead zones between cards')
      .not.toMatch(/addEventListener\('(drop|dragover)'/);
  });

  it('computes the insertion index from the pointer against every card', () => {
    expect(JS).toMatch(/function insertionIndexAt\(/);
    expect(JS).toMatch(/spans\[i\]\.top \+ spans\[i\]\.height \/ 2/);
  });

  /**
   * The cached geometry is what stops the effect feeding back into its own
   * cause: opening the space moves cards, and if the index were read from live
   * rects that movement would change the index, which moves the space.
   */
  it('measures the list once per drag rather than on every dragover', () => {
    expect(JS).toMatch(/function captureDragGeometry\(/);
    const over = JS.slice(JS.indexOf("order.addEventListener('dragover'"), JS.indexOf("order.addEventListener('dragleave'"));
    expect(over, 'the dragover handler must not re-measure the cards')
      .not.toMatch(/querySelectorAll\('\.setsched__card'\)/);
  });

  it('checks relatedTarget on dragleave, which fires when crossing onto a child', () => {
    expect(JS).toMatch(/dragleave[\s\S]{0,160}contains\(event\.relatedTarget\)/);
  });

  it('opens the space with a transform, which costs no layout', () => {
    expect(JS).toMatch(/card\.style\.transform = i >= index/);
    expect(CSS).toMatch(/\.setsched__card \{[^}]*transform var\(--fast\)/);
  });
});
