/* The library page under the VCR skin. Bare statements. */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(700);
const sel = document.getElementById('themeSelect');
sel.value = 'vhs'; sel.dispatchEvent(new Event('change', { bubbles: true }));
await wait(700);
document.getElementById('btnBrowse').click();
await wait(1000);
