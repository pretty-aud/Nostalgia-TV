// The ready screen over a stand-in for a paused frame: a bright, busy image is
// the case that broke, and a black stage would have hidden the problem.
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
await wait(300);

// Stand in for the paused picture.
const stage = document.querySelector('.stage');
stage.style.background =
  'repeating-linear-gradient(35deg, #7a2f2f 0 90px, #2b2b46 90px 180px, #c9b48a 180px 240px)';

const app = document.getElementById('app');
app.dataset.view = 'ready';
document.querySelector('.sidebar').style.transform = 'translateX(-100%)';
await wait(500);

const inner = document.querySelector('.welcome__inner');
if (!inner) throw new Error('the ready screen is not rendered');
const box = inner.getBoundingClientRect();
if (box.width < 100) throw new Error('the ready panel has no size');
return { x: box.left - 60, y: box.top - 60, width: box.width + 120, height: box.height + 120 };
