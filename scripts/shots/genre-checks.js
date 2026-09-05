/**
 * Not a screenshot — a behaviour probe, run through the shipping engine.
 *
 * Every assertion was run against the builds BEFORE its fix as well as after,
 * because a check that passes either way proves nothing. Which commit each
 * one actually discriminates, measured rather than assumed:
 *
 *   vs 55cb65b (the feature, before round 1)   before -> after
 *     sciFiOptions                                  0 -> 1
 *     sciFiOffersExisting                       false -> true
 *     punctNoCreate                             false -> true
 *     punctHintShown                            false -> true
 *     nonLatinChipAdded                         false -> true
 *     nonLatinInCell                            false -> true
 *     cellUpdatesAfterDelete                    false -> true
 *     popClosedWithSheet                        false -> true
 *     menuClosedOnLeave                         false -> true
 *
 *   vs 2b2d8a9 (round 1's fixes, before round 2)
 *     popClosedBehindHeader                     false -> true
 *     detachedDidNotTeleport                    false -> true
 *
 * PLAIN REGRESSION GUARDS, not proofs — these pass on both builds, and saying
 * so is the point: sciFiNoBogusCreate, popRepositioned, popStaysAttached,
 * popClosedWhenRowLeft, reAnchorsOnHeightChange. The last one would only
 * discriminate in the flip-above branch, and by the time it runs the popover
 * is positioned below its row where height does not enter the arithmetic.
 *
 * The scroll checks replaced a single "followed OR closed" assertion that was
 * worthless: the fixture's table does not overflow, so nothing ever scrolled,
 * and it passed because the popover had grown earlier in the run and caught
 * up. tableActuallyScrolls, anchorReallyMoved and rowBehindHeader exist so
 * those premises can never silently lapse again, and popReopenedForCloseCheck
 * exists so the close check cannot pass on a popover that was already shut.
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

/**
 * --- E: scrolling the table.
 *
 * The fixture has five shows, so .modal__body does NOT overflow — measured
 * scrollHeight 337, clientHeight 337. An earlier version of this check set
 * scrollTop and asserted the popover "moved", and passed without a single
 * pixel having scrolled: the popover had merely grown during section C and
 * caught up on the next reposition. It proved nothing.
 *
 * So force the overflow the real app has with 32 shows, by capping the
 * scrollport. That is a geometry change, not a behaviour stub — the real
 * scroll path, the real listener and the real guard all run.
 *
 * Two SEPARATE assertions, because "followed or closed" cannot say which
 * happened and a disjunction hides a dead branch.
 */
const scroller = q('#mediaModal .modal__body');
scroller.style.maxHeight = '180px';
await wait(150);
out.tableActuallyScrolls = scroller.scrollHeight - scroller.clientHeight > 40;

/**
 * SETTLE before measuring. Capping the height re-laid out the whole modal and
 * moved the anchor, but nothing repositions the popover on a style change, so
 * a baseline read here would be stale — and the scroll delta would then
 * include that catch-up and look like the popover overshooting. Measured it
 * doing exactly that: anchor up 24px, popover apparently down 66px.
 */
window.dispatchEvent(new Event('resize'));
await wait(200);

// The live cell the popover is anchored to — re-queried, because section D
// rebuilt the table and the original node is long gone.
const anchorCell = qa('#mediaRows .genrecell')[0];
const anchorTopBefore = anchorCell.getBoundingClientRect().top;
const popTopBefore = document.getElementById('tagPop').getBoundingClientRect().top;
scroller.scrollTop = 24;
await wait(300);
const movedBy = anchorTopBefore - anchorCell.getBoundingClientRect().top;
out.anchorReallyMoved = movedBy > 8;

/**
 * E1: a small scroll — the popover stays ATTACHED to its row.
 *
 * Not "moved by the same distance": the popover legitimately flips between
 * below-the-row and above-the-row as space opens and closes, and across a
 * flip the delta is the popover's own height, not the scroll distance. That
 * assertion failed on correct behaviour (measured: row up 24px, popover down
 * 406px across a flip) — a check has to encode the invariant, not one branch.
 *
 * The invariant is adjacency: one of the popover's edges sits against one of
 * the row's. Before the fix nothing repositioned at all, so the gap opens to
 * the full scroll distance and this still fails.
 */
const gapTo = (cell) => {
  const a = cell.getBoundingClientRect();
  const p = document.getElementById('tagPop').getBoundingClientRect();
  return Math.min(Math.abs(p.top - a.bottom), Math.abs(a.top - p.bottom));
};
const popMovedBy = popTopBefore - document.getElementById('tagPop').getBoundingClientRect().top;
out.__diag = JSON.stringify({ movedBy, popMovedBy, gap: Math.round(gapTo(anchorCell)) });
out.popRepositioned = Math.abs(popMovedBy) > 1;
out.popStaysAttached = !document.getElementById('tagPop').hidden && gapTo(anchorCell) < 12;

/**
 * E2: the popover re-anchors when its OWN height changes.
 *
 * Positioning was hooked to scroll and resize but not to the render that
 * resizes it, so typing — which rebuilds the option list on every keystroke —
 * left it drifting away from its row while sitting still. In the flip-above
 * branch the top edge is computed from the height, so a shorter list moves
 * the bottom edge away from the row it is captioning.
 */
type('mecha');
await wait(300);
out.reAnchorsOnHeightChange = !document.getElementById('tagPop').hidden
  && gapTo(anchorCell) < 12;
type('');
await wait(250);

/**
 * E3: a row hidden behind the STICKY column header is out of sight.
 *
 * `.locktable th` is position:sticky, 33px tall, so the top band of the
 * scrollport is permanently covered. Closing only when the row leaves the
 * scrollport BOX left the popover captioning a row nobody can see.
 */
const rowHeight = anchorCell.getBoundingClientRect().height;
const head = scroller.querySelector('thead');
scroller.scrollTop = Math.round(head.getBoundingClientRect().height + rowHeight);
await wait(300);
out.rowBehindHeader = anchorCell.getBoundingClientRect().bottom
  < scroller.getBoundingClientRect().bottom;      // still inside the BOX
out.popClosedBehindHeader = document.getElementById('tagPop').hidden;

// E4: scroll the row out of the scrollport entirely — the popover CLOSES.
qa('#mediaRows .genrecell')[0].click();
await wait(300);
scroller.scrollTop = 0;
await wait(200);
scroller.scrollTop = scroller.scrollHeight;
await wait(300);
out.popClosedWhenRowLeft = document.getElementById('tagPop').hidden;

/**
 * E5: a DETACHED anchor must close the popover, not teleport it.
 *
 * positionTagPop reads geometry off the anchor. A detached node has no
 * ancestors, so closest('.modal__body') is null and the scrollport guard was
 * SKIPPED in exactly the state it exists for; the maths then ran on an
 * all-zero rect and pinned the popover to the top-left corner of the window,
 * still writing to the original title. Measured: rect 0,0,0,0 -> left 12, top 6.
 */
scroller.scrollTop = 0;
await wait(200);
const victim = qa('#mediaRows .genrecell')[0];
victim.click();
await wait(350);
victim.closest('tr').remove();
document.dispatchEvent(new Event('scroll', { bubbles: false }));
await wait(300);
const popBox = document.getElementById('tagPop').getBoundingClientRect();
out.detachedDidNotTeleport = document.getElementById('tagPop').hidden
  || !(popBox.top < 20 && popBox.left < 20);
// The probe tore a row out of the DOM by hand, so rebuild the table the only
// way the page offers: close the sheet and open it again.
scroller.style.maxHeight = '';
document.getElementById('btnCloseMedia').click();
await wait(250);
document.getElementById('btnOpenMedia').click();
await wait(700);

/**
 * --- F: closing the table must not leave the popover live.
 *
 * REOPEN it first. E2 closed it on purpose, and asserting that a
 * already-closed popover is closed would pass no matter what closeMedia does
 * — a green tick for a branch that never ran.
 */
qa('#mediaRows .genrecell')[0].click();
await wait(350);
out.popReopenedForCloseCheck = !document.getElementById('tagPop').hidden;
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
const informational = ['punctHint', '__diag'];
const failures = Object.entries(out).filter(([key, value]) => !informational.includes(key) && !value);
if (failures.length) {
  // The whole state goes in the message. A failure that only names the check
  // sends the next person back to add the logging by hand.
  throw new Error(`genre checks failed: ${failures.map(([key]) => key).join(', ')} — ${JSON.stringify(out)}`);
}
if (out.punctHint !== 'A genre needs at least one letter or number.') {
  throw new Error(`wrong hint for a keyless tag: ${out.punctHint}`);
}

return out;
