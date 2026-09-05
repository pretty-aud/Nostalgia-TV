/* The card image dialog, opened from a show row in the library table.
   Bare statements: shoot-state wraps this in its own async function. */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

document.getElementById('btnSettings').click();
await wait(300);
document.getElementById('btnOpenMedia').click();
await wait(700);

// The first show row's "Set image…" — column four of the shows table.
const setBtn = [...document.querySelector('#mediaRows tr').querySelectorAll('button')]
  .find((b) => b.textContent.startsWith('Set image'));
setBtn.click();
await wait(500);

const panel = document.querySelector('#artModal .modal__panel');
const box = panel.getBoundingClientRect();
return { x: box.x - 28, y: box.y - 28, width: box.width + 56, height: box.height + 56 };
