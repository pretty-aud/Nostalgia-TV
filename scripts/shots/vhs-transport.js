/* The player transport under the VCR skin, plus a scanline check.
   Bare statements; throws so shoot-all gates on it. */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(700);
const sel = document.getElementById('themeSelect');
sel.value = 'vhs'; sel.dispatchEvent(new Event('change', { bubbles: true }));
await wait(700);

// Force the transport into view without real media.
const app = document.getElementById('app');
app.dataset.view = 'playing';
app.dataset.chrome = 'on';
document.getElementById('npShow').textContent = 'Cowboy Bebop';
document.getElementById('npCode').textContent = 'S01E05';
document.getElementById('npTitle').textContent = 'Ballad of Fallen Angels';
document.getElementById('timeLabel').textContent = '12:04 / 24:31';
document.getElementById('chromeUpNext').textContent = 'Next: Trigun S01E04';
document.getElementById('scrubFill').style.width = '49%';
await wait(600);

// The timeline must actually be thick, not the 3px hairline.
const track = document.querySelector('.scrub__track');
const h = Math.round(track.getBoundingClientRect().height);
if (h < 20) throw new Error(`timeline is ${h}px — the thick track rule did not apply`);

// The scanlines must actually be painted, not merely declared.
const lines = getComputedStyle(document.querySelector('.sidebar')).backgroundImage;
if (!/repeating-linear-gradient/.test(lines)) throw new Error('no scanlines on the sidebar: ' + lines);

const box = document.querySelector('.chrome').getBoundingClientRect();
return { x: box.x, y: box.y - 8, width: box.width, height: box.height + 16 };
