/* The sidebar's bottom button row. Bare statements. */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(600);
const row = document.getElementById('btnBrowse').parentElement;
const box = row.getBoundingClientRect();
return { x: box.x - 12, y: box.y - 14, width: box.width + 24, height: box.height + 28 };
