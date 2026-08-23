// One theme, showing the sidebar layered over a playing stage plus the
// settings sheet, so panel colours and over-video colours are both visible.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const theme = new URL(location.href).searchParams.get('theme') || 'midnight';

await wait(900);
const select = document.getElementById('themeSelect');
if (!select) throw new Error('no theme control');

document.getElementById('btnSettings').click();
await wait(300);
select.value = theme;
select.dispatchEvent(new Event('change', { bubbles: true }));
await wait(400);
if (document.documentElement.dataset.theme !== theme) {
  throw new Error(`theme did not apply: ${document.documentElement.dataset.theme}`);
}
document.getElementById('btnCloseSettings').click();
await wait(300);

// Show the player chrome under the sidebar, which is the arrangement that has
// to stay legible in every theme.
const app = document.getElementById('app');
app.dataset.view = 'playing';
app.dataset.chrome = 'on';
document.getElementById('npShow').textContent = 'Cowboy Bebop';
document.getElementById('npCode').textContent = 'S01E05';
document.getElementById('npTitle').textContent = 'Ballad of Fallen Angels';
document.getElementById('timeLabel').textContent = '12:04 / 24:31';
document.getElementById('chromeUpNext').textContent = 'Next: Trigun S01E04';
document.getElementById('scrubFill').style.width = '49%';
// Force the sidebar back on top of the playing stage.
document.querySelector('.sidebar').style.transform = 'none';
document.querySelector('.sidebar').style.opacity = '1';
await wait(500);
return null;
