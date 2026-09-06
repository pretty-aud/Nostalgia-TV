/**
 * THE OPEN DROPDOWN, IN EVERY THEME.
 *
 * A select's popup is a native window: it paints its own background and then
 * draws the options in whatever colour they carry. Every dark theme handed it
 * a near-white ink with no background of its own, so the list came out white
 * on white — 26 of the 35 themes measured between 1.00:1 and 1.28:1 against
 * that white, including the one she was using when she reported it.
 *
 * Nothing in the rendered page looks wrong when this breaks. The closed
 * control is perfect; the popup is not part of the page, so no screenshot can
 * contain it and no pixel probe can see it. It has to be asserted from the
 * computed values, and it has to be asserted for EVERY theme — the first
 * attempt at this fix was scoped to one skin, and the other 34 stayed broken.
 *
 * Failing control, run: delete the `option` rule from styles.css and this
 * throws on the first dark theme with "no background of its own".
 *
 * Bare statements; throws so shoot-all gates on it.
 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(600);

const sel = document.getElementById('themeSelect');
const themes = [...sel.options].map((o) => o.value);
if (themes.length < 10) throw new Error(`only ${themes.length} themes to check`);

const channels = (colour) => {
  const parts = colour.match(/[\d.]+/g);
  if (!parts || parts.length < 3) return null;
  // color(srgb r g b) gives 0..1; rgb() gives 0..255. Tell them apart by the
  // function name rather than by guessing from the magnitudes.
  const scale = colour.startsWith('color(') ? 1 : 255;
  return parts.slice(0, 3).map(Number).map((v) => {
    const s = v / scale;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
};
const luminance = (colour) => {
  const c = channels(colour);
  return c ? 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] : null;
};
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)];
  if (x === null || y === null) return null;
  const [hi, lo] = x > y ? [x, y] : [y, x];
  return (hi + 0.05) / (lo + 0.05);
};

const failures = [];
const report = {};

for (const theme of themes) {
  sel.value = theme;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(140);

  // Every select in the sheet, not just one: a rule scoped to a single id
  // would otherwise pass while the rest of the app stayed unreadable.
  const options = [...document.querySelectorAll('select')]
    .map((s) => s.options[0])
    .filter(Boolean);
  if (!options.length) { failures.push(`${theme}: no options anywhere`); continue; }

  for (const option of options) {
    const style = getComputedStyle(option);
    const bg = style.backgroundColor;
    const fg = style.color;
    const owner = option.parentElement.id || option.parentElement.className || 'select';

    /**
     * Transparent means the OS paints its own, and then the measurement below
     * is against a colour this app never chose.
     *
     * Read the ALPHA, do not pattern-match the string: the first version of
     * this used /rgba?\([^)]*?,\s*0\s*\)/ and flagged three themes whose paper
     * is pure black, because "rgb(0, 0, 0)" also ends in ", 0)". A colour is a
     * value, not text.
     */
    const parts = bg.match(/[\d.]+/g) || [];
    const alpha = bg === 'transparent' ? 0 : (parts.length >= 4 ? Number(parts[3]) : 1);
    if (alpha < 0.99) {
      failures.push(`${theme} #${owner}: options have no background of their own (${bg})`);
      break;
    }
    const ratio = contrast(fg, bg);
    if (ratio === null) { failures.push(`${theme} #${owner}: could not read ${fg} on ${bg}`); break; }
    if (ratio < 4.5) {
      failures.push(`${theme} #${owner}: ${ratio.toFixed(2)}:1 — ${fg} on ${bg}`);
      break;
    }
    report[theme] = `${ratio.toFixed(1)}:1`;
  }
}

sel.value = 'midnight';
sel.dispatchEvent(new Event('change', { bubbles: true }));
await wait(300);

if (failures.length) throw new Error(`${failures.length} theme(s) unreadable: ${failures.slice(0, 6).join(' | ')}`);
return { themes: themes.length, worst: Object.entries(report).sort((a, b) => parseFloat(a[1]) - parseFloat(b[1]))[0] };
