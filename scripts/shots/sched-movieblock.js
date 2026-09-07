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

const box = document.querySelector('#scheduleModal .modal__panel').getBoundingClientRect();
return {
  x: Math.max(0, box.x),
  y: Math.max(0, box.y),
  width: Math.min(1120, box.width),
  height: Math.min(760, box.height),
};
