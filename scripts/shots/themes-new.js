/* The five new palettes side by side. Bare statements.
   Tokens are read by putting each theme on the ROOT in turn — the selectors
   are :root[data-theme=...], so setting the attribute on a child element
   silently inherits the default instead, which is how the first version of
   this shot produced five identical amber cells. */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const NEW = ['cobalt', 'iris', 'patina', 'bordeaux', 'sage'];
const KEYS = ['paper', 'paper-lift', 'paper-high', 'ink', 'ink-mute', 'signal', 'hair'];
const root = document.documentElement;
const original = root.dataset.theme;

const palettes = {};
for (const name of NEW) {
  root.dataset.theme = name;
  await wait(60);
  const cs = getComputedStyle(root);
  palettes[name] = Object.fromEntries(KEYS.map((k) => [k, cs.getPropertyValue(`--${k}`).trim()]));
}
if (original) root.dataset.theme = original; else delete root.dataset.theme;
await wait(80);

// Proof the read worked: five DIFFERENT papers, not five copies of the default.
const papers = new Set(NEW.map((n) => palettes[n].paper));
if (papers.size !== NEW.length) throw new Error(`themes did not resolve: ${[...papers].join(' ')}`);

const strip = document.createElement('div');
strip.style.cssText = 'position:fixed;inset:0;z-index:9999;display:grid;grid-template-columns:repeat(5,1fr)';
for (const name of NEW) {
  const p = palettes[name];
  const cell = document.createElement('div');
  cell.style.cssText = `background:${p.paper};color:${p.ink};padding:24px 18px;display:flex;flex-direction:column;gap:14px;font:14px Inter,system-ui,sans-serif`;
  cell.innerHTML = `
    <div style="font-size:19px">${name}</div>
    <div style="background:${p['paper-lift']};border:1px solid ${p.hair};border-radius:10px;padding:12px">
      <div style="color:${p['ink-mute']};font-size:11px;letter-spacing:.08em;text-transform:uppercase">Up next</div>
      <div style="margin-top:6px">Cowboy Bebop</div>
      <div style="color:${p['ink-mute']};font-family:monospace;font-size:11px">S01E05</div>
      <div style="margin-top:10px;height:3px;background:${p.hair};border-radius:2px">
        <div style="width:44%;height:100%;background:${p.signal};border-radius:2px"></div>
      </div>
    </div>
    <div style="background:${p['paper-high']};border:1px solid ${p.hair};border-radius:10px;padding:11px 12px;color:${p['ink-mute']};font-size:12px">panel</div>
    <div style="display:flex;gap:7px">
      <span style="border:1px solid ${p.signal};color:${p.signal};border-radius:6px;padding:3px 9px;font-size:11px">Anime</span>
      <span style="border:1px solid ${p.hair};color:${p['ink-mute']};border-radius:6px;padding:3px 9px;font-size:11px">Sci-Fi</span>
    </div>
    <div style="margin-top:auto;background:${p.signal};color:${p.paper};text-align:center;border-radius:7px;padding:10px;font-size:13px">Play</div>`;
  strip.append(cell);
}
document.body.append(strip);
await wait(400);
