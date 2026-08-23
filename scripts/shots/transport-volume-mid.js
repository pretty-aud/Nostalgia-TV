// Sound part-way down. The fill has to track the level, not just switch
// between empty and full — and this is also where the one-arc speaker shows.
const app = document.querySelector('.app');
app.dataset.view = 'playing';
app.dataset.chrome = 'on';
await new Promise((r) => setTimeout(r, 300));

const range = document.getElementById('volumeRange');
range.value = '40';
range.dispatchEvent(new Event('input', { bubbles: true }));
await new Promise((r) => setTimeout(r, 400));

const fill = range.style.getPropertyValue('--fill').trim();
if (fill !== '40%') throw new Error(`the track fill says ${fill || '(unset)'}, not 40%`);
if (document.getElementById('volume').dataset.silent === 'true') throw new Error('40% should not read as silent');

const box = document.getElementById('volume').getBoundingClientRect();
return { x: box.left - 14, y: box.top - 12, width: box.width + 28, height: box.height + 24 };
