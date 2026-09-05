/**
 * STAGE 0: does the bundled character ROM actually carry the glyphs the skin
 * needs, and is it hard-edged at the sizes we intend to use?
 *
 * Glyph presence is measured, not eyeballed. An 8x16 cell at font-size 16px
 * has an advance of exactly 8px, and EVERY present glyph in a monospace face
 * has that same advance. A MISSING glyph falls back to another font, whose
 * advance is not 8. So: width === 8 means the ROM drew it.
 *
 * Bare statements; throws on failure so shoot-all gates on it.
 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await document.fonts.load('16px "IBM VGA 8x16"');
await document.fonts.ready;
await wait(300);

const out = {};
out.fontLoaded = document.fonts.check('16px "IBM VGA 8x16"');

// Measure with NO fallback in the stack, so a miss is unmistakable.
const probe = document.createElement('span');
probe.style.cssText = 'position:fixed;left:-9999px;font-family:"IBM VGA 8x16";font-size:16px;white-space:pre';
document.body.append(probe);
const advance = (ch) => { probe.textContent = ch; return probe.getBoundingClientRect().width; };

out.baselineA = advance('A');
const NEEDED = {
  'play triangle ►': '\u25BA', 'square ■': '\u25A0', 'full block █': '\u2588',
  'upper half ▀': '\u2580', 'lower half ▄': '\u2584', 'left half ▌': '\u258C',
  'double horiz ═': '\u2550', 'double vert ║': '\u2551',
  'corner ╔': '\u2554', 'corner ╝': '\u255D',
  'left tri ◄': '\u25C4', 'accented é': '\u00E9',
};
const widths = {};
const missing = [];
for (const [name, ch] of Object.entries(NEEDED)) {
  const w = advance(ch);
  widths[name] = w;
  if (Math.abs(w - out.baselineA) > 0.01) missing.push(`${name} (${w}px vs ${out.baselineA}px)`);
}
probe.remove();
out.advanceIs8 = Math.abs(out.baselineA - 8) < 0.01;
out.allGlyphsPresent = missing.length === 0;
out.missing = missing.join('; ') || 'none';

// A specimen to look at: the real thing at the three sizes the skin uses.
const stage = document.createElement('div');
stage.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#0B0BB4;color:#fff;'
  + 'font-family:"IBM VGA 8x16";padding:24px 32px;-webkit-font-smoothing:none;';
stage.innerHTML = `
  <div style="font-size:48px;line-height:56px">PLAY \u25BA</div>
  <div style="font-size:16px;line-height:24px;margin-top:8px">
    ADVANCE ${out.baselineA}px \u00b7 GLYPHS ${out.allGlyphsPresent ? 'ALL PRESENT' : 'MISSING'}
  </div>
  <div style="font-size:32px;line-height:40px;margin-top:24px;text-align:center;letter-spacing:8px">- M E N U -</div>
  <div style="font-size:32px;line-height:40px;margin-top:16px">
    <div>\u25BA TIMER PROG. SET</div>
    <div>&nbsp;&nbsp;CLOCK SET</div>
    <div>&nbsp;&nbsp;LANGUAGE SELECT</div>
  </div>
  <div style="font-size:32px;line-height:40px;margin-top:24px">
    <div>\u25A0 SAP: ON</div>
    <div>&nbsp;&nbsp;HI-FI AUDIO: OFF</div>
  </div>
  <div style="font-size:16px;line-height:24px;margin-top:24px">
    <div>16PX \u2014 COWBOY BEBOP \u00b7 S01E05 \u00b7 00:12:04 \u00b7 SP</div>
    <div>BOX \u2554\u2550\u2550\u2550\u2557 BLOCKS \u2588\u2593\u2592\u2591 HALVES \u2580\u2584\u258C ARROWS \u25C4\u25BA</div>
    <div>ACCENTS \u00e9\u00e8\u00fc\u00f1\u00e5 \u2014 TRACKING [\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2591\u2591\u2591\u2591]</div>
  </div>`;
document.body.append(stage);
await wait(500);

if (!out.fontLoaded) throw new Error('the font did not load at all');
if (!out.advanceIs8) throw new Error(`advance is ${out.baselineA}px, expected 8 — this is not the 8x16 ROM`);
if (!out.allGlyphsPresent) throw new Error(`MISSING GLYPHS: ${out.missing}`);
return out;
