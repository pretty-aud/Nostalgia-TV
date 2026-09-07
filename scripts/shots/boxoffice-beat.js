/**
 * THE BOX OFFICE at one moment of its run, chosen by ?at= in the URL.
 *
 * shoot-state photographs a snippet's final state, so a card with seven beats
 * needs seven runs. The moment comes from the query string and the caller
 * tiles the results — the same instrument used to read her reference bumper,
 * so the two can be laid side by side as timelines rather than descriptions.
 *
 * Bare statements; throws so shoot-all gates on it.
 *
 * Failing controls, each RUN:
 *   - remove the @property inherits:true and it throws "the band never opens
 *     for the element that carries the mask" — which is the bug that made
 *     every earlier measurement lie;
 *   - remove the opener's clip-path wipe and it throws "the opener is never
 *     wiped away".
 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const at = Number(new URLSearchParams(location.search).get('at') || 5000);

await wait(400);
window.tv.mpvOpen = () => Promise.resolve();
window.__preview.settings().bumperBackground = 'still';
window.__preview.showBoxOffice(() => {}, null);

const card = document.getElementById('boxoffice');
const bg = card.querySelector('.boxoffice__bg');
const opener = card.querySelector('.boxoffice__opener');

/**
 * THE MASK IS READ ON THE CHILD, never on the card.
 *
 * The band stops are set on the card and consumed by this child. Registered
 * with inherits:false the child kept the initial value for ever while the
 * card's own animated perfectly — so every check that read the card reported
 * a band that opened, against a screen that showed a bar. Read where the
 * mask actually resolves, or this measures nothing.
 */
const maskOf = () => getComputedStyle(bg).maskImage;

const opened = [];
const wiped = [];
const step = 120;
for (let t = 0; t < at; t += step) {
  await wait(step);
  opened.push(maskOf());
  wiped.push(getComputedStyle(opener).clipPath);
}

// Somewhere in the run the band must reach past the edges of the frame, or it
// never became a full picture — only ever a bar.
if (at >= 4000 && !opened.some((m) => /-\d/.test(m))) {
  throw new Error(`the band never opens for the element that carries the mask: ${opened[opened.length - 1]}`);
}

// And the opener must be taken away, or it sits over the picture for ever.
if (at >= 4000 && !wiped.some((c) => /inset\([^)]*100%/.test(c))) {
  throw new Error(`the opener is never wiped away: ${wiped[wiped.length - 1]}`);
}

const box = card.getBoundingClientRect();
return { x: box.x, y: box.y, width: box.width, height: box.height };
