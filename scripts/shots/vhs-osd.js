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

/**
 * The ■ marker on switched-on rows, read from the generated content rather
 * than looked for by eye.
 */

// The play mark must be big and CENTRED in its button — it sat small and
// off to one side, because the substitution replaced the text the button was
// aligned around.
const pb = document.getElementById('btnPlay');
const pr = pb.getBoundingClientRect();
const gs = getComputedStyle(pb, '::after');
const glyph = parseFloat(gs.fontSize);
if (glyph < 24) throw new Error('play glyph is only ' + glyph + 'px');
if (getComputedStyle(pb).justifyContent !== 'center') throw new Error('play glyph not centred');
if (pr.width < 56 || pr.height < 40) throw new Error('play button is ' + Math.round(pr.width) + 'x' + Math.round(pr.height));

document.getElementById('btnSettings').click();
await wait(800);
const boxes = [...document.querySelectorAll('.check input[type="checkbox"]')];
if (boxes.length < 2) throw new Error('no checkboxes to test');
const markOf = (input) => getComputedStyle(input.nextElementSibling, '::before').content;
boxes[0].checked = true;
boxes[1].checked = false;
await wait(200);
const on = markOf(boxes[0]);
const off = markOf(boxes[1]);
if (!on.includes('\u25A0')) throw new Error(`a switched-on row has no square: ${on}`);
if (off.includes('\u25A0')) throw new Error(`a switched-off row has a square: ${off}`);
// The slot must be reserved either way, or ticking one shoves its label.
if (off === 'none' || off === 'normal') throw new Error(`no reserved slot when off: ${off}`);
document.getElementById('btnCloseSettings').click();
await wait(300);
