/**
 * CHILD EXCLUSIVE WATER RECREATION, at its second beat — the schedule.
 *
 * Three beats have to be checked separately, because each one is the whole
 * screen and a card stuck on beat one looks exactly like a card that is simply
 * slow. The shot lands on the schedule; the assertions walk all three.
 *
 * Bare statements; throws so shoot-all gates on it.
 *
 * Failing controls, each RUN:
 *   - remove the BEATS entry that reveals the schedule and it throws "the
 *     schedule never arrived";
 *   - remove the mpvOpen call and it throws "no music was asked for";
 *   - remove `app.dataset.bumperStyle` and it throws "the still card is
 *     showing underneath";
 *   - delete the `.asbump[hidden]` rule and it throws "the card is on screen
 *     before it was asked for".
 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(600);

const card = document.getElementById('asbump');
if (!card) throw new Error('no card in the markup');

/**
 * BEFORE anything asks for it, the card must not be drawn. `.asbump` sets
 * display:grid, which outranks the UA's [hidden] rule at element specificity —
 * so without an explicit .asbump[hidden] rule this section covers the whole
 * app permanently, and every other shot would be a black rectangle.
 */
if (card.getBoundingClientRect().height > 0) {
  throw new Error('the card is on screen before it was asked for — is .asbump[hidden] missing?');
}

// Record what the card asks mpv for, without needing a player.
const asked = [];
const realOpen = window.tv.mpvOpen;
window.tv.mpvOpen = (absPath, options) => { asked.push({ absPath, options }); return Promise.resolve(); };

document.getElementById('btnSettings').click();
await wait(500);
const picker = document.getElementById('bumperStyleSelect');
picker.value = 'cewr';
picker.dispatchEvent(new Event('change', { bubbles: true }));
await wait(300);

/**
 * The folder is normally set by a dialog, which a probe cannot open. Writing
 * the setting directly is the ONLY way in — and it is safe here because the
 * stub's nextBumperMusic answers regardless of the path.
 */
window.__preview.settings().bumperMusicDir = 'D:/music';
// btnSettings is bound to openSettings, NOT a toggle — clicking it again just
// reopens the panel, and the card then runs underneath a modal while every
// assertion still passes. Close it the way the close button does.
document.getElementById('btnCloseSettings').click();
await wait(300);

window.__preview.showAdultSwimBumper(() => {}, null);
await wait(900);

if (!asked.length) throw new Error('no music was asked for — mpvOpen was never called');
if (!Number.isFinite(asked[0].options && asked[0].options.startSeconds)) {
  throw new Error(`music was asked for without a start offset: ${JSON.stringify(asked[0])}`);
}

// ── beat one: please stand by ────────────────────────────────────────────
if (document.getElementById('asbumpStandby').hidden) {
  throw new Error('the stand-by line never arrived');
}
if (!document.getElementById('asbumpSched').hidden) {
  throw new Error('the schedule arrived on top of the stand-by line');
}

// ── beat two: the schedule ───────────────────────────────────────────────
await wait(4200);
const sched = document.getElementById('asbumpSched');
if (sched.hidden) throw new Error('the schedule never arrived');
if (!document.getElementById('asbumpStandby').hidden) {
  throw new Error('the stand-by line is still up under the schedule');
}
const rows = sched.querySelectorAll('.asbump__row');
if (rows.length === 0) throw new Error('the schedule has no rows');

/**
 * IS IT ACTUALLY ON SCREEN?
 *
 * getBoundingClientRect measures layout, not visibility — it returns the same
 * box whether the card is the top thing on screen or buried under a modal.
 * The first run of this probe passed every assertion below while
 * photographing the settings panel, because the card was laid out perfectly
 * well underneath it. Hit-testing the centre point is the question that was
 * actually being asked.
 */
const atCentre = document.elementFromPoint(
  Math.round(window.innerWidth / 2), Math.round(window.innerHeight / 2),
);
if (!card.contains(atCentre)) {
  throw new Error('something is on top of the card: '
    + (atCentre ? (atCentre.id || atCentre.className || atCentre.tagName) : 'nothing'));
}

/**
 * The still card must NOT be underneath. Both cards share data-view="bumper"
 * so that the keyboard-ownership rule applies to either, which means the only
 * thing keeping the old card out of the way is the style attribute.
 */
const still = document.getElementById('bumper');
if (still.getBoundingClientRect().height > 0) {
  throw new Error('the still card is showing underneath — is data-bumper-style set?');
}

// Type: the whole reference rests on a condensed bold, and the app's own
// faces cannot be condensed. Falling back to Inter here would be silent.
const face = getComputedStyle(rows[0]).fontFamily;
if (!/Roboto Condensed/.test(face)) {
  throw new Error(`the rows are not set in the condensed face: ${face}`);
}

/**
 * The crop is derived from the CARD, never a fixed size.
 *
 * shoot-state's window is not the size its arguments suggest — measured at
 * 1930x1325 CSS pixels at a device ratio of 1.5. A hard-coded 1280x860 from
 * the origin cropped the top-left two-thirds of the screen, which put
 * perfectly centred content in the bottom-right corner of the picture and
 * looked exactly like a layout bug. Beat three is photographed by
 * cewr-signoff.js: the capture happens after this snippet returns, so a
 * snippet that walks to the end can only ever photograph the end.
 */
window.tv.mpvOpen = realOpen;
const box = card.getBoundingClientRect();
return {
  x: box.x, y: box.y, width: box.width, height: box.height,
};
