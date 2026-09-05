/**
 * Not a screenshot — a behaviour probe, run through the shipping engine.
 *
 * Every assertion here was run against the commit BEFORE the fixes as well as
 * after, because a check that passes either way proves nothing. Ten of them
 * genuinely flip:
 *
 *   check                    before -> after
 *   sciFiOptions                  0 -> 1
 *   sciFiOffersExisting       false -> true
 *   punctNoCreate             false -> true
 *   punctHintShown            false -> true
 *   nonLatinChipAdded         false -> true
 *   nonLatinInCell            false -> true
 *   cellUpdatesAfterDelete    false -> true
 *   popFollowedOrClosed       false -> true
 *   popClosedWithSheet        false -> true
 *   menuClosedOnLeave         false -> true
 *
 * NOT tested here, deliberately: focus after a mouse pick. HTMLElement.click()
 * fires the event without focusing the element, so a synthetic click cannot
 * reproduce the real bug (a real click focuses the button, then renderTagPop
 * destroys it and focus falls to <body>). An assertion for it passed
 * identically before and after, which is worse than no assertion — it reads
 * as proof and is not. The fix stands on reading the code.
 *
 * Bare statements: shoot-state wraps this in its own async function.
 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = {};

const q = (sel) => document.querySelector(sel);
const qa = (sel) => [...document.querySelectorAll(sel)];
const type = (value) => {
  const input = document.getElementById('tagPopInput');
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

document.getElementById('btnSettings').click();
await wait(300);
document.getElementById('btnOpenMedia').click();
await wait(800);

// --- open the picker on row 1
qa('#mediaRows .genrecell')[0].click();
await wait(350);
out.popoverOpens = !document.getElementById('tagPop').hidden;

// --- A: a punctuation variant must offer the EXISTING tag, not a dead end
type('sci fi');
await wait(250);
out.sciFiOptions = qa('#tagPopList .tagopt:not(.tagopt--create)').length;
out.sciFiOffersExisting = qa('#tagPopList .tagopt__pick').some((b) => b.textContent === 'Sci-Fi');
out.sciFiNoBogusCreate = !qa('#tagPopList .tagopt--create').length;

// --- B: pure punctuation must NOT offer a Create row, and must say why
type('---');
await wait(250);
out.punctNoCreate = !qa('#tagPopList .tagopt--create').length;
out.punctHintShown = !document.getElementById('tagPopHint').hidden;
out.punctHint = document.getElementById('tagPopHint').textContent;

// --- C: a non-Latin tag must be offered AND actually stick
type('アニメ');
await wait(250);
const createRow = q('#tagPopList .tagopt--create .tagopt__pick');
out.nonLatinOffersCreate = Boolean(createRow);
if (createRow) {
  createRow.click();
  await wait(350);
  out.nonLatinChipAdded = qa('#tagPopChips .chip').some((c) => c.textContent.startsWith('アニメ'));
  out.nonLatinInCell = qa('#mediaRows .genrecell')[0].textContent.includes('アニメ');
}

// (Focus after a mouse pick is deliberately not asserted — see the header.)
qa('#tagPopList .tagopt__pick')[0].click();
await wait(300);

// --- D: delete a genre, then keep tagging — the visible row must still update
type('');
await wait(200);
const rowFor = (name) => qa('#tagPopList .tagopt')
  .find((r) => r.querySelector('.tagopt__pick').textContent === name);
const drop = rowFor('Documentary') && rowFor('Documentary').querySelector('.tagopt__drop');
// window.confirm cannot be answered in a headless run, so stub it for this probe.
window.confirm = () => true;
if (drop) drop.click();
await wait(450);
const horror = rowFor('Horror');
if (horror) horror.querySelector('.tagopt__pick').click();
await wait(400);
out.cellUpdatesAfterDelete = qa('#mediaRows .genrecell')[0].textContent.includes('Horror');

// --- F: scrolling the table must not leave the popover captioning another row
const scroller = q('#mediaModal .modal__body');
const popTopBefore = document.getElementById('tagPop').getBoundingClientRect().top;
scroller.scrollTop = scroller.scrollHeight;
scroller.dispatchEvent(new Event('scroll', { bubbles: false }));
await wait(300);
const popNow = document.getElementById('tagPop');
out.popFollowedOrClosed = popNow.hidden
  || Math.abs(popNow.getBoundingClientRect().top - popTopBefore) > 1;

// --- G: closing the table from the keyboard must not leave the popover live
document.getElementById('btnCloseMedia').click();
await wait(300);
out.popClosedWithSheet = document.getElementById('tagPop').hidden;

// --- H: leaving the library page must not leave the genre menu "open",
//        which was swallowing every global key in the app
document.getElementById('btnCloseSettings').click();
await wait(300);
document.getElementById('btnBrowse').click();
await wait(700);
document.getElementById('btnGenreFilter').click();
await wait(250);
out.menuOpensOnBrowse = !document.getElementById('genreMenu').hidden;
document.getElementById('btnBrowseChannel').click();
await wait(400);
out.menuClosedOnLeave = document.getElementById('genreMenu').hidden;

/**
 * THROW on a failure, do not just report it.
 *
 * shoot-all only inspects the exit status, and shoot-state exits 4 when a
 * snippet throws. Returning a bag of falses would exit 0 and print a tick —
 * a check that cannot fail the run is not a check.
 */
const failures = Object.entries(out).filter(([key, value]) => key !== 'punctHint' && !value);
if (failures.length) {
  throw new Error(`genre checks failed: ${failures.map(([key]) => key).join(', ')}`);
}
if (out.punctHint !== 'A genre needs at least one letter or number.') {
  throw new Error(`wrong hint for a keyless tag: ${out.punctHint}`);
}

return out;
