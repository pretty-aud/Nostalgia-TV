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

// Leaving the skin must clear the pair attributes entirely.
sel.value = 'midnight'; sel.dispatchEvent(new Event('change', { bubbles: true }));
await wait(600);
out.attributesCleared = !root.dataset.osdInk && !root.dataset.osdGround && !root.dataset.skin;

const bad = Object.entries(out).filter(([k, v]) => !['defaultPair', 'sample', 'inkCells', 'groundCells', 'pairsResolved'].includes(k) && !v);
if (out.inkCells !== 4 || out.groundCells !== 4) throw new Error('rails not 4+4: ' + out.inkCells + '/' + out.groundCells);
if (out.pairsResolved !== 16) throw new Error('only ' + out.pairsResolved + ' pairs walked');
if (bad.length) throw new Error(`colour rails: ${bad.map(([k]) => k).join(', ')} — ${JSON.stringify(out)}`);
return out;
