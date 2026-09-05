/* The picker mid-drag, with a refusal showing. Bare statements. */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
document.getElementById('btnSettings').click();
await wait(300);
document.getElementById('btnOpenMedia').click();
await wait(700);
[...document.querySelector('#mediaRows tr').querySelectorAll('button')]
  .find((b) => b.textContent.startsWith('Set image')).click();
await wait(400);
document.getElementById('artDrop').dataset.over = 'true';
const err = document.getElementById('artError');
err.textContent = 'That is not an image this app can read. Use PNG, JPG, WEBP, GIF or BMP.';
err.hidden = false;
await wait(300);
const box = document.querySelector('#artModal .modal__panel').getBoundingClientRect();
return { x: box.x - 28, y: box.y - 28, width: box.width + 56, height: box.height + 56 };
