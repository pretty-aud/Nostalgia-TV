/* The library table with the Genres column. Bare statements. */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
document.getElementById('btnSettings').click();
await wait(300);
document.getElementById('btnOpenMedia').click();
await wait(800);
const box = document.querySelector('#mediaModal .modal__panel').getBoundingClientRect();
return { x: box.x - 16, y: box.y - 16, width: box.width + 32, height: box.height + 32 };
