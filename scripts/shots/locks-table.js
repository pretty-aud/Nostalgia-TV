// The play-order table on the Movies tab, with a sequel locked behind its
// predecessor — the case the whole feature exists for.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

document.getElementById('btnSettings').click();
await wait(400);
document.getElementById('btnOpenLocks').click();
await wait(500);

document.querySelector('#lockTabs .mode[data-kind="movie"]').click();
await wait(400);

const rowFor = (name) => [...document.querySelectorAll('#lockRows tr')]
  .find((r) => r.querySelector('.lockrow__name').textContent === name);

const sequel = rowFor('Star Wars Clone Wars Vol 2');
if (!sequel) throw new Error('the sequel is not in the table');
const select = sequel.querySelector('select');
const option = [...select.options].find((o) => o.text === 'Star Wars Clone Wars Vol 1');
if (!option) throw new Error('the first film is not offered as a prerequisite');
select.value = option.value;
select.dispatchEvent(new Event('change', { bubbles: true }));
await wait(500);

// And one waiting on a series, to show both shapes at once.
const bebop = rowFor("Cowboy Bebop - The Movie - Knockin' on Heaven's Door");
if (bebop) {
  const s = bebop.querySelector('select');
  const o = [...s.options].find((x) => x.text === 'Cowboy Bebop');
  if (o) { s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); await wait(500); }
}

if (!document.querySelector('#lockRows tr.lockrow--locked')) {
  throw new Error('nothing ended up locked, so there is nothing to photograph');
}

const panel = document.querySelector('#locksModal .modal__panel');
const box = panel.getBoundingClientRect();
return { x: box.left - 8, y: box.top - 8, width: box.width + 16, height: box.height + 16 };
