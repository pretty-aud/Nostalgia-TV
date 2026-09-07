/**
 * CHILD EXCLUSIVE WATER RECREATION, beat one — the stand-by line.
 *
 * Photographed on its own because the capture happens after the snippet
 * returns: a snippet that walks all three beats can only ever photograph the
 * last one. This is the beat with a real reference frame to be checked
 * against, so it is the one worth having a picture of.
 *
 * Bare statements; throws so shoot-all gates on it.
 *
 * Failing controls, each RUN:
 *   - uppercase the card again and it throws "the stand-by line is set in
 *     capitals";
 *   - set it in the condensed face and it throws "the stand-by line is set
 *     condensed".
 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(500);

window.tv.mpvOpen = () => Promise.resolve();
window.__preview.settings().bumperMusicDir = 'D:/music';
window.__preview.showAdultSwimBumper(() => {}, null);
await wait(1400);

const line = document.getElementById('asbumpStandby');
if (line.hidden) throw new Error('the stand-by line never arrived');

/**
 * SENTENCE CASE, with the colon. Measured off the real frame, which reads
 * "Please stand by for your programming schedule:" — the first version of this
 * card uppercased everything, which is right for the lineup and wrong here.
 */
const shown = line.textContent.trim();
if (shown !== 'Please stand by for your programming schedule:') {
  throw new Error(`the stand-by copy does not match the reference: ${shown}`);
}
if (getComputedStyle(line).textTransform === 'uppercase') {
  throw new Error('the stand-by line is set in capitals — the reference is sentence case');
}

/**
 * REGULAR WIDTH, not condensed. The reference's letterforms here are open and
 * normal-width; the condensed face belongs to the lineup card. Getting this
 * wrong is invisible unless you are holding the two frames side by side.
 */
const face = getComputedStyle(line).fontFamily;
if (/Roboto Condensed/.test(face)) {
  throw new Error(`the stand-by line is set condensed: ${face}`);
}

// Two lines, breaking after "your" as the reference does. One line means the
// measure is too wide; three means it is too narrow.
const lines = Math.round(line.getBoundingClientRect().height
  / parseFloat(getComputedStyle(line).lineHeight));
if (lines !== 2) {
  throw new Error(`the stand-by line wraps to ${lines} lines, not the reference's 2`);
}

const box = document.getElementById('asbump').getBoundingClientRect();
return { x: box.x, y: box.y, width: box.width, height: box.height };
