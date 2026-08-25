// The sidebar list in one theme: the toggles and the scrollbar are the two
// things being judged, so the crop is the scrolling region itself.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const theme = new URL(location.href).searchParams.get('theme') || 'marigold';

await wait(900);
document.getElementById('btnSettings').click();
await wait(300);
const select = document.getElementById('themeSelect');
select.value = theme;
select.dispatchEvent(new Event('change', { bubbles: true }));
await wait(400);
document.getElementById('btnCloseSettings').click();
await wait(400);

// One row switched OFF, so both states are in the same picture.
const rows = [...document.querySelectorAll('#showList .show')];
if (rows.length < 5) throw new Error('the library did not load');
// The toggle, not the row — a click on the row plays the show instead, so
// this quietly produced shots with nothing switched off at all.
if (rows[2].dataset.off !== 'true') rows[2].querySelector('.show__toggle').click();
await wait(400);
if (rows[2].dataset.off !== 'true') throw new Error('row 3 would not switch off');

const scroll = document.querySelector('.sidebar__scroll');
const box = scroll.getBoundingClientRect();
return { x: box.left, y: box.top, width: box.width + 6, height: Math.min(box.height, 430) };
