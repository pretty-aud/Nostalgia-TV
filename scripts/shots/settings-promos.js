// The Bumpers and Promos groups, side by side in the settings sheet, so the
// split can be judged rather than assumed from the markup.
document.getElementById('btnSettings').click();
await new Promise((r) => setTimeout(r, 700));

const promos = document.getElementById('promoGroup');
if (!promos) throw new Error('there is no promoGroup');
if (promos.hidden) throw new Error('the promos group is hidden — the stub library has no promos');

// Scroll the pair into view inside the modal body.
const bumpers = [...document.querySelectorAll('.setgroup')]
  .find((s) => (s.querySelector('.setgroup__head') || {}).textContent === 'Bumpers');
if (!bumpers) throw new Error('there is no Bumpers group');
bumpers.scrollIntoView({ block: 'start' });
await new Promise((r) => setTimeout(r, 500));

const top = bumpers.getBoundingClientRect();
const bottom = promos.getBoundingClientRect();
return { x: top.left - 16, y: top.top - 16, width: top.width + 32, height: (bottom.bottom - top.top) + 32 };
