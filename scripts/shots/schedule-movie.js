// The sidebar footer with a movie booked ONE block out — the case where its
// position in the list and the count on the bar have to agree.
const button = document.getElementById('btnMovies');
if (!button || button.hidden) throw new Error('no movie switch — the library has no MOVIES folder');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const when = () => document.getElementById('scheduleMovieWhen').textContent.trim();

// The lead is random 1–3, so re-book until it lands on one block.
let found = false;
for (let attempt = 0; attempt < 30 && !found; attempt += 1) {
  if (button.getAttribute('aria-pressed') === 'true') { button.click(); await wait(150); }
  button.click();
  await wait(250);
  found = when() === 'in 1 block';
}
if (!found) throw new Error('never booked a one-block lead in 30 tries');

const row = document.querySelector('#scheduleList .sched--movie');
if (!row) throw new Error('a one-block movie must appear in the list, not only on the bar');

const list = document.getElementById('scheduleList');
const head = list.previousElementSibling;
const marathon = document.getElementById("scheduleField");
const top = (head || list).getBoundingClientRect();
const bottom = (marathon || list).getBoundingClientRect();
return { x: top.left, y: top.top - 10, width: top.width, height: (bottom.bottom - top.top) + 16 };
