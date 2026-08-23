// The transport with sound at full: the slider's fill should be solid amber
// end to end, and the speaker should be the same amber.
const app = document.querySelector('.app');
app.dataset.view = 'playing';
app.dataset.chrome = 'on';
await new Promise((r) => setTimeout(r, 300));

const wrap = document.getElementById('volume');
if (wrap.dataset.silent === 'true') { document.getElementById('btnMute').click(); }
document.getElementById('volumeRange').value = '100';
document.getElementById('volumeRange').dispatchEvent(new Event('input', { bubbles: true }));
await new Promise((r) => setTimeout(r, 400));

if (!document.getElementById('btnMute').querySelector('svg')) throw new Error('the speaker is not an svg');
if (document.getElementById('volumeRange').value !== '100') throw new Error('volume did not reach 100');

const box = wrap.getBoundingClientRect();
return { x: box.left - 14, y: box.top - 12, width: box.width + 28, height: box.height + 24 };
