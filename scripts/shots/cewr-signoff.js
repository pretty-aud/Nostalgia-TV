/**
 * CHILD EXCLUSIVE WATER RECREATION, beat three — the mark.
 *
 * Separate from the other two for the same reason they are separate from each
 * other: shoot-state captures after the snippet returns, so each beat needs
 * its own snippet to be photographed at all.
 *
 * Bare statements; throws so shoot-all gates on it.
 *
 * Failing controls, each RUN:
 *   - remove the third BEATS entry and it throws "the mark never arrived";
 *   - return the wordmark to the card and it throws "there is text on the
 *     sign-off"— she asked for the logo alone.
 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(500);

window.tv.mpvOpen = () => Promise.resolve();
window.__preview.settings().bumperMusicDir = 'D:/music';
window.__preview.showAdultSwimBumper(() => {}, null);

// Past the third beat at 12.3s, and comfortably before the card ends at 15s.
await wait(13200);

const sign = document.getElementById('asbumpSign');
if (sign.hidden) throw new Error('the mark never arrived');

const svg = sign.querySelector('svg');
if (!svg) throw new Error('the mark is empty — no svg was drawn');

// THE LOGO ALONE. No wordmark, no channel name: asked for explicitly, and a
// name under it would fight the condensed caps two beats earlier.
if (sign.textContent.trim() !== '') {
  throw new Error(`there is text on the sign-off: ${sign.textContent.trim()}`);
}

// The other two beats must be gone, or the mark is sitting over a schedule.
for (const id of ['asbumpStandby', 'asbumpSched']) {
  if (!document.getElementById(id).hidden) {
    throw new Error(`${id} is still up under the mark`);
  }
}

// Drawn at a real size rather than collapsed: an <svg> with no intrinsic size
// and no CSS width lays out at 0 and the card ends on an empty black frame.
const drawn = svg.getBoundingClientRect();
if (drawn.width < 40 || drawn.height < 40) {
  throw new Error(`the mark drew at ${Math.round(drawn.width)}x${Math.round(drawn.height)}`);
}

const box = document.getElementById('asbump').getBoundingClientRect();
return { x: box.x, y: box.y, width: box.width, height: box.height };
