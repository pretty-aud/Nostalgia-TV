/**
 * THE TRANSPORT AT A WINDOW SMALL ENOUGH TO BREAK IT.
 *
 * Every other probe runs at shoot-state's default 1280x880, which is why the
 * defect this guards was found by a person and not by the suite: .ctl is a
 * fixed 34px tall and its label was free to wrap, so under the skin's 16px
 * ALL CAPS the second line of BACK TO CHANNEL, AUDIO, PREV and NEXT rendered
 * below their own borders — 39px of content in a 30px box. shoot-all runs
 * this one at 980x720 (see SIZES there).
 *
 * The measurements are structural rather than visual: a label that has broken
 * out of its box has scrollHeight greater than clientHeight, and a row that
 * has run off the screen has scrollWidth greater than clientWidth. Neither
 * needs a human to look at a picture.
 *
 * Failing controls, each one RUN against this probe rather than reasoned
 * about. The first draft of this comment named two, and BOTH of them passed:
 *   - remove `flex-wrap: wrap` from the skin's .transport and the controls
 *     are squeezed again, so the labels leave their boxes SIDEWAYS:
 *     "btnBrowseLeave(104x30 in 65x30), btnTracks, btnPrev, btnNext" — the
 *     same four the user reported. Note the direction: with nowrap in force
 *     they overflow horizontally, not downward, which is why checking only
 *     scrollHeight left this probe green while the bug was present.
 *   - remove `white-space: nowrap` and .upnext sets two lines instead of
 *     being clipped, taking the row to three: "the transport has spread to 3
 *     rows (114px)". That rule does NOT prevent any spill — measured at 980,
 *     720, 620 and 520 — and the stylesheet says so.
 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(700);
const sel = document.getElementById('themeSelect');
sel.value = 'vhs';
sel.dispatchEvent(new Event('change', { bubbles: true }));
await wait(800);

const app = document.getElementById('app');
app.dataset.view = 'playing';
app.dataset.chrome = 'on';
// Library mode, so the way back to the channel is on the row too — it is the
// widest control and the one that broke first.
app.dataset.browsing = 'true';
document.getElementById('timeLabel').textContent = '1:11 / 21:31';
// An EMPTY up-next is what stopped the first attempt at this reproducing, and
// a SHORT one leaves the ellipsis untested — at this width it simply fits.
document.getElementById('chromeUpNext').textContent = 'Next: Afro Samurai Resurrection S01E02 · The Sword That Cuts The Sky';
await wait(700);

const transport = document.querySelector('.transport');
if (!transport) throw new Error('no .transport');

const controls = [...transport.querySelectorAll('button')];
if (controls.length < 6) throw new Error(`only ${controls.length} transport controls`);

// A label can leave its box in EITHER direction, and which one depends on
// whether it is allowed to wrap. Wrapping text in a fixed-height button spills
// downward past the border; non-wrapping text in a squeezed button spills
// sideways. Both are the same defect and both have to be caught, which the
// first version of this probe learned the hard way: it checked only the
// vertical case, so removing the wrap rule left it green.
const spilling = controls
  .filter((el) => el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1)
  .map((el) => `${el.id || el.className}(${el.scrollWidth}x${el.scrollHeight} in ${el.clientWidth}x${el.clientHeight})`);
if (spilling.length) {
  throw new Error(`labels rendering outside their box: ${spilling.join(', ')}`);
}

if (transport.scrollWidth > transport.clientWidth + 1) {
  throw new Error(`the row overflows: scrollWidth ${transport.scrollWidth} vs clientWidth ${transport.clientWidth}`);
}

// Nothing may sit outside the window on either side.
const box = transport.getBoundingClientRect();
for (const el of controls) {
  const r = el.getBoundingClientRect();
  if (r.left < box.left - 1 || r.right > box.right + 1) {
    throw new Error(`${el.id || el.className} is outside the row: ${Math.round(r.left)}..${Math.round(r.right)} vs ${Math.round(box.left)}..${Math.round(box.right)}`);
  }
}

// The up-next title must stay on ONE line and be clipped, not set two lines
// inside the row. This is what white-space: nowrap is actually for.
const up = document.getElementById('chromeUpNext');
if (up && up.textContent.trim()) {
  const lines = up.getClientRects().length;
  if (lines > 1) throw new Error(`the up-next title is setting ${lines} lines instead of being clipped`);
}

// It is allowed to become two rows here — that is the fix — but it must not
// grow without bound, and .chrome__bottom must be able to hold it.
const rows = Math.round(box.height / 44);
if (rows > 2) throw new Error(`the transport has spread to ${rows} rows (${box.height}px)`);

const chrome = document.querySelector('.chrome__bottom');
if (chrome && chrome.scrollHeight > chrome.clientHeight + 1) {
  throw new Error('the chrome cannot hold the reflowed transport');
}

return {
  x: box.x - 8,
  y: box.y - 10,
  width: Math.min(window.innerWidth - Math.max(0, box.x - 8), box.width + 16),
  height: box.height + 20,
};
