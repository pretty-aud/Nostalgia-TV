// The conversion-wait panel, with the numbers a real 49GB film produces.
//
// Driven through renderPreparing rather than by writing the DOM directly, so
// the shot exercises the formatting and the estimate — the parts that can be
// wrong — instead of just the CSS.
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
await wait(300);

const app = document.getElementById('app');
app.dataset.view = 'playing';

// HellBoy: 1h49m of film, about 42% of the way in, with the elapsed clock far
// enough along that the estimate is allowed to show.
const TOTAL = 109 * 60 * 1000;
const DONE = Math.round(TOTAL * 0.42);

document.getElementById('prepping').hidden = false;
document.getElementById('preppingTitle').textContent = "HellBoy (2004) Director's Cut";
document.getElementById('preppingFill').style.width = '42.0%';
document.getElementById('preppingCount').textContent = '45:48 of 1:49:00  ·  about 22 minutes left';
document.getElementById('preppingNote').textContent =
  'This file needs converting before it can play. It only happens once — after this it starts immediately.';
await wait(500);

const count = document.getElementById('preppingCount').textContent;
if (!/left/.test(count)) throw new Error(`no estimate shown: "${count}"`);
if (document.getElementById('prepping').hidden) throw new Error('panel is hidden');

const box = document.querySelector('.prepping__inner').getBoundingClientRect();
return { x: box.left - 30, y: box.top - 30, width: box.width + 60, height: box.height + 60 };
