/**
 * THE OPEN SPACE, photographed while it is open.
 *
 * sched-drag.js asserts the arithmetic and then drops; a screenshot taken after
 * that shows a settled list and proves nothing about the thing she asked for.
 * This one is the same drag, stopped one beat earlier, so the frame contains
 * the space itself.
 *
 * Review frame with teeth: it still throws if nothing opened.
 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(700);

/**
 * The skin matters here, and this is the reason: the bug was REPORTED on VHS.
 * Running only the default theme would have re-tested the palette where the
 * dead zones are smallest and called it covered.
 */
if (window.__shotTheme) {
  const sel = document.getElementById('themeSelect');
  if (!sel) throw new Error('no theme select — cannot put the editor in a known skin');
  sel.value = window.__shotTheme;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(700);
}

document.getElementById('btnSettings').click();
await wait(800);

// Reach the editor however this build gets there.
if (document.getElementById('scheduleModal')?.hidden) {
  document.getElementById('btnOpenSchedule')?.click();
  await wait(700);
}
const modal = document.getElementById('scheduleModal');
if (!modal || modal.hidden) throw new Error('the schedule editor did not open');

const order = document.getElementById('schedOrder');
const pool = document.getElementById('schedPool');

// Build a running order of three, by clicking — the pool's click-to-add path,
// which is independent of everything under test.
document.getElementById('schedClear').click();
await wait(200);
const poolCards = [...pool.querySelectorAll('.setsched__card')];
if (poolCards.length < 3) throw new Error(`need three shows to test with, found ${poolCards.length}`);
for (const card of poolCards.slice(0, 3)) { card.click(); await wait(120); }
await wait(300);

const names = () => [...order.querySelectorAll('.setsched__name')].map((n) => n.textContent.trim());
const before = names();
if (before.length !== 3) throw new Error(`expected three blocks, got ${before.length}`);

const fire = (node, type, clientY, dt) => {
  const event = new DragEvent(type, {
    bubbles: true, cancelable: true, clientY, clientX: order.getBoundingClientRect().left + 40,
    dataTransfer: dt,
  });
  node.dispatchEvent(event);
  return event;
};

/**
 * THE GAP BETWEEN CARD 0 AND CARD 1 — the coordinate that used to fail.
 *
 * Not the middle of a card: a card's own handler used to get that one right.
 * The 8px of nothing between two cards is what fell through to the container.
 */
const cards = () => [...order.querySelectorAll('.setsched__card')];
const first = cards()[0].getBoundingClientRect();
const second = cards()[1].getBoundingClientRect();
const gapY = (first.bottom + second.top) / 2;
if (!(gapY > first.bottom && gapY < second.top)) {
  throw new Error(`no gap between the first two cards to aim at — ${first.bottom} to ${second.top}`);
}

// Drag the LAST block up into that gap. Expected: it lands second.
const dt = new DataTransfer();
const last = cards()[2];
fire(last, 'dragstart', last.getBoundingClientRect().top + 4, dt);
await wait(100);

fire(order, 'dragover', gapY, dt);
await wait(200);

/**
 * The space must be OPEN before the drop — that is the thing she asked to see,
 * and it is drawn with a transform, so it is invisible to anything that only
 * reads class names.
 */
const shifted = cards().filter((c) => c.style.transform && c.style.transform !== 'none');
if (shifted.length === 0) {
  throw new Error('no space opened under the pointer — nothing was translated');
}


const box = document.querySelector('#scheduleModal .setsched__body').getBoundingClientRect();
return {
  x: Math.max(0, box.x - 8),
  y: Math.max(0, box.y - 8),
  width: Math.min(1100, box.width + 16),
  height: Math.min(700, box.height + 16),
};
