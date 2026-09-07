/**
 * A FILM PLACED IN A RUNNING ORDER, and the list it draws from.
 *
 * Photographs the Movies tab, having first put a film block into the running
 * order from the Shows pool — so the frame shows the two halves of the feature
 * agreeing with each other rather than each looking plausible alone.
 *
 * Asserts the parts that are invisible once they work:
 *   - the film block reaches draft.items as the reserved token, not as a show;
 *   - the block renders as a block rather than as a missing show, which is what
 *     it would look like if renderSchedOrder had not been taught about it;
 *   - an empty film list reads as "every film", the opposite of how an empty
 *     running order reads, which is the rule most likely to be "fixed" later.
 *
 * Failing controls, each RUN:
 *   - drop the isMovieBlock branch in renderSchedOrder and the card comes back
 *     captioned "__movie__ / not in the library";
 *   - make normaliseSchedule turn [] into [] instead of null and the count
 *     stops reading "every film".
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

// Now the Movies tab.
const tab = [...document.querySelectorAll('#schedTabs .setsched__tab')].find((b) => b.dataset.pane === 'movies');
if (!tab) throw new Error('no Movies tab');
tab.click();
await wait(400);

if (document.getElementById('schedPaneMovies').hidden) throw new Error('the Movies pane did not open');
if (!document.getElementById('schedPaneOrder').hidden) throw new Error('both panes are showing at once');

const count = document.getElementById('schedFilmCount').textContent.trim();
if (count !== 'every film') {
  throw new Error(`an empty film list must read as "every film", it reads "${count}"`);
}

// Choose two, so the frame shows a list and the count changing.
const films = [...document.querySelectorAll('#schedFilmPool .setsched__card')];
if (films.length >= 2) {
  films[0].click(); await wait(140);
  films[1].click(); await wait(200);
  const chosen = document.querySelectorAll('#schedFilms .setsched__card').length;
  if (chosen !== 2) throw new Error(`clicked two films, the list holds ${chosen}`);
  if (document.getElementById('schedFilmCount').textContent.trim() === 'every film') {
    throw new Error('the count still says "every film" after two were chosen');
  }
}

// And the order switch, shown on rather than off — off is the default and a
// frame of the default reviews nothing.
const orderSwitch = document.getElementById('schedMovieOrder');
orderSwitch.checked = true;
orderSwitch.dispatchEvent(new Event('change', { bubbles: true }));
await wait(300);

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
