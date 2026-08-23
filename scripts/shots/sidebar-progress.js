// The per-show progress bars, in whichever theme is asked for.
//
// The preview library starts at zero watched, so every bar would be 0% wide
// and there would be nothing to photograph. Rather than paint widths in by
// hand, this clicks the real "pass this episode" control a few times on the
// first rows — the same path a viewer takes — so the bars are drawn by the
// code that ships.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const theme = new URL(location.href).searchParams.get('theme') || '01';

await wait(900);
document.getElementById('btnSettings').click();
await wait(300);
const select = document.getElementById('themeSelect');
select.value = theme;
select.dispatchEvent(new Event('change', { bubbles: true }));
await wait(400);
if (document.documentElement.dataset.theme !== theme) {
  throw new Error(`theme did not apply: ${document.documentElement.dataset.theme}`);
}
document.getElementById('btnCloseSettings').click();
await wait(400);

// Different amounts on different rows, so a bar at one width cannot be
// mistaken for a border or a divider.
for (const [row, presses] of [[0, 4], [1, 9], [2, 2]]) {
  for (let i = 0; i < presses; i += 1) {
    const rows = [...document.querySelectorAll('#showList .show')];
    const pass = rows[row] && rows[row].querySelector('.showctl[data-act="pass"]');
    if (!pass) throw new Error(`no pass control on row ${row}`);
    pass.click();
    await wait(90);
  }
}
await wait(400);

const widths = [...document.querySelectorAll('#showList .show__bar i')]
  .slice(0, 3).map((i) => i.style.width);
if (widths.every((w) => parseFloat(w) === 0)) throw new Error('every bar is still 0%');

const scroll = document.querySelector('.sidebar__scroll');
const box = scroll.getBoundingClientRect();
return { x: box.left, y: box.top, width: box.width + 6, height: Math.min(box.height, 400) };
