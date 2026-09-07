/**
 * RED, ON BOTH AXES.
 *
 * The VHS skin's colours are a PAIR TABLE, not two independent controls, so
 * adding red is 25 pairs rather than two values — and the pair that decides
 * whether it was done properly is red-on-red, which every same-name pair is
 * held above 7:1 for. That one cannot be saturated: luminance is dominated by
 * the green channel, so #ff0000 tops out at 0.21 and needs 0.31 to clear the
 * bar. It resolves to a pale phosphor red, exactly as green-on-green already
 * resolves to #a8f5a8 on bottle green.
 *
 * Photographs the settings sheet with both rails visible so the new chip can
 * be seen in each, with red actually in force behind them.
 *
 * Failing controls, each RUN:
 *   - remove RED from GROUNDS and the ground rail check finds four chips;
 *   - remove the red CSS pair rules and --paper stays blue with RED selected,
 *     which the ground check catches.
 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(800);

const sel = document.getElementById('themeSelect');
if (!sel) throw new Error('no theme select');
sel.value = 'vhs';
sel.dispatchEvent(new Event('change', { bubbles: true }));
await wait(900);

document.getElementById('btnSettings').click();
await wait(900);

// The two rails only exist while a skin is on.
const inkRail = document.getElementById('vhsInkRail');
const groundRail = document.getElementById('vhsGroundRail');
if (document.getElementById('vhsInkField').hidden) throw new Error('the VHS colour rails are hidden');

const chips = (rail) => [...rail.querySelectorAll('[data-key]')];
const names = (rail) => chips(rail).map((c) => c.dataset.key);

if (!names(groundRail).includes('red')) {
  throw new Error(`no RED in the background rail — it offers ${names(groundRail).join(', ')}`);
}
if (!names(inkRail).includes('red')) {
  throw new Error(`no RED in the colour rail — it offers ${names(inkRail).join(', ')}`);
}

// Choose red for the ground, then red for the ink. Order matters: the ink rail
// is rebuilt from the ground, and its swatches must follow.
chips(groundRail).find((c) => c.dataset.key === 'red').click();
await wait(600);
chips(document.getElementById('vhsInkRail')).find((c) => c.dataset.key === 'red').click();
await wait(700);

const root = document.documentElement;
if (root.dataset.osdGround !== 'red') {
  throw new Error(`the ground did not take: data-osd-ground is "${root.dataset.osdGround}"`);
}
if (root.dataset.osdInk !== 'red') {
  throw new Error(`the ink did not take: data-osd-ink is "${root.dataset.osdInk}"`);
}

/**
 * THE PAIR HAS TO REACH THE PAGE, not just the attributes. The CSS table is a
 * hand-written second copy of vhsPalette.js; a missing rule leaves --paper on
 * whatever the previous ground set, and the attributes would still read "red".
 */
const cs = getComputedStyle(root);
const paper = cs.getPropertyValue('--paper').trim().toLowerCase();
const ink = cs.getPropertyValue('--ink').trim().toLowerCase();
if (paper !== '#3a050a') throw new Error(`--paper is "${paper}", not the red ground`);
if (ink !== '#ff8f8f') throw new Error(`--ink is "${ink}", not the red-on-red ink`);

/**
 * SCROLL TO THEM FIRST. The rails sit far down the Interface section, so their
 * rect was y=2033 in an 880px window — a capture rectangle entirely outside
 * the viewport, which does not error, it just never resolves. The run timed
 * out and wrote no file while the snippet itself reported success.
 */
document.getElementById('vhsInkField').scrollIntoView({ block: 'center' });
await wait(500);

const field = document.getElementById('vhsInkField').getBoundingClientRect();
const ground = document.getElementById('vhsGroundField').getBoundingClientRect();
const top = Math.max(0, Math.round(field.top) - 80);
return {
  x: 0,
  y: top,
  width: Math.round(window.innerWidth),
  // Clamped to what is actually on screen, so the rect can never leave it.
  height: Math.round(Math.min(window.innerHeight - top, (ground.bottom - field.top) + 140)),
};
