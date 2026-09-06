/**
 * The two colour rails: present with the skin, and every pair actually
 * repaints the interface. Bare statements; throws on failure.
 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = {};
const root = document.documentElement;
const tok = (n) => getComputedStyle(root).getPropertyValue(n).trim();

await wait(700);
document.getElementById('btnSettings').click();
await wait(600);
out.hiddenWithoutSkin = document.getElementById('vhsInkField').hidden
  && document.getElementById('vhsGroundField').hidden;

const sel = document.getElementById('themeSelect');
sel.value = 'vhs'; sel.dispatchEvent(new Event('change', { bubbles: true }));
await wait(800);
out.shownWithSkin = !document.getElementById('vhsInkField').hidden;
out.defaultPair = `${root.dataset.osdInk} on ${root.dataset.osdGround}`;
out.defaultIsWhiteOnBlue = root.dataset.osdInk === 'white' && root.dataset.osdGround === 'blue';
out.inkCells = document.querySelectorAll('#vhsInkRail .osdcell').length;
out.groundCells = document.querySelectorAll('#vhsGroundRail .osdcell').length;
out.chipsDrawn = document.querySelectorAll('#vhsInkRail .osdcell__chip').length === 4;

// Walk all sixteen pairs and record what each resolves to.
const pairs = {};
for (const g of ['blue', 'black', 'green', 'white']) {
  const gc = [...document.querySelectorAll('#vhsGroundRail .osdcell')].find((c) => c.dataset.key === g);
  gc.click();
  await wait(280);
  for (const i of ['white', 'blue', 'green', 'orange']) {
    const ic = [...document.querySelectorAll('#vhsInkRail .osdcell')].find((c) => c.dataset.key === i);
    ic.click();
    await wait(240);
    pairs[`${i}/${g}`] = `${tok('--ink')} on ${tok('--paper')}`;
  }
}
out.pairsResolved = Object.keys(pairs).length;
out.allDistinctInks = new Set(Object.values(pairs)).size === 16;
out.sample = `${pairs['white/blue']} | ${pairs['green/green']} | ${pairs['white/white']}`;

// The white ground must flip data-light, since fourteen rules depend on it.
[...document.querySelectorAll('#vhsGroundRail .osdcell')].find((c) => c.dataset.key === 'white').click();
await wait(400);
out.whiteIsLight = root.dataset.light === 'true';
[...document.querySelectorAll('#vhsGroundRail .osdcell')].find((c) => c.dataset.key === 'blue').click();
await wait(400);
out.blueIsDark = root.dataset.light === 'false';

/**
 * THE DROPDOWN LIST, which no screenshot of this page can ever show.
 *
 * A select's popup is drawn by the operating system and paints its own light
 * background behind whatever colour the options carry. The options were
 * inheriting the skin's white ink with no background of their own — measured
 * rgb(255,255,255) on rgba(0,0,0,0) — so the programming list was white on
 * white and only the highlighted row was readable. Nothing in the rendered
 * page looks wrong, which is why this has to be asserted rather than seen.
 *
 * Failing control: delete the `:root[data-skin="vcr"] option` rule and this
 * throws on the transparent background before it even reaches the ratio.
 */
const opt = document.querySelector('#scheduleSelect option');
if (!opt) throw new Error('no programming options to check');
const optStyle = getComputedStyle(opt);
const optBg = optStyle.backgroundColor;
const optFg = optStyle.color;
if (/rgba\(0, 0, 0, 0\)|transparent/.test(optBg)) {
  throw new Error(`dropdown options carry no background of their own (${optBg}), so the OS paints its own behind ${optFg}`);
}
const chan = (c) => c.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
});
const lum = (c) => { const [r, g, b] = chan(c); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
};
out.dropdownContrast = +contrast(optFg, optBg).toFixed(2);
if (out.dropdownContrast < 4.5) {
  throw new Error(`dropdown options measure ${out.dropdownContrast}:1 — ${optFg} on ${optBg}`);
}

// Leaving the skin must clear the pair attributes entirely.
sel.value = 'midnight'; sel.dispatchEvent(new Event('change', { bubbles: true }));
await wait(600);
out.attributesCleared = !root.dataset.osdInk && !root.dataset.osdGround && !root.dataset.skin;

const bad = Object.entries(out).filter(([k, v]) => !['defaultPair', 'sample', 'inkCells', 'groundCells', 'pairsResolved', 'dropdownContrast'].includes(k) && !v);
if (out.inkCells !== 4 || out.groundCells !== 4) throw new Error('rails not 4+4: ' + out.inkCells + '/' + out.groundCells);
if (out.pairsResolved !== 16) throw new Error('only ' + out.pairsResolved + ' pairs walked');
if (bad.length) throw new Error(`colour rails: ${bad.map(([k]) => k).join(', ')} — ${JSON.stringify(out)}`);
return out;
