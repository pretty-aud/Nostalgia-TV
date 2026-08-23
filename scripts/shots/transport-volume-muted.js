// The same controls muted: the crossed-out speaker stays amber, and the track
// goes flat so silence does not look like sound that is simply turned down.
const app = document.querySelector('.app');
app.dataset.view = 'playing';
app.dataset.chrome = 'on';
await new Promise((r) => setTimeout(r, 300));

const wrap = document.getElementById('volume');
if (wrap.dataset.silent !== 'true') document.getElementById('btnMute').click();
await new Promise((r) => setTimeout(r, 400));
if (wrap.dataset.silent !== 'true') throw new Error('the controls did not go silent');

const box = wrap.getBoundingClientRect();
return { x: box.left - 14, y: box.top - 12, width: box.width + 28, height: box.height + 24 };
