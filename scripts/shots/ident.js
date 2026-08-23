// The wordmark and its set, in whichever theme is asked for.
//
// Cropped tight to the ident: the mark is 22px, and 22px inside a 1280px
// window is too few pixels to tell a good shape from a smudge.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const theme = new URL(location.href).searchParams.get('theme') || 'midnight';

await wait(900);
document.getElementById('btnSettings').click();
await wait(300);
const select = document.getElementById('themeSelect');
select.value = theme;
select.dispatchEvent(new Event('change', { bubbles: true }));
await wait(400);
if (document.documentElement.dataset.theme !== theme) {
  throw new Error(`theme did not apply: ${document.documentElement.dataset.theme}`);
}
document.getElementById('btnCloseSettings').click();
await wait(400);

const ident = document.querySelector('.ident');
if (!ident || !ident.querySelector('.ident__set')) throw new Error('no set in the ident');

const box = ident.getBoundingClientRect();
return { x: box.left - 10, y: box.top - 10, width: box.width + 20, height: box.height + 20 };
