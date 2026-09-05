/* The tag picker open on a show row, mid-typing. Bare statements. */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
document.getElementById('btnSettings').click();
await wait(300);
document.getElementById('btnOpenMedia').click();
await wait(800);
document.querySelectorAll('#mediaRows .genrecell')[1].click();
await wait(400);
const input = document.getElementById('tagPopInput');
input.value = 'a';
input.dispatchEvent(new Event('input', { bubbles: true }));
await wait(300);
const box = document.getElementById('tagPop').getBoundingClientRect();
return { x: box.x - 24, y: box.y - 24, width: box.width + 48, height: box.height + 48 };
