/**
 * The set-schedule window with a running order already built.
 *
 * Built by CLICKING the pool cards rather than by writing state, so the shot
 * only exists if the interaction actually works — and with one show added
 * twice, because that is the case the layout has to survive: a repeated card
 * must read as a second block, not as a duplicate that slipped in.
 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

document.getElementById('btnSchedule').click();
await wait(400);

const panel = document.querySelector('#scheduleModal .modal__panel');
if (!panel) throw new Error('the schedule window did not open');

const pool = [...document.querySelectorAll('#schedPool .setsched__card')];
if (pool.length < 3) throw new Error(`need three shows in the pool, got ${pool.length}`);

document.getElementById('schedName').value = 'Saturday mornings';
document.getElementById('schedBlock').value = '2';
document.getElementById('schedBlock').dispatchEvent(new Event('change', { bubbles: true }));
await wait(200);

// Show 0 twice: two separate blocks of the same programme in one rotation.
for (const index of [0, 1, 0, 2]) {
  [...document.querySelectorAll('#schedPool .setsched__card')][index].click();
  await wait(120);
}

const cards = [...document.querySelectorAll('#schedOrder .setsched__card')];
if (cards.length !== 4) throw new Error(`expected 4 cards in the running order, got ${cards.length}`);

// The numbering is the whole promise of the column: 01 plays first.
const first = cards[0].querySelector('.setsched__pos').textContent;
if (first !== '01') throw new Error(`the first card is numbered ${first}`);
if (document.getElementById('schedEmpty').hidden !== true) {
  throw new Error('the empty hint is still showing with four cards on the list');
}

const box = panel.getBoundingClientRect();
return { x: box.left - 12, y: box.top - 12, width: box.width + 24, height: box.height + 24 };
