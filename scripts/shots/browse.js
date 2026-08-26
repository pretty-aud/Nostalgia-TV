// The library gallery, with a Continue Watching row.
//
// The preview fixture starts at zero watched, so the row would not exist and
// the shot would show the one thing it is meant to show missing. Progress is
// made through the real controls first, then the library is seeded from it the
// same way it will be on a real launch.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const theme = new URL(location.href).searchParams.get('theme') || 'midnight';
const step = new URL(location.href).searchParams.get('step') || 'grid';

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
await wait(300);

// Two shows given different amounts of channel progress, so Continue Watching
// has something to seed from and the two rows are visibly different lengths.
for (const [row, presses] of [[0, 6], [2, 2]]) {
  for (let i = 0; i < presses; i += 1) {
    const pass = document.querySelectorAll('#showList .show')[row]
      ?.querySelector('.showctl[data-act="pass"]');
    if (!pass) throw new Error(`no pass control on row ${row}`);
    pass.click();
    await wait(80);
  }
}

const btn = document.getElementById('btnBrowse');
if (!btn) throw new Error('no library button');
btn.click();
await wait(1200);

const browse = document.getElementById('browse');
if (browse.hidden) throw new Error('the library did not open');

const sections = [...document.querySelectorAll('.browsesec__title')].map((h) => h.textContent);
if (!sections.includes('Continue watching')) {
  throw new Error(`no Continue watching row — sections were: ${sections.join(', ')}`);
}
if (!sections.includes('TV Shows') || !sections.includes('Movies')) {
  throw new Error(`missing a section — got: ${sections.join(', ')}`);
}

if (step === 'detail') {
  const tile = document.querySelectorAll('.browsesec')[1]?.querySelector('.tile');
  if (!tile) throw new Error('no show tile to open');
  tile.click();
  await wait(1400);
  if (document.getElementById('browseDetail').hidden) throw new Error('the card did not open');
}

// Thumbnails decode real files; give them a moment to land.
await wait(step === 'detail' ? 2200 : 2600);
return null;
