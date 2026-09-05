/**
 * The VHS face picker: present under the skin, gone without it, and it
 * actually changes the face everywhere. Bare statements; throws on failure.
 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = {};
const stackOf = () => getComputedStyle(document.documentElement).getPropertyValue('--grotesque').trim();
const monoOf = () => getComputedStyle(document.documentElement).getPropertyValue('--mono').trim();

await wait(700);
document.getElementById('btnSettings').click();
await wait(700);
out.hiddenWithoutSkin = document.getElementById('vhsFontField').hidden;

const sel = document.getElementById('themeSelect');
sel.value = 'vhs'; sel.dispatchEvent(new Event('change', { bubbles: true }));
await wait(800);
out.shownWithSkin = !document.getElementById('vhsFontField').hidden;
out.defaultIsHomeVideo = /Home Video/.test(stackOf());
out.monoFollows = /Home Video/.test(monoOf());
out.fontSelectsDimmed = document.getElementById('fontDisplaySelect').disabled;

const cells = [...document.querySelectorAll('#vhsFontRail .osdcell')];
out.twoCells = cells.length === 2;
out.labels = cells.map((c) => c.textContent.trim().replace(/\s+/g, ' ')).join(' | ');
out.homeVideoChosen = cells[0].dataset.on === 'true';

// Switch to IBM and confirm the whole app follows.
cells[1].click();
await wait(700);
out.ibmApplied = /IBM VGA/.test(stackOf()) && /IBM VGA/.test(monoOf());
out.ibmMarked = [...document.querySelectorAll('#vhsFontRail .osdcell')][1].dataset.on === 'true';

// Leave the skin: her own faces must come back, mono included.
sel.value = 'midnight'; sel.dispatchEvent(new Event('change', { bubbles: true }));
await wait(700);
out.restoredOnLeaving = !/IBM VGA|Home Video/.test(stackOf()) && /JetBrains/.test(monoOf());
out.hiddenAgain = document.getElementById('vhsFontField').hidden;

const bad = Object.entries(out).filter(([k, v]) => k !== 'labels' && !v);
if (bad.length) throw new Error(`face picker: ${bad.map(([k]) => k).join(', ')} — ${JSON.stringify(out)}`);
return out;
