/**
 * THE FILM BLOCK WHERE SHE PUT IT — the running order, framed.
 *
 * sched-movies.js proves the same placement and then moves to the Movies tab,
 * so its frame never contains the block itself. This one stops at the running
 * order, which is the half of the feature that has to look like a block rather
 * than like a show the library has lost.
 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(700);

if (window.__shotTheme) {
  const sel = document.getElementById('themeSelect');
  if (!sel) throw new Error('no theme select');
  sel.value = window.__shotTheme;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(700);
}

document.getElementById('btnSettings').click();
await wait(800);
document.getElementById('btnOpenSchedule').click();
await wait(800);

document.getElementById('schedClear').click();
await wait(200);

// Two shows, then the film block, then another show — a real running order
// rather than a single card that could look right by accident.
const pool = () => [...document.querySelectorAll('#schedPool .setsched__card')];
const filmBlockCard = pool().find((c) => c.dataset.movieBlock === 'true');
if (!filmBlockCard) throw new Error('no film block in the shows pool to place');

const shows = pool().filter((c) => c.dataset.movieBlock !== 'true');
if (shows.length < 2) throw new Error(`need two shows, found ${shows.length}`);

shows[0].click(); await wait(120);
shows[1].click(); await wait(120);
filmBlockCard.click(); await wait(120);
shows[0].click(); await wait(200);

const order = [...document.querySelectorAll('#schedOrder .setsched__card')];
if (order.length !== 4) throw new Error(`expected four blocks, got ${order.length}`);

const placed = order[2];
if (placed.dataset.movieBlock !== 'true') {
  throw new Error(`the third block is not a film block — it reads "${placed.textContent.trim()}"`);
}
if (placed.dataset.missing === 'true') {
  throw new Error('the film block rendered as a MISSING SHOW — renderSchedOrder does not know the token');
}

/**
 * NOTHING SCROLLS BUT THE LISTS.
 *
 * The sheet is a locked frame: the tools bar, the tabs, the column heads and
 * the footer are fixed points you navigate BY, and a fixed point that scrolls
 * away is not one. It also meant Save could be off screen while editing.
 *
 * Measured rather than looked at, because a crop that happens to fit hides
 * exactly this. Failing control: drop `min-height: 0` from the pane and it
 * refuses to shrink below its content, so the body reports
 * scrollHeight > clientHeight and this throws.
 */
const panel = document.querySelector('#scheduleModal .modal__panel');
const pane = document.querySelector('#scheduleModal .modal__body:not([hidden])');
const slack = 2;   // sub-pixel rounding at fractional device ratios
for (const [what, node] of [['the panel', panel], ['the pane', pane]]) {
  if (node.scrollHeight > node.clientHeight + slack) {
    throw new Error(
      `${what} scrolls — ${node.scrollHeight}px of content in ${node.clientHeight}px. `
      + 'Only the lists may scroll.',
    );
  }
}

// And the lists must be the ones that CAN, or the frame simply clips them.
const scrollers = [...document.querySelectorAll('#scheduleModal .setsched__list')]
  .filter((list) => getComputedStyle(list).overflowY === 'auto');
if (scrollers.length < 2) {
  throw new Error(`only ${scrollers.length} list can scroll — the frame is clipping instead`);
}

const foot = document.querySelector('#scheduleModal .setsched__foot').getBoundingClientRect();
if (!foot.height) throw new Error('the footer is not laid out — Save is unreachable');
const frame = panel.getBoundingClientRect();
if (foot.bottom > frame.bottom + slack) {
  throw new Error(`the footer is ${Math.round(foot.bottom - frame.bottom)}px below the frame — Save is off screen`);
}

const box = document.querySelector('#scheduleModal .modal__panel').getBoundingClientRect();
return {
  x: Math.max(0, box.x),
  y: Math.max(0, box.y),
  width: Math.min(1120, box.width),
  height: Math.min(900, box.height),
};
