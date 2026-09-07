/**
 * THE SWITCHES, in whichever theme NTV_SHOT_THEME names.
 *
 * The switch is drawn with appearance:none, which means every theme that had
 * something to say about a checkbox now has to say it again or say nothing —
 * accent-color reaches a native control only, and the VCR skin paints its own
 * box at a specificity the base rule cannot beat. Neither of those failures
 * throws, and neither is visible in the DOM: the first shows as the wrong
 * accent colour, the second as a knob floating inside a tick box. So the frame
 * is the check.
 *
 * Failing controls, each RUN:
 *   - delete the ::after suppression under [data-skin="vcr"] and the VHS frame
 *     shows a knob inside the cross box;
 *   - point --switch-on at --signal for theme 01 and its frame goes lime, which
 *     is the exact thing the comment at that rule says must not happen.
 *
 * Usage: NTV_SHOT_THEME=vhs electron scripts/shoot-state.js -- <url> <out> <this>
 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(700);

const theme = window.__shotTheme || 'midnight';
const sel = document.getElementById('themeSelect');
if (!sel) throw new Error('no theme select — cannot put the panel in a known skin');
sel.value = theme;
sel.dispatchEvent(new Event('change', { bubbles: true }));
await wait(700);

document.getElementById('btnSettings').click();
await wait(800);

// The two rows that hide themselves when the library has no bumpers or promos.
// A switch frame that silently drops half its subjects is not a check.
for (const id of ['promoGroup', 'bumperClipRow']) {
  const node = document.getElementById(id);
  if (node) node.hidden = false;
}
await wait(200);

const group = [...document.querySelectorAll('.setgroup')]
  .find((s) => s.querySelector('.setgroup__head')?.textContent.trim() === 'Bumpers');
if (!group) throw new Error('no Bumpers group to frame');

const boxes = [...group.querySelectorAll('.check input[type="checkbox"]')];
if (boxes.length < 3) {
  throw new Error(`expected the three Bumpers switches, found ${boxes.length}`);
}

/**
 * ONE ON, ONE OFF, IN FRAME.
 *
 * A photograph of three switches that all agree tells you nothing about
 * whether the off state is drawn at all — and the off state is the one that
 * goes wrong, because it is the one drawn in the faintest tokens.
 */
boxes[0].checked = true;
boxes[boxes.length - 1].checked = false;
await wait(200);

/**
 * FRAME THE SWITCHES, not the section.
 *
 * Framing the whole group put the crop ceiling above the last row — and the
 * last row is the one deliberately set OFF, so the photograph showed three
 * switches that agreed and cut off the only one under review. A frame that
 * excludes the state being tested is worse than no frame: it looks like proof.
 */
const rows = [...group.querySelectorAll('.check')];
rows[rows.length - 1].scrollIntoView({ block: 'center' });
await wait(400);

const top = rows[0].getBoundingClientRect().top;
const bottom = rows[rows.length - 1].getBoundingClientRect().bottom;
const box = group.getBoundingClientRect();
return {
  x: Math.max(0, box.x - 16),
  y: Math.max(0, top - 24),
  width: Math.min(820, box.width + 32),
  height: Math.min(860, bottom - top + 48),
};
