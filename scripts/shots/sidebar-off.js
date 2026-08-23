// A switched-OFF row beside switched-on ones. The off state is the case that
// has to stay findable: black outline, black empty box.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const theme = new URL(location.href).searchParams.get('theme') || 'marigold';

await wait(900);
document.getElementById('btnSettings').click();
await wait(300);
const select = document.getElementById('themeSelect');
select.value = theme;
select.dispatchEvent(new Event('change', { bubbles: true }));
await wait(400);
document.getElementById('btnCloseSettings').click();
await wait(400);

// Re-query after every click: renderSidebar rebuilds the list, so a held
// reference points at a row that is no longer in the document.
const nameAt = (i) => [...document.querySelectorAll('#showList .show')][i]
  .querySelector('.show__name').textContent;
const target = nameAt(1);
const rowFor = (name) => [...document.querySelectorAll('#showList .show')]
  .find((r) => r.querySelector('.show__name').textContent === name);

if (rowFor(target).dataset.off !== 'true') {
  rowFor(target).querySelector(".show__toggle").click();
  await wait(500);
}
if (rowFor(target).dataset.off !== 'true') throw new Error('the row did not switch off');

const scroll = document.querySelector('.sidebar__scroll');
const box = scroll.getBoundingClientRect();
return { x: box.left, y: box.top, width: box.width + 6, height: Math.min(box.height, 380) };
