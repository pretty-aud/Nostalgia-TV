/**
 * THE PANEL AS A WHOLE — the "it's looking a bit busy" shot.
 *
 * Every other settings probe in this folder frames ONE group, which is exactly
 * how a panel gets busy without anyone noticing: each section is fine on its
 * own and the pile is not. This one frames the modal, so the thing under review
 * is the density rather than any single control.
 *
 * Not gated in shoot-all: it is a review frame, not an assertion. It throws
 * only if the panel will not open at all, because a shot of a closed modal is a
 * black rectangle that reads as "no changes" rather than as a failure.
 *
 * Usage: pass the section name as NTV_SHOT_SECTION to frame one region, or
 * leave it unset for the whole sheet.
 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(700);

document.getElementById('btnSettings').click();
await wait(800);

const panel = document.querySelector('#settingsModal .modal__panel');
if (!panel) throw new Error('the settings panel did not open');

// Promos and the movie group hide themselves when the library has neither, and
// a review frame that silently drops two sub-groups is reviewing a panel the
// user does not have.
for (const id of ['promoGroup', 'movieGroup', 'presentationRow', 'bumperClipRow']) {
  const node = document.getElementById(id);
  if (node) node.hidden = false;
}
await wait(200);

const body = document.getElementById('settingsBody');
const want = ['Subtitles', 'Rotation', 'Schedules'];
const first = [...body.querySelectorAll('.setgroup')]
  .find((s) => want.includes(s.querySelector('.setgroup__head')?.textContent.trim()));
if (first) {
  first.scrollIntoView({ block: 'start' });
  await wait(400);
}

const box = panel.getBoundingClientRect();
return {
  x: Math.max(0, box.x),
  y: Math.max(0, box.y),
  width: Math.min(1000, box.width),
  height: Math.min(880, box.height),
};
