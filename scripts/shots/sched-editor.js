/**
 * THE SCHEDULE EDITOR, whole — the tools bar included.
 *
 * The two drag probes frame .setsched__body, which is the right crop for what
 * they assert and the wrong one for reviewing the sheet: everything that says
 * WHICH schedule is being edited, and now which card it announces itself with,
 * lives above that box and never appeared in a frame.
 *
 * Asserts the style menu is built rather than written, because a menu that
 * ships empty looks identical to a menu whose options are being added by code
 * that stopped running.
 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(700);

if (window.__shotTheme) {
  const sel = document.getElementById('themeSelect');
  if (!sel) throw new Error('no theme select');
  sel.value = window.__shotTheme;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(700);
}

document.getElementById('btnSettings').click();
await wait(800);
document.getElementById('btnOpenSchedule').click();
await wait(800);

const modal = document.getElementById('scheduleModal');
if (!modal || modal.hidden) throw new Error('the schedule editor did not open');

const menu = document.getElementById('schedStyle');
if (!menu) throw new Error('no per-schedule style menu');
if (menu.options.length < 2) {
  throw new Error(`the style menu has ${menu.options.length} option(s) — it is not being built`);
}
if (menu.options[0].value !== '') {
  throw new Error(`the first option should be inherit, it is "${menu.options[0].value}"`);
}

// Put a couple of blocks in so the sheet is not framed empty.
document.getElementById('schedClear').click();
await wait(200);
for (const card of [...document.querySelectorAll('#schedPool .setsched__card')].slice(0, 3)) {
  card.click();
  await wait(120);
}

// Show the override rather than the default — the default is what the sheet
// looked like before, and a frame of that reviews nothing.
menu.value = 'boxoffice';
menu.dispatchEvent(new Event('change', { bubbles: true }));
await wait(300);

const box = modal.querySelector('.modal__panel').getBoundingClientRect();
return {
  x: Math.max(0, box.x),
  y: Math.max(0, box.y),
  width: Math.min(1120, box.width),
  height: Math.min(760, box.height),
};
