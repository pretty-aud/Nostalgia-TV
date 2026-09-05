/**
 * Which glyphs the UI uses does the character ROM actually have?
 *
 * Same measurement as the font spike: at 16px every present glyph in the 8x16
 * face advances exactly 8px, and a missing one falls back to another font and
 * measures something else. Bare statements; throws so shoot-all gates on it.
 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await document.fonts.load('16px "IBM VGA 8x16"');
await document.fonts.ready;
await wait(200);

const probe = document.createElement('span');
probe.style.cssText = 'position:fixed;left:-9999px;font-family:"IBM VGA 8x16";font-size:16px;white-space:pre';
document.body.append(probe);
const advance = (ch) => { probe.textContent = ch; return probe.getBoundingClientRect().width; };

const USED = '\u00B7\u00D7\u2014\u201C\u201D\u2026\u2190\u2192\u2500\u25A0\u25B6\u25BA\u25BE\u25C4\u2630\u26F6\u2713\u2715\u275A\u27F2';
const base = advance('A');
const present = [];
const missing = [];
for (const ch of USED) {
  const w = advance(ch);
  const label = ch + ' U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
  (Math.abs(w - base) < 0.01 ? present : missing).push(label);
}
probe.remove();

const out = { base, present: present.join(' '), missing: missing.join(' '), missingCount: missing.length };
// Informational, not a failure: the point is to KNOW, and to have replaced the
// ones that matter. Recorded so a future glyph cannot slip in unnoticed.
if (base !== 8) throw new Error('not the 8x16 ROM: advance ' + base);
return out;
