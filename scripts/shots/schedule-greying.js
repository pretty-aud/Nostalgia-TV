/**
 * A show unticked in All Shows must NOT render greyed once a schedule names it.
 *
 * The tick box is `.show__toggle`, not the row — clicking the row PLAYS the
 * show. Bare statements; throws on failure so shoot-all gates on it.
 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = {};
const cards = () => [...document.querySelectorAll('#showList .show')];
const cardFor = (id) => cards().find((c) => c.dataset.showId === id);

await wait(800);
const sel = document.getElementById('scheduleSelect');
out.optionValues = [...sel.options].map((o) => o.value).join('|');
out.allShowsToStart = sel.value === '';

// A show the schedule DOES name, so the two states can disagree.
const scheduled = 'samuraix';
const card = cardFor(scheduled);
if (!card) throw new Error(`no card for ${scheduled}; ids: ${cards().map((c) => c.dataset.showId).join(',')}`);

// Untick it in All Shows — the tick box, not the row.
const toggle = card.querySelector('.show__toggle');
if (!toggle) throw new Error('no .show__toggle on the card');
toggle.click();
await wait(600);
out.greyedInAllShows = cardFor(scheduled).dataset.off === 'true';

// Put the schedule in force.
const opt = [...sel.options].find((o) => o.value && !o.value.startsWith('__'));
if (!opt) throw new Error(`no schedule option; values: ${out.optionValues}`);
sel.value = opt.value;
sel.dispatchEvent(new Event('change', { bubbles: true }));
await wait(900);

out.scheduleTookEffect = sel.value === opt.value
  && document.getElementById('showList').dataset.toggles === 'false';
const inSchedule = cardFor(scheduled);
out.stillListedUnderSchedule = Boolean(inSchedule);
out.notGreyedUnderSchedule = Boolean(inSchedule) && inSchedule.dataset.off === 'false';

// Back to All Shows: the tick state is remembered, not lost.
sel.value = '';
sel.dispatchEvent(new Event('change', { bubbles: true }));
await wait(800);
out.greyAgainInAllShows = cardFor(scheduled).dataset.off === 'true';

const bad = Object.entries(out).filter(([k, v]) => k !== 'optionValues' && !v);
if (bad.length) throw new Error(`schedule greying: ${bad.map(([k]) => k).join(', ')} — ${JSON.stringify(out)}`);
return out;
