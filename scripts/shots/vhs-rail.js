/* The face rail, close up. Bare statements; returns a rect so it enlarges. */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(700);
const sel = document.getElementById('themeSelect');
sel.value = 'vhs'; sel.dispatchEvent(new Event('change', { bubbles: true }));
await wait(700);
document.getElementById('btnSettings').click();
await wait(600);
const nav = [...document.querySelectorAll('.setnav__item, .settingsnav button, [data-sec]')]
  .find((b) => /INTERFACE/i.test(b.textContent));
if (nav) nav.click();
await wait(700);
const field = document.getElementById('vhsFontField');
field.scrollIntoView({ block: 'center' });
await wait(400);
const b = field.getBoundingClientRect();
return { x: b.x - 16, y: b.y - 40, width: b.width + 32, height: b.height + 80 };
