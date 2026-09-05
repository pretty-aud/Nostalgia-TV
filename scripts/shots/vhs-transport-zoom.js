/* The transport row close up, to judge the play mark. Bare statements. */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(700);
const sel = document.getElementById('themeSelect');
sel.value = 'vhs'; sel.dispatchEvent(new Event('change', { bubbles: true }));
await wait(800);
const app = document.getElementById('app');
app.dataset.view = 'playing';
app.dataset.chrome = 'on';
document.getElementById('timeLabel').textContent = '12:04 / 24:31';
await wait(500);
const t = document.querySelector('.transport').getBoundingClientRect();
return { x: t.x - 8, y: t.y - 10, width: 430, height: t.height + 20 };
