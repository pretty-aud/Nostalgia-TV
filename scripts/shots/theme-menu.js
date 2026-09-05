/**
 * The theme picker's ACTUAL OPTIONS, rendered as a list.
 *
 * A native <select> popup cannot be screenshotted, and the previous theme shot
 * painted swatches from the CSS tokens directly — which proved the palettes
 * existed and said nothing about whether they were selectable. They were not.
 * This reads #themeSelect itself, so it can only show what is really pickable.
 * Bare statements.
 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const NEW = ['sage', 'bordeaux', 'patina', 'iris'];
const sel = document.getElementById('themeSelect');
const opts = [...sel.options].map((o) => ({ value: o.value, label: o.textContent }));
if (opts.length < 30) throw new Error('theme menu did not read: ' + opts.length);
const missing = NEW.filter((n) => !opts.some((o) => o.value === n));
if (missing.length) throw new Error('NOT SELECTABLE: ' + missing.join(', '));

const root = document.documentElement;
const original = root.dataset.theme;
const swatch = {};
for (const o of opts) {
  root.dataset.theme = o.value;
  await wait(20);
  const cs = getComputedStyle(root);
  swatch[o.value] = { paper: cs.getPropertyValue('--paper').trim(), signal: cs.getPropertyValue('--signal').trim(), ink: cs.getPropertyValue('--ink').trim() };
}
if (original) root.dataset.theme = original; else delete root.dataset.theme;
await wait(60);

const strip = document.createElement('div');
strip.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#0b0b0f;color:#eee;padding:16px 20px;font:12px Inter,system-ui,sans-serif;display:grid;grid-template-columns:repeat(3,1fr);grid-auto-rows:min-content;gap:6px 22px;align-content:start';
for (const o of opts) {
  const s = swatch[o.value];
  const isNew = NEW.includes(o.value);
  const row = document.createElement('div');
  row.style.cssText = `display:flex;align-items:center;gap:9px;padding:4px 7px;border-radius:6px;${isNew ? 'background:#ffc2471a;outline:1px solid #ffc247' : ''}`;
  row.innerHTML = `
    <span style="width:26px;height:16px;border-radius:3px;background:${s.paper};border:1px solid #333;flex:0 0 auto"></span>
    <span style="width:12px;height:16px;border-radius:3px;background:${s.signal};flex:0 0 auto"></span>
    <span style="${isNew ? 'color:#ffc247;font-weight:600' : 'color:#cfcfd6'}">${o.label}</span>
    ${isNew ? '<span style="margin-left:auto;color:#ffc247;font-size:10px;letter-spacing:.1em">NEW</span>' : ''}`;
  strip.append(row);
}
const head = document.createElement('div');
head.style.cssText = 'grid-column:1/-1;font-size:15px;margin-bottom:6px';
head.textContent = `Settings → Interface → Theme — ${opts.length} options, 5 new (highlighted)`;
strip.prepend(head);
document.body.append(strip);
await wait(400);
