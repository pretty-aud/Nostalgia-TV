/**
 * THE GAP ABOVE EACH SUB-HEADING, measured in the engine that draws it.
 *
 * This exists because the first version of the divider was an INERT GUARD. The
 * rule that stops #promoGroup resetting :first-of-type was written correctly,
 * commented carefully, and lost every cascade it entered — an id selector three
 * hundred lines further down outranked it, so Promos kept the tight margin the
 * rule was written to take away from it. Nothing threw. The stylesheet said one
 * thing and the screen said another, and reading the stylesheet could not tell
 * the difference.
 *
 * So this measures the SCREEN: the real distance from the bottom of whatever
 * precedes a sub-heading to the top of its rule. Specificity is not consulted.
 *
 * Failing control, each RUN:
 *   - put back `#settingsBody .setsub:first-of-type { margin-top: 0.5u }` and
 *     Promos drops to a fraction of its siblings' gap and this throws.
 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(700);

document.getElementById('btnSettings').click();
await wait(800);

const promos = document.getElementById('promoGroup');
if (promos) promos.hidden = false;
await wait(200);

const group = [...document.querySelectorAll('.setgroup')]
  .find((s) => s.querySelector('.setgroup__head')?.textContent.trim() === 'Bumpers');
if (!group) throw new Error('no Bumpers group');

group.scrollIntoView({ block: 'start' });
await wait(400);

/**
 * The gap that matters is the one a reader sees: from the bottom edge of the
 * previous element to the top edge of the heading's box, which is where the
 * rule is drawn. margin-top alone would miss the padding, and padding alone
 * would miss the margin — the two are split deliberately so the rule sits
 * nearer the heading than the heading sits to what came before it.
 */
/**
 * DOCUMENT ORDER, not sibling order — the first version of this used
 * previousElementSibling and measured `null` for Promos, because Promos is the
 * first child of #promoGroup and has no sibling before it. That is the same
 * wrapper that broke :first-of-type, reaching the probe this time instead of
 * the stylesheet. A measurement that cannot see the element it is comparing
 * against reports nothing and reads as a crash rather than as a gap.
 */
const order = [...group.querySelectorAll('*')];
const gapAbove = (h) => {
  for (let i = order.indexOf(h) - 1; i >= 0; i -= 1) {
    const prev = order[i];
    if (prev.contains(h)) continue;            // an ancestor is not "above" it
    const box = prev.getBoundingClientRect();
    if (box.height === 0) continue;            // hidden, or an empty note
    return Math.round(h.getBoundingClientRect().top - box.bottom);
  }
  return null;
};

const subs = [...group.querySelectorAll('.setsub')];
const measured = subs.map((h) => ({
  name: h.textContent.trim(),
  gap: gapAbove(h),
  rule: getComputedStyle(h).borderTopWidth,
  below: Math.round(parseFloat(getComputedStyle(h).marginBottom)),
}));

const first = measured[0];
const rest = measured.slice(1);

// The first sub-heading butts its section head and must NOT carry a rule: a
// rule directly under the section title divides a heading from its own body.
if (first.rule !== '0px') {
  throw new Error(`"${first.name}" opens the section and must not carry a rule — it has ${first.rule}`);
}

// Every other one must, and at a gap that agrees with its siblings. This is
// the assertion the inert guard failed.
for (const m of rest) {
  if (m.rule === '0px') throw new Error(`"${m.name}" has no rule above it`);
}
const gaps = rest.map((m) => m.gap);
const spread = Math.max(...gaps) - Math.min(...gaps);
if (spread > 6) {
  throw new Error(
    `sub-heading gaps disagree by ${spread}px — ${rest.map((m) => `${m.name}:${m.gap}`).join(', ')}`,
  );
}

// And the boundary has to read as a boundary: more space above the heading
// than below it, or the label appears to belong to what it follows.
for (const m of rest) {
  if (m.gap < m.below * 2) {
    throw new Error(`"${m.name}" has ${m.gap}px above and ${m.below}px below — a heading needs at least 2:1`);
  }
}

const box = group.getBoundingClientRect();
return {
  x: Math.max(0, box.x - 16),
  y: Math.max(0, box.y - 16),
  width: Math.min(820, box.width + 32),
  height: Math.min(860, box.height + 32),
};
