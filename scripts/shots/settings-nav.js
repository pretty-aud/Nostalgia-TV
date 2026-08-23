// The settings sheet with its section rail, in whichever theme is asked for.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const theme = new URL(location.href).searchParams.get('theme') || 'midnight';

await wait(900);
document.getElementById('btnSettings').click();
await wait(500);
const select = document.getElementById('themeSelect');
select.value = theme;
select.dispatchEvent(new Event('change', { bubbles: true }));
await wait(500);

const items = [...document.querySelectorAll('.setnav__item')];
if (items.length < 5) throw new Error(`the rail only built ${items.length} items`);

// Jump to a section a few down, so the current-section marker is visible on
// something other than the first row.
const target = items.find((i) => i.textContent === 'Interface') || items[4];
target.click();
await wait(700);

const panel = document.querySelector('#settingsModal .modal__panel');
const box = panel.getBoundingClientRect();
return { x: box.left - 8, y: box.top - 8, width: box.width + 16, height: box.height + 16 };
