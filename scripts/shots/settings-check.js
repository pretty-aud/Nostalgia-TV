// A settings checkbox, ticked, in whichever theme is asked for.
//
// The crop is the section the checkbox lives in rather than the whole sheet:
// a 15px control photographed inside a 700px dialog is too few pixels to tell
// one accent colour from another, which is the only thing being judged here.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const theme = new URL(location.href).searchParams.get('theme') || '01';

await wait(900);
document.getElementById('btnSettings').click();
await wait(400);
const select = document.getElementById('themeSelect');
select.value = theme;
select.dispatchEvent(new Event('change', { bubbles: true }));
await wait(500);
if (document.documentElement.dataset.theme !== theme) {
  throw new Error(`theme did not apply: ${document.documentElement.dataset.theme}`);
}

// The first checkbox in a section that is actually showing — hidden rows
// scroll to nowhere and photograph as blank.
const row = [...document.querySelectorAll('#settingsBody .check')]
  .find((r) => r.offsetParent && r.querySelector('input'));
if (!row) throw new Error('no visible check row');

const box = row.querySelector('input');
if (!box.checked) { box.click(); await wait(200); }
if (!box.checked) throw new Error('the box would not tick');

row.scrollIntoView({ block: 'center' });
await wait(600);

const r = row.getBoundingClientRect();
return { x: r.left - 24, y: r.top - 40, width: r.width + 48, height: r.height + 80 };
