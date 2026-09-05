/**
 * The OSD corners over the picture, and the ■ on enabled toggles.
 * Bare statements; throws on failure so shoot-all gates on it.
 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(700);
const sel = document.getElementById('themeSelect');
sel.value = 'vhs'; sel.dispatchEvent(new Event('change', { bubbles: true }));
await wait(800);

const app = document.getElementById('app');
app.dataset.view = 'playing';
app.dataset.chrome = 'on';
document.getElementById('npShow').textContent = 'Cowboy Bebop';
document.getElementById('npCode').textContent = 'S01E05';
document.getElementById('npTitle').textContent = 'Ballad of Fallen Angels';
document.getElementById('timeLabel').textContent = '12:04 / 24:31';
document.getElementById('chromeUpNext').textContent = 'Next: Trigun S01E04';
document.getElementById('scrubFill').style.width = '49%';
document.getElementById('osdClock').textContent = '00:12:04';
await wait(600);

const osd = document.querySelector('.osd');
const seen = getComputedStyle(osd).display;
if (seen === 'none') throw new Error('the OSD is not drawn under the skin');
const st = document.getElementById('osdState').getBoundingClientRect();
const ct = document.querySelector('.osd__count').getBoundingClientRect();
if (st.width === 0 || ct.width === 0) throw new Error('OSD corners have no box');
// It must sit inside the picture, not off the edge.
if (st.left < 8 || ct.right > window.innerWidth - 8) throw new Error('OSD outside the title-safe area');

// The OSD line and the app's own header must not share a row.
const np = document.querySelector('.nowplaying').getBoundingClientRect();
if (st.bottom > np.top + 1) throw new Error(`PLAY overlaps the title: osd bottom ${Math.round(st.bottom)} vs title top ${Math.round(np.top)}`);
const sp = document.querySelector('.osd__speed').getBoundingClientRect();
const lib = document.getElementById('btnLibrary').getBoundingClientRect();
if (sp.bottom > lib.top + 1) throw new Error('SP overlaps the library button');


// The date corner is gone; the counter is not. A placeholder that could
// never fill in was removed, and this is what stops it coming back.
if (document.querySelector('.osd__date')) throw new Error('the --/--/-- placeholder is back');
if (!document.getElementById('osdClock')) throw new Error('the tape counter went with it');

/**
 * The play and pause marks must be THE SAME SIZE IN THE SAME PLACE.
 *
 * This used to assert the ::after's font-size, which measured the wrong
 * thing twice over: a big font-size does not make a big mark (a triangle and
 * a block element put down wildly different ink at one size), and the mark is
 * now drawn geometry with no type in it at all. So read the box.
 *
 * Failing control: revert the mark to generated text and width/height resolve
 * to 'auto', parseFloat gives NaN, and every comparison below throws.
 */
const pb = document.getElementById('btnPlay');
const pr = pb.getBoundingClientRect();
if (getComputedStyle(pb).justifyContent !== 'center') throw new Error('play mark not centred');
if (pr.width < 56 || pr.height < 40) throw new Error('play button is ' + Math.round(pr.width) + 'x' + Math.round(pr.height));

const markBox = () => {
  const s = getComputedStyle(pb, '::after');
  return { w: parseFloat(s.width), h: parseFloat(s.height), paint: s.backgroundImage + '|' + s.clipPath };
};
pb.dataset.playing = 'false';
await wait(120);
const play = markBox();
pb.dataset.playing = 'true';
await wait(120);
const pause = markBox();
pb.dataset.playing = 'false';

if (!(play.w >= 20 && play.h >= 22)) throw new Error(`play mark is only ${play.w}x${play.h}`);
if (play.w !== pause.w || play.h !== pause.h) {
  throw new Error(`play and pause marks differ: ${play.w}x${play.h} vs ${pause.w}x${pause.h}`);
}
// ...but they must still LOOK different, or the button stops reporting state.
if (play.paint === pause.paint) throw new Error('play and pause draw the same mark');

/**
 * THE TICK BOX IS THE SKIN'S OWN, and carries the state exactly once.
 *
 * This used to assert a \u25A0 drawn in the LABEL beside the checkbox \u2014 which was
 * true and still missed the defect, because the native checkbox was sitting
 * there the whole time drawing its own white rounded box and its own tick.
 * One piece of state, two indicators, one of them Windows'. So the assertions
 * are now: the native control is gone, the box is square, the mark is drawn
 * only when checked, and nothing draws a second marker in the label.
 */
document.getElementById('btnSettings').click();
await wait(800);
const boxes = [...document.querySelectorAll('.check input[type="checkbox"]')];
if (boxes.length < 2) throw new Error('no checkboxes to test');
boxes[0].checked = true;
boxes[1].checked = false;
await wait(200);
const boxStyle = (input) => getComputedStyle(input);
const onBox = boxStyle(boxes[0]);
const offBox = boxStyle(boxes[1]);
if (onBox.appearance !== 'none') throw new Error(`the native checkbox is still being drawn: appearance ${onBox.appearance}`);
if (parseFloat(onBox.borderTopLeftRadius) !== 0) throw new Error('the tick box has rounded corners');
if (parseFloat(onBox.width) < 18 || parseFloat(onBox.height) < 18) throw new Error(`tick box is ${onBox.width}x${onBox.height}`);
// The cross is two crossed gradients, so a ticked box has two background
// layers and an unticked one has none. Failing control: revert to a glyph and
// backgroundImage stays 'none' in both states, so the first check throws.
const layers = (s) => (s.backgroundImage === 'none' ? 0 : s.backgroundImage.split('gradient(').length - 1);
if (layers(onBox) !== 2) throw new Error(`a ticked box draws ${layers(onBox)} gradient layers, expected 2`);
if (layers(offBox) !== 0) throw new Error('an unticked box is drawing a mark');
const labelMark = (input) => getComputedStyle(input.nextElementSibling, '::before').content;
for (const b of boxes.slice(0, 2)) {
  const m = labelMark(b);
  if (m.includes('\u25A0')) throw new Error(`the label still draws a second marker: ${m}`);
}
document.getElementById('btnCloseSettings').click();
await wait(300);
