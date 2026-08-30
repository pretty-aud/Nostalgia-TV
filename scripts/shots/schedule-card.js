// One order card, close up: is the remove control actually there?
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
document.getElementById('btnSchedule').click();
await wait(400);
document.querySelectorAll('#schedPool .setsched__card')[0].click();
await wait(200);

const card = document.querySelector('#schedOrder .setsched__card');
const drop = card.querySelector('.setsched__drop');
if (!drop) throw new Error('MISSING: no remove button rendered on the card');

const cs = getComputedStyle(drop);
const box = drop.getBoundingClientRect();
if (box.width < 4 || box.height < 4) throw new Error(`remove button has no size: ${box.width}x${box.height}`);
document.title = `colour=${cs.color} opacity=${cs.opacity} size=${Math.round(box.width)}x${Math.round(box.height)}`;

const b = card.getBoundingClientRect();
return { x: b.left - 8, y: b.top - 8, width: b.width + 16, height: b.height + 16 };
