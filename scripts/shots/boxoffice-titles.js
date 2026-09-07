/**
 * THE BOX OFFICE, beat two — the next three programmes.
 *
 * The card this style exists to draw. Everything else is a lead-in to it.
 *
 * Bare statements; throws so shoot-all gates on it.
 *
 * Failing controls, each RUN:
 *   - slice the rows to 1 and it throws "the card lists 1 programme, not 3";
 *   - give the lead and the followers the same size and it throws "the lead
 *     is not set larger";
 *   - remove the backdrop request and it throws "no backdrop behind the type".
 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(500);

window.tv.mpvOpen = () => Promise.resolve();
window.__preview.showBoxOffice(() => {}, null);
await wait(3400);

const card = document.getElementById('boxoffice');
if (card.hidden) throw new Error('the card never appeared');

const atCentre = document.elementFromPoint(
  Math.round(window.innerWidth / 2), Math.round(window.innerHeight / 2),
);
if (!card.contains(atCentre)) {
  throw new Error('something is on top of the card: '
    + (atCentre ? (atCentre.id || atCentre.className || atCentre.tagName) : 'nothing'));
}

// Neither of the other two cards is underneath. All three share
// data-view="bumper" so the keyboard rule applies to any of them, which means
// the style attribute is the only thing keeping the others out of the way.
for (const id of ['bumper', 'asbump']) {
  if (document.getElementById(id).getBoundingClientRect().height > 0) {
    throw new Error(`the ${id} card is showing underneath`);
  }
}

const rows = [...card.querySelectorAll('.boxoffice__row')];
if (rows.length !== 3) {
  throw new Error(`the card lists ${rows.length} programme(s), not 3`);
}
if (Number(getComputedStyle(document.getElementById('boxofficeList')).opacity) < 0.9) {
  throw new Error('the titles never resolved — the list is still transparent');
}

/**
 * SIZE does the ranking, not colour or weight. The research note is explicit
 * that hierarchy in this package is size and tracking within a scene, and it
 * is what stops the two follow-on titles reading as equal billing.
 */
const size = (el) => parseFloat(getComputedStyle(el).fontSize);
if (!(size(rows[0]) > size(rows[1]) * 1.5)) {
  throw new Error(`the lead is not set larger: ${size(rows[0])}px against ${size(rows[1])}px`);
}

/**
 * A BACKDROP, not just a gradient. The still is requested before the card is
 * raised precisely so it is here by now; if the request is dropped this is the
 * assertion that notices, because a gradient alone still looks deliberate.
 */
const still = document.getElementById('boxofficeStill');
if (still.hidden || !still.getAttribute('src')) {
  throw new Error('no backdrop behind the type');
}

// The wash has to be a GRADIENT. A flat scrim is the thing the research note
// says makes a modern attempt at this look like a web page.
const wash = getComputedStyle(card.querySelector('.boxoffice__wash')).backgroundImage;
if (!/gradient/.test(wash)) throw new Error(`the wash is not a gradient: ${wash}`);

const box = card.getBoundingClientRect();
return { x: box.x, y: box.y, width: box.width, height: box.height };
