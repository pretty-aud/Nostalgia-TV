/**
 * THE MINIMAL LOFI CARD, at the beat where both its lines have appeared.
 *
 * Photographs the card AND asserts the things a still cannot show:
 *   - the text POPS. No transition, no animation, on any node in the card —
 *     which is the whole brief and is invisible in a photograph;
 *   - the two groups are on OPPOSITE sides, so a long title cannot collide
 *     with the other group;
 *   - the label carries its second token, as //SHIBUYA-KU// TOKYO does;
 *   - nothing is drawn behind the type — no plate, no scrim, no gradient.
 *
 * Failing controls, each RUN:
 *   - give .lofi__label a `transition: opacity .2s` and the pop check reports it;
 *   - make placementFor return the same bias twice and the collision check fires;
 *   - put a background on .lofi__group and the plate check finds it.
 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(800);

if (window.__shotTheme) {
  const sel = document.getElementById('themeSelect');
  if (sel) {
    sel.value = window.__shotTheme;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(700);
  }
}

if (!window.__preview || !window.__preview.lofi) {
  throw new Error('no preview entry point for the lofi card — is it fenced on __tvCalls?');
}

// Draw the card and hold it at the beat where the second group is up.
await window.__preview.lofi();
await wait(600);

const card = document.getElementById('lofi');
if (card.hidden) throw new Error('the card did not open');

/**
 * NO ANIMATION ANYWHERE. Checked across every node in the card rather than on
 * the two it is obvious on: the stylesheet has a broad `p` transition and a
 * view-change fade that could both reach in here, and neither would look broken
 * enough to notice — just permanently, slightly wrong.
 */
const animated = [];
for (const node of card.querySelectorAll('*')) {
  const cs = getComputedStyle(node);
  const dur = parseFloat(cs.transitionDuration) || 0;
  const anim = cs.animationName && cs.animationName !== 'none';
  if (dur > 0 || anim) animated.push(`${node.className || node.tagName}: ${cs.transitionDuration}/${cs.animationName}`);
}
if (animated.length) {
  throw new Error(`the text is animated, it must only pop: ${animated.slice(0, 3).join(' | ')}`);
}

// Nothing behind the type.
for (const id of ['lofiFirst', 'lofiSecond']) {
  const cs = getComputedStyle(document.getElementById(id));
  const bg = cs.backgroundColor;
  if (bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
    throw new Error(`${id} has a plate behind it: ${bg}`);
  }
  if (cs.backgroundImage && cs.backgroundImage !== 'none') {
    throw new Error(`${id} has a gradient behind it: ${cs.backgroundImage}`);
  }
}

const first = document.getElementById('lofiFirst');
const second = document.getElementById('lofiSecond');
if (first.dataset.bias === second.dataset.bias) {
  throw new Error(`both groups on the ${first.dataset.bias} — a long title would collide`);
}

const label = document.getElementById('lofiFirstLabel').textContent;
if (!/^\/\/[A-Z ]+\/\//.test(label)) {
  throw new Error(`the label is not slash-wrapped: "${label}"`);
}

// Both up at once for the frame, so the photograph shows the whole vocabulary
// even though the card never shows them together.
first.hidden = false;
document.getElementById('lofiFirstTitle').hidden = false;
second.hidden = false;
document.getElementById('lofiSecondTitle').hidden = false;
await wait(300);

/**
 * STILL THERE AT THE MOMENT OF CAPTURE.
 *
 * Checked again, at the end, because the first version of this probe passed
 * every assertion above and then photographed the ready screen: the card had
 * torn itself down between the checks and the shot. The checks were all true
 * when they ran, so nothing failed — the frame was simply of something else.
 * The card is held open now, and this is the control proving the hold works.
 */
if (card.hidden) throw new Error('the card closed before the frame was taken');
const box = card.getBoundingClientRect();
if (box.width < window.innerWidth * 0.9 || box.height < window.innerHeight * 0.9) {
  throw new Error(`the card is not filling the frame: ${Math.round(box.width)}x${Math.round(box.height)}`);
}
// And the type must be ON that card, not merely present in the document.
const onScreen = document.elementFromPoint(
  Math.round(box.left + box.width * 0.5), Math.round(box.top + box.height * 0.5),
);
if (!card.contains(onScreen)) {
  throw new Error(`something is drawn over the card: ${onScreen && onScreen.className}`);
}

return { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
