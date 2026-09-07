/**
 * THE UP NEXT SETTINGS GROUP — that it exists, and that its fields follow the
 * style rather than sitting there regardless.
 *
 * Bare statements; throws so shoot-all gates on it.
 *
 * Failing controls, each RUN:
 *   - delete the <section> and it throws "no Up next group in the settings";
 *   - drop the group from the nav rail markup and it throws "the Up next group
 *     is not in the settings navigation";
 *   - stop building options from BUILTIN_STYLES and it throws "the style
 *     picker is empty";
 *   - INVERT the hide test in renderSettings and it throws "the duration field
 *     is hidden for a style that asked for it". Deleting that loop outright is
 *     NOT the control — with nothing hiding anything the field stays visible
 *     and this passes, which is exactly the kind of check that reads as proof
 *     and is not.
 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(700);

document.getElementById('btnSettings').click();
await wait(800);

/**
 * UP NEXT IS A SUB-HEADING NOW, not a section.
 *
 * It was its own group until the three interstitial sections were merged into
 * Bumpers, and this shot went on asking for a .setgroup__head that no longer
 * existed — red on every run of shoot-all, for a rename rather than a fault.
 * Which is the failure a stale probe always has: it stops reporting on the app
 * and starts reporting on itself.
 */
const heads = [...document.querySelectorAll('.setgroup__head')].map((h) => h.textContent.trim());
if (!heads.includes('Bumpers')) {
  throw new Error(`no Bumpers group in the settings — found: ${heads.join(', ')}`);
}
const subs = [...document.querySelectorAll('.setsub')].map((h) => h.textContent.trim());
if (!subs.includes('Up next')) {
  throw new Error(`no Up next sub-heading in the settings — found: ${subs.join(', ')}`);
}

/**
 * The rail is the reason this group is permanent rather than appearing with
 * the style, so it is worth asserting the group actually reaches it. It is
 * Bumpers that reaches the rail — the rail reads .setgroup__head only, which
 * is exactly what lets three sub-groups share one entry.
 */
const rail = [...document.querySelectorAll('#setNav button')].map((b) => b.textContent.trim());
if (!rail.includes('Bumpers')) {
  throw new Error(`the Bumpers group is not in the settings navigation — rail: ${rail.join(', ')}`);
}

const picker = document.getElementById('bumperStyleSelect');
if (!picker) throw new Error('no style picker');
if (picker.options.length === 0) {
  throw new Error('the style picker is empty — options are not being built from BUILTIN_STYLES');
}

/**
 * The still style asks for the duration control, so it must be VISIBLE. The
 * swap itself cannot be photographed until a second style exists; what can be
 * checked now is that the hide loop does not hide a field its own style
 * requested, which is the way that loop fails.
 */
const duration = document.getElementById('bumperField');
if (!duration) throw new Error('no duration field');
if (duration.hidden) {
  throw new Error('the duration field is hidden for a style that asked for it');
}

// Bring the group into view so the crop lands on it rather than on whatever
// happens to be scrolled to the top of a long settings panel.
const group = [...document.querySelectorAll('.setgroup')]
  .find((s) => s.querySelector('.setgroup__head')?.textContent.trim() === 'Bumpers');
group.scrollIntoView({ block: 'center' });
await wait(500);

const box = group.getBoundingClientRect();
return {
  x: Math.max(0, box.x - 12),
  y: Math.max(0, box.y - 12),
  width: Math.min(760, box.width + 24),
  height: Math.min(420, box.height + 24),
};
