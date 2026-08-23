// The bottom of the sidebar with a film booked: the "Up next" four, the film
// row under them, and the footer buttons.
//
// The film row only exists when a movie is actually booked, so this switches
// movies on through the footer control rather than un-hiding the element —
// an un-hidden empty row photographs as a bug that is not there.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const theme = new URL(location.href).searchParams.get('theme') || '78';

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

const movies = document.getElementById('btnMovies');
if (!movies || movies.hidden) throw new Error('no movie control — the fixture has no MOVIES folder');
const row = document.getElementById('scheduleMovie');
for (let i = 0; i < 3 && row.hidden; i += 1) { movies.click(); await wait(500); }
if (row.hidden) throw new Error('no film was booked');

const list = document.querySelector('.sidebar__next') || row.parentElement;
const top = list.getBoundingClientRect();
const foot = document.querySelector('.sidebar__foot') || row;
const bottom = foot.getBoundingClientRect();
return {
  x: top.left,
  y: top.top - 8,
  width: top.width,
  height: Math.max(bottom.bottom, row.getBoundingClientRect().bottom) - top.top + 16,
};
