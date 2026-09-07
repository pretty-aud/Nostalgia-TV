/**
 * THE BOX OFFICE, beat one — the mark beside the word.
 *
 * Its own snippet because shoot-state captures after the snippet returns, so
 * a run that walks to the end can only photograph the end.
 *
 * Bare statements; throws so shoot-all gates on it.
 *
 * Failing controls, each RUN:
 *   - remove the first BEATS entry and it throws "the eyebrow never resolved";
 *   - drop the markSvg call and it throws "no mark beside the word".
 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(500);

window.tv.mpvOpen = () => Promise.resolve();
window.__preview.showBoxOffice(() => {}, null);
await wait(1600);

const card = document.getElementById('boxoffice');
if (card.hidden) throw new Error('the card never appeared');

/**
 * ON SCREEN, not merely laid out. getBoundingClientRect returns the same box
 * whether a card is on top or buried — the schedule card's first probe passed
 * every assertion while photographing the settings panel.
 */
const atCentre = document.elementFromPoint(
  Math.round(window.innerWidth / 2), Math.round(window.innerHeight / 2),
);
if (!card.contains(atCentre)) {
  throw new Error('something is on top of the card: '
    + (atCentre ? (atCentre.id || atCentre.className || atCentre.tagName) : 'nothing'));
}

// Beat one is up; the titles are not.
const next = card.querySelector('.boxoffice__next');
if (Number(getComputedStyle(next).opacity) < 0.9) {
  throw new Error('the eyebrow never resolved — it is still transparent');
}
if (Number(getComputedStyle(document.getElementById('boxofficeList')).opacity) > 0.1) {
  throw new Error('the titles arrived on the same beat as the eyebrow');
}

const mark = document.getElementById('boxofficeMark').querySelector('svg');
if (!mark) throw new Error('no mark beside the word');
const drawn = mark.getBoundingClientRect();
if (drawn.width < 20) throw new Error(`the mark drew at ${Math.round(drawn.width)}px`);

// The word sits on the mark's baseline rather than above or below it: they are
// one lockup, and a stacked pair would read as two separate things.
const word = card.querySelector('.boxoffice__word').getBoundingClientRect();
const overlap = Math.min(drawn.bottom, word.bottom) - Math.max(drawn.top, word.top);
if (overlap <= 0) throw new Error('the mark and the word are not on the same line');

// The condensed display face, not a fallback — the whole package rests on it.
const face = getComputedStyle(card.querySelector('.boxoffice__word')).fontFamily;
if (!/Oswald/.test(face)) throw new Error(`the eyebrow is not set in the display face: ${face}`);

const box = card.getBoundingClientRect();
return { x: box.x, y: box.y, width: box.width, height: box.height };
