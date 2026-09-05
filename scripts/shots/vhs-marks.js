/**
 * EVERY MARK THE SKIN GENERATES, CHECKED AGAINST THE FACE THAT MUST DRAW IT.
 *
 * The defect this exists to prevent: the skin substituted glyphs for the IBM
 * character ROM, then Home Video became the default face, and the two faces
 * turn out to have very nearly DISJOINT coverage of the geometric shapes.
 * Every substitution was therefore handing the default face a character it
 * does not own, and those marks were being drawn by whatever monospace font
 * the OS supplied — different ink height, different baseline, in rows of
 * otherwise identical buttons. That is what "the buttons are different
 * heights" was, and no rect-based check could ever see it: the boxes were
 * always identical. Only the ink differed.
 *
 * So this reads the actual generated content out of each pseudo-element and
 * asks the face, by rasterising, whether it owns each codepoint. Advance
 * width cannot answer that — a fallback face can advance the same — so the
 * glyph is drawn twice, once in the family and once in a family that cannot
 * resolve, and identical pixels mean it was never drawn by the family.
 *
 * Run for BOTH faces, because a mark that is right for one is often wrong for
 * the other. Bare statements; throws so shoot-all gates on it.
 *
 * Failing controls, both verified by hand before this was committed:
 *   - point any of the marks below back at its pre-fix codepoint (say
 *     .showctl[data-act="back"] to \25C4 under homevideo) and MISSING fires;
 *   - drop the [data-osd-face] attribute from applyFonts and every face-split
 *     rule stops matching, so the marks come back empty and EMPTY fires.
 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(600);

const sel = document.getElementById('themeSelect');
sel.value = 'vhs';
sel.dispatchEvent(new Event('change', { bubbles: true }));
await wait(800);

// A show has to be on screen for the row marks to exist at all.
const app = document.getElementById('app');
app.dataset.view = 'playing';
app.dataset.chrome = 'on';
await wait(400);

const cv = document.createElement('canvas');
cv.width = 200; cv.height = 200;
const cx = cv.getContext('2d', { willReadFrequently: true });
const raster = (ch, font) => {
  cx.clearRect(0, 0, cv.width, cv.height);
  cx.fillStyle = '#000';
  cx.font = font;
  cx.textBaseline = 'alphabetic';
  cx.fillText(ch, 24, 130);
  return cx.getImageData(0, 0, cv.width, cv.height).data.join(',');
};
const owns = (ch, family) => raster(ch, `32px "${family}"`) !== raster(ch, '32px "ZzNoSuchFace"');
const inkOf = (ch, family) => {
  cx.font = `32px "${family}"`;
  const m = cx.measureText(ch);
  return {
    h: +(m.actualBoundingBoxAscent + m.actualBoundingBoxDescent).toFixed(2),
    asc: +m.actualBoundingBoxAscent.toFixed(2),
  };
};

/** The content string CSS actually generated, unquoted, or '' if there is none. */
const contentOf = (el, pseudo) => {
  if (!el) return null;
  const raw = getComputedStyle(el, pseudo).content;
  if (!raw || raw === 'none' || raw === 'normal') return '';
  return raw.replace(/^"|"$/g, '').replace(/\\"/g, '"');
};

// Every place the skin puts a mark on screen. `row` groups the marks that sit
// side by side and therefore have to agree with each other.
const SITES = () => [
  { name: '#btnBack', el: document.getElementById('btnBack'), pseudo: '::after' },
  { name: '#btnFwd', el: document.getElementById('btnFwd'), pseudo: '::after' },
  { name: '#btnPrev', el: document.getElementById('btnPrev'), pseudo: '::after' },
  { name: '#btnNext', el: document.getElementById('btnNext'), pseudo: '::after' },
  { name: '#btnTracks', el: document.getElementById('btnTracks'), pseudo: '::after' },
  { name: '#btnFull', el: document.getElementById('btnFull'), pseudo: '::after' },
  { name: '#btnLibrary', el: document.getElementById('btnLibrary'), pseudo: '::after' },
  { name: 'osdState', el: document.getElementById('osdState'), pseudo: '::after' },
  ...['back', 'pass', 'reset', 'marathon'].map((act) => ({
    name: `.showctl[${act}]`,
    el: document.querySelector(`.showctl[data-act="${act}"]`),
    pseudo: '::after',
    row: 'showctl',
  })),
];

const FACES = [
  { cell: 0, key: 'homevideo', family: 'Home Video' },
  { cell: 1, key: 'ibm', family: 'IBM VGA 8x16' },
];

const report = {};
const failures = [];

for (const face of FACES) {
  document.getElementById('btnSettings').click();
  await wait(600);
  const cells = [...document.querySelectorAll('#vhsFontRail .osdcell')];
  if (cells.length !== 2) throw new Error(`expected two face cells, saw ${cells.length}`);
  cells[face.cell].click();
  await wait(600);
  document.getElementById('btnCloseSettings').click();
  await wait(400);

  const stamped = document.documentElement.dataset.osdFace;
  if (stamped !== face.key) {
    throw new Error(`root says data-osd-face="${stamped}" after choosing ${face.key}`);
  }
  await document.fonts.load(`32px "${face.family}"`);

  const rows = {};
  const lines = [];
  for (const site of SITES()) {
    if (!site.el) { failures.push(`${face.key} ${site.name}: not in the DOM`); continue; }
    const text = contentOf(site.el, site.pseudo);
    if (text === '') { failures.push(`${face.key} ${site.name}: EMPTY — no rule matched`); continue; }
    // A CSS escape runs up to SIX hex digits, so "\25B6" immediately followed
    // by "30" is read as \25B630 — past U+10FFFF, and the parser hands back
    // U+FFFD. It renders as a lozenge that a font-coverage check happily
    // calls present, so it needs an assertion of its own. This caught one.
    if (text.includes('�')) {
      failures.push(`${face.key} ${site.name}: REPLACEMENT CHARACTER in ${JSON.stringify(text)} — a CSS escape ran into the digits after it`);
      continue;
    }
    // ASCII is in every face; only the marks are in question.
    const marks = [...text].filter((ch) => ch.codePointAt(0) > 0x7f && ch !== ' ');
    for (const ch of marks) {
      if (!owns(ch, face.family)) {
        failures.push(`${face.key} ${site.name}: MISSING U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')} — falls back to an OS font`);
      }
    }
    if (site.row && marks.length) {
      const ink = inkOf(marks[0], face.family);
      (rows[site.row] ||= []).push({ name: site.name, ...ink });
    }
    lines.push(`${site.name}=${JSON.stringify(text)}`);
  }

  // The row she reported: four buttons in identical boxes whose marks have to
  // agree. Same face is necessary but not sufficient — check the ink too.
  for (const [row, members] of Object.entries(rows)) {
    const hs = members.map((m) => m.h);
    const as = members.map((m) => m.asc);
    const spread = Math.max(...hs) - Math.min(...hs);
    const drift = Math.max(...as) - Math.min(...as);
    if (spread > 0.5 || drift > 0.5) {
      failures.push(`${face.key} ${row}: marks do not line up — ${members.map((m) => `${m.name} h${m.h} a${m.asc}`).join(', ')}`);
    }
  }
  report[face.key] = lines.join(' ');
}

// Put the default face back so the screenshot is the one she sees.
document.getElementById('btnSettings').click();
await wait(500);
[...document.querySelectorAll('#vhsFontRail .osdcell')][0].click();
await wait(400);
document.getElementById('btnCloseSettings').click();
await wait(300);

if (failures.length) throw new Error(failures.join(' | '));
return report;
