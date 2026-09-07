/**
 * THE CAROUSEL ARROW, WITH NOTHING BEHIND IT — and the way into settings.
 *
 * The arrow used to sit on `linear-gradient(var(--paper) 35%, transparent)`,
 * which is a SOLID band for its first third: on a dark theme, a black bar that
 * appeared over the artwork whenever the pointer neared the edge. It read as a
 * rendering fault rather than as a control.
 *
 * Both facts here are invisible in a still if you only look:
 *   - the arrow's own computed background must be transparent, and
 *   - it must still be legible, which is now a halo on the glyph rather than a
 *     ground behind it.
 * So both are measured, and the frame is hovered so the arrow is actually
 * shown — photographing it at opacity 0 would prove nothing at all.
 *
 * Failing controls, each RUN:
 *   - put the gradient back on .rail__arrow--prev and the background check
 *     reports a colour instead of transparent;
 *   - delete the drop-shadow filter and the legibility check finds `none`.
 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(900);

if (window.__shotTheme) {
  const sel = document.getElementById('themeSelect');
  if (!sel) throw new Error('no theme select');
  sel.value = window.__shotTheme;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(800);
}

document.getElementById('btnBrowse').click();
await wait(1400);

const browse = document.getElementById('browse');
if (browse.hidden) throw new Error('the library did not open');

// The settings door, which is the whole point of adding it here.
const gear = document.getElementById('btnBrowseSettings');
if (!gear) throw new Error('no settings button in the library header');
const back = document.getElementById('btnBrowseChannel');
const gb = gear.getBoundingClientRect();
const bb = back.getBoundingClientRect();
if (!gb.width || !gb.height) throw new Error('the settings button is not laid out');
if (Math.abs(gb.top - bb.top) > 12) {
  throw new Error(`the settings button is not on the back button's line (${Math.round(gb.top)} vs ${Math.round(bb.top)})`);
}
if (gb.left < bb.right) throw new Error('the settings button is not beside the back button');

// A rail to hover. The first .browsesec--rail is Continue watching when there
// is one, otherwise the first row of the grid — either is a real carousel.
const rail = document.querySelector('.browsesec--rail');
if (!rail) throw new Error('no carousel in the library to hover');
rail.scrollIntoView({ block: 'center' });
await wait(400);

const arrow = rail.querySelector('.rail__arrow--prev') || rail.querySelector('.rail__arrow--next');
if (!arrow) throw new Error('the carousel has no arrows');

/**
 * NO GROUND, on the button OR on the strip it sits in. Checking only the
 * button would miss a gradient moved onto a wrapper, which is exactly how this
 * would come back.
 */
for (const node of [arrow]) {
  const cs = getComputedStyle(node);
  const bg = cs.backgroundColor;
  const img = cs.backgroundImage;
  const clear = bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent';
  if (!clear) throw new Error(`the arrow still has a background: ${bg}`);
  if (img && img !== 'none') throw new Error(`the arrow still has a gradient: ${img}`);
}

// ...but it must still be readable over a bright frame.
const glyph = arrow.querySelector('svg');
if (!glyph) throw new Error('the arrow has no glyph');
const filter = getComputedStyle(glyph).filter;
if (!filter || filter === 'none') {
  throw new Error('the glyph has no halo — over a bright frame the arrow will vanish');
}

// Show it, or the frame photographs an invisible control.
rail.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
arrow.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
arrow.style.opacity = '1';
await wait(400);

/**
 * FULL WIDTH, from the header down. The first version cropped to 900px and cut
 * off the right-hand end of the header — which is exactly where the settings
 * button it is meant to show sits. A frame that excludes half its subject
 * passes its own assertions and reviews nothing.
 */
const box = rail.getBoundingClientRect();
return {
  x: 0,
  y: 0,
  width: Math.round(window.innerWidth),
  height: Math.round(Math.min(window.innerHeight, box.bottom + 40)),
};
