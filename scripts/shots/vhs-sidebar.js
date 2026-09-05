/* The sidebar under the VCR skin. Bare statements. */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(700);
const sel = document.getElementById('themeSelect');
sel.value = 'vhs';
sel.dispatchEvent(new Event('change', { bubbles: true }));
await wait(900);
if (document.documentElement.dataset.skin !== 'vcr') throw new Error('data-skin not set: ' + document.documentElement.dataset.skin);
