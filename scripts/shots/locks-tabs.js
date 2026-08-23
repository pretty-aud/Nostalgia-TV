// Just the tab strip, enlarged, to settle which one reads as selected.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
document.getElementById('btnSettings').click();
await wait(400);
document.getElementById('btnOpenLocks').click();
await wait(500);
document.querySelector('#lockTabs .mode[data-kind="movie"]').click();
await wait(600);

const strip = document.getElementById('lockTabs');
const box = strip.getBoundingClientRect();
return { x: box.left - 10, y: box.top - 10, width: box.width + 20, height: box.height + 20 };
