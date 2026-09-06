/**
 * The detail panel says what the file IS before you press play.
 *
 * Resolution, the audio languages, and a CC badge when it carries subtitles.
 * All three come from one probe of ONE episode — a season is encoded as a set,
 * and reading twenty-six files off an external drive to print one line would
 * be twenty-six reads for an answer that does not vary.
 *
 * Bare statements; throws so shoot-all gates on it.
 *
 * Failing controls, both RUN:
 *   - drop the showMediaSummary() call from openDetail and the row stays
 *     hidden: "the media line never appeared";
 *   - return a summary with hasSubtitles false and the badge stays hidden,
 *     which is the assertion below it.
 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(700);

// Into the library, then open the first SHOW tile. Not a rail card: the rail
// is "continue watching" and its cards resume playback rather than opening
// the panel, and not a movie either — a movie plays on click and has no panel.
document.getElementById('btnBrowse').click();
await wait(900);
const card = document.querySelector('.tiles .tile');
if (!card) throw new Error('no library tiles to open');
card.click();
await wait(900);

const panel = document.getElementById('browseDetail');
if (panel.hidden) throw new Error('the detail panel did not open');

// The probe is asynchronous on purpose — the panel opens instantly and this
// line fills in. Give it a beat before deciding it never came.
const row = document.getElementById('detailMedia');
for (let i = 0; i < 20 && row.hidden; i += 1) await wait(100);
if (row.hidden) throw new Error('the media line never appeared');

const text = document.getElementById('detailMediaText').textContent.trim();
if (!text) throw new Error('the media line is empty');

// A resolution shorthand, and at least one language.
if (!/\b(4K|\d{3,4}p|\d+×\d+)\b/.test(text)) {
  throw new Error(`no resolution in the media line: "${text}"`);
}
if (!/·/.test(text)) {
  throw new Error(`the media line names no audio: "${text}"`);
}

const cc = document.getElementById('detailCC');
if (cc.hidden) throw new Error('the fixture has subtitles but no CC badge is shown');
if (cc.textContent.trim() !== 'CC') throw new Error(`the badge reads "${cc.textContent}"`);
if (!cc.title) throw new Error('the CC badge has no tooltip naming the subtitle languages');

// The badge must be ASCII. Every Unicode subtitle mark is a glyph a face has
// to carry, and the VHS skin's two faces have nearly disjoint coverage of
// exactly that kind of symbol — this is the rule that keeps it safe there.
if (/[^\x20-\x7e]/.test(cc.textContent)) {
  throw new Error(`the CC badge is not ASCII: ${JSON.stringify(cc.textContent)}`);
}

// And it must read in the VHS skin too, where the badge borders itself.
const sel = document.getElementById('themeSelect');
sel.value = 'vhs';
sel.dispatchEvent(new Event('change', { bubbles: true }));
await wait(800);
const box = cc.getBoundingClientRect();
if (box.width < 8 || box.height < 8) {
  throw new Error(`the CC badge collapsed under the skin: ${Math.round(box.width)}x${Math.round(box.height)}`);
}
const panelBox = document.querySelector('.detail__panel').getBoundingClientRect();
if (box.right > panelBox.right + 1) throw new Error('the CC badge is outside the panel');

const hero = document.querySelector('.detail__head').getBoundingClientRect();
return { x: hero.x - 12, y: hero.y - 12, width: Math.min(560, hero.width + 24), height: hero.height + 24 };
