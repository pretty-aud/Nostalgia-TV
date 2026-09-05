/* The WHITE ground — the pair that inverts, and the only one that touches the
   app's light/dark machinery. Bare statements. */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(700);
const sel = document.getElementById('themeSelect');
sel.value = 'vhs'; sel.dispatchEvent(new Event('change', { bubbles: true }));
await wait(700);
document.getElementById('btnSettings').click();
await wait(600);
[...document.querySelectorAll('#vhsGroundRail .osdcell')].find((c) => c.dataset.key === 'white').click();
await wait(500);
document.getElementById('btnCloseSettings').click();
await wait(600);
