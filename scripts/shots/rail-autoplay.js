/**
 * THE CONTINUE ROW MOVES ON BY ITSELF — and stands down when she is using it.
 *
 * Auto-advance is the kind of behaviour that fails silently: when a timer
 * stops firing nothing looks broken, the row simply sits there, and no
 * screenshot can tell the difference. It has to be asserted.
 *
 * The interval is shortened through window.__railAdvanceMs before the library
 * is opened, so the rail is BUILT with it. At the real fifteen seconds this
 * probe would need over a minute of wall clock and shoot-state gives every
 * snippet forty seconds — it would have timed out long before proving
 * anything, which is a probe that fails for the wrong reason.
 *
 * Bare statements; throws so shoot-all gates on it.
 *
 * Failing controls, each RUN:
 *   - remove the setInterval and it throws "the row never advanced";
 *   - remove the pointerenter hold and it throws "the row advanced while the
 *     pointer was over it";
 *   - remove the detailOpen() guard and it throws "the row advanced with a
 *     panel open over it".
 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const TICK = 900;                 // what the rail is told to use
const SETTLE = TICK + 1400;       // a tick, plus the smooth scroll landing

window.__railAdvanceMs = TICK;
await wait(500);
document.getElementById('btnBrowse').click();
await wait(900);

const rail = document.querySelector('.browsesec--rail');
if (!rail) throw new Error('no continue rail on the library page');
const viewport = rail.querySelector('.rail');
if (!viewport) throw new Error('the rail has no scroller');
if (rail.querySelectorAll('.raildot').length < 2) {
  throw new Error('the fixture rail has one page — auto-advance cannot be tested');
}

/**
 * SAMPLE A SEQUENCE, do not compare two snapshots.
 *
 * This rail LOOPS: with two pages the scroll position alternates between the
 * same two values, so "before" and "after" can legitimately be identical
 * while the row is advancing perfectly well. The first version of this probe
 * did exactly that and reported "the row never advanced" against a rail that
 * was moving. Counting distinct positions over a few ticks cannot be fooled
 * that way.
 */
const positions = async (ms) => {
  const seen = new Set();
  const until = Date.now() + ms;
  while (Date.now() < until) {
    seen.add(Math.round(viewport.scrollLeft));
    await wait(120);
  }
  return seen;
};

// ── it advances ──────────────────────────────────────────────────────────
const moving = await positions(SETTLE * 2);
if (moving.size < 2) {
  throw new Error(`the row never advanced: parked at ${[...moving].join(',')}`);
}

// ── it holds while the pointer is on it ──────────────────────────────────
rail.dispatchEvent(new PointerEvent('pointerenter'));
await wait(SETTLE);                       // let any scroll in flight land
const hovered = await positions(SETTLE * 2);
if (hovered.size > 1) {
  throw new Error(`the row advanced while the pointer was over it: ${[...hovered].join(' -> ')}`);
}
rail.dispatchEvent(new PointerEvent('pointerleave'));

// ...and carries on once the pointer leaves, or the hold is a permanent stop.
const resumed = await positions(SETTLE * 2);
if (resumed.size < 2) throw new Error('the row never resumed after the pointer left');

// ── it holds while a panel is open over it ───────────────────────────────
const tile = document.querySelector('.tiles .tile');
if (!tile) throw new Error('no tile to open a panel with');
tile.click();
await wait(700);
if (document.getElementById('browseDetail').hidden) throw new Error('the panel did not open');
await wait(SETTLE);
const underPanel = await positions(SETTLE * 2);
if (underPanel.size > 1) {
  throw new Error(`the row advanced with a panel open over it: ${[...underPanel].join(' -> ')}`);
}
document.getElementById('btnDetailClose').click();
await wait(500);

// ── a discarded rail stops ───────────────────────────────────────────────
// renderBrowse() rebuilds these wholesale, so without the isConnected check
// every redraw would leave another timer running for the rest of the session.
const orphan = viewport;
document.getElementById('btnBrowseChannel').click();
await wait(500);
document.getElementById('btnBrowse').click();
await wait(900);
if (!orphan.isConnected) {
  const parked = Math.round(orphan.scrollLeft);
  await wait(SETTLE * 2);
  if (Math.round(orphan.scrollLeft) !== parked) {
    throw new Error('a discarded rail is still being advanced by its own timer');
  }
}

delete window.__railAdvanceMs;
// The rail was rebuilt above, so `rail` is the discarded one and measures
// zero. Crop the live one.
const shown = document.querySelector('.browsesec--rail');
const box = (shown || rail).getBoundingClientRect();
return { x: box.x, y: box.y, width: Math.min(900, box.width), height: Math.min(340, box.height) };
