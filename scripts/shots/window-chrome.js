// The frameless window: buttons floating top-right over the picture, the
// player's own top row clear of them, and a switched-off show collapsed in the
// sidebar beside two that are on.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const theme = new URL(location.href).searchParams.get('theme') || 'midnight';

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

// Give the middle row some progress first, so the expanded rows are showing
// every part a collapsed one drops — meta, bar and controls.
for (let i = 0; i < 5; i += 1) {
  const pass = document.querySelectorAll('#showList .show')[0]?.querySelector('.showctl[data-act="pass"]');
  if (pass) pass.click();
  await wait(90);
}

const rows = () => [...document.querySelectorAll('#showList .show')];
if (rows().length < 3) throw new Error('the library did not load');
// The TOGGLE, not the row: clicking a card plays that show. A click on the
// row itself falls through to "play this", which switches nothing off and
// photographs as a card that simply refused to collapse.
if (rows()[1].dataset.off !== 'true') { rows()[1].querySelector('.show__toggle').click(); await wait(400); }
if (rows()[1].dataset.off !== 'true') throw new Error('row 2 would not switch off');

const app = document.getElementById('app');
app.dataset.view = 'playing';
app.dataset.chrome = 'on';
document.getElementById('npShow').textContent = 'Cowboy Bebop';
document.getElementById('npCode').textContent = 'S01E05';
document.getElementById('npTitle').textContent = 'Ballad of Fallen Angels';
document.getElementById('timeLabel').textContent = '12:04 / 24:31';
document.getElementById('chromeUpNext').textContent = 'Next: Trigun S01E04';
document.getElementById('scrubFill').style.width = '49%';
document.querySelector('.sidebar').style.transform = 'none';
document.querySelector('.sidebar').style.opacity = '1';
await wait(500);
return null;
