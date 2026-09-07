/**
 * THE SUB-SECTION BOUNDARIES, photographed rather than measured.
 *
 * Bumpers holds three sub-groups — Up next, Between episodes, Promos — and the
 * question this shot exists to answer is whether a person can SEE where one
 * ends and the next begins. That is not a thing the DOM can be asked; every
 * measurement of it in this project has agreed with the code and disagreed with
 * the screen. So the frame is the answer.
 *
 * It also asserts the structure, because the reason the boundaries were
 * invisible the first time was not styling: the section closed early and two of
 * the three sub-groups were siblings of it rather than children.
 *
 * Failing controls, each RUN:
 *   - restore the stray </section> after #bumperBgField and it throws "…are not
 *     inside the Bumpers section";
 *   - delete the .setsub rule's divider and the frame shows three headings with
 *     nothing between them — which is the thing being reviewed, so that one is
 *     judged by eye, not by throw.
 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(700);

document.getElementById('btnSettings').click();
await wait(800);

const group = [...document.querySelectorAll('.setgroup')]
  .find((s) => s.querySelector('.setgroup__head')?.textContent.trim() === 'Bumpers');
if (!group) {
  const heads = [...document.querySelectorAll('.setgroup__head')].map((h) => h.textContent.trim());
  throw new Error(`no Bumpers group in the settings — found: ${heads.join(', ')}`);
}

/**
 * ALL THREE, inside the group.
 *
 * This is the assertion that would have caught the broken nesting. Asking the
 * document for .setsub finds them wherever they are; asking the GROUP for them
 * is what makes the difference between "the headings exist" and "the headings
 * belong to this section".
 */
const subs = [...group.querySelectorAll('.setsub')].map((h) => h.textContent.trim());
for (const want of ['Up next', 'Between episodes', 'Promos']) {
  if (!subs.includes(want)) {
    throw new Error(`"${want}" is not inside the Bumpers section — it holds: ${subs.join(', ') || 'nothing'}`);
  }
}

// Promos hides itself when there is no PROMOS folder, and a hidden sub-group
// would make the crop below measure a box that stops short of it.
const promos = document.getElementById('promoGroup');
if (promos) promos.hidden = false;
await wait(200);

group.scrollIntoView({ block: 'start' });
await wait(500);

const box = group.getBoundingClientRect();
return {
  x: Math.max(0, box.x - 16),
  y: Math.max(0, box.y - 16),
  width: Math.min(820, box.width + 32),
  height: Math.min(860, box.height + 32),
};
