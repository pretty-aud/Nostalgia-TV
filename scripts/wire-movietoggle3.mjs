/**
 * Two things the screenshots caught:
 *   1. accent-color tints the THUMB but leaves the track uniform, so "fill the
 *      bar" needed the track painting by hand.
 *   2. the settings gear is a colour emoji, which cannot take the ink colour —
 *      the same fault just fixed on the speaker, and now sitting right beside
 *      a stroked icon where the mismatch is obvious.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const misses = [];

function edit(rel, pairs) {
  const file = path.join(root, rel);
  let text = fs.readFileSync(file, 'utf8');
  for (const [from, to] of pairs) {
    if (!text.includes(from)) { misses.push(`${rel}: ${from.slice(0, 70).replace(/\n/g, ' | ')}`); continue; }
    text = text.split(from).join(to);
  }
  fs.writeFileSync(file, text);
}

// ── the gear, as artwork that can be coloured ────────────────────────────
edit('src/renderer/index.html', [
  [`          <span class="settingsbtn__gear" aria-hidden="true">⚙</span>`,
`          <span class="settingsbtn__gear" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
                 stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3.1" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-2.87 1.2V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.93-1.15l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 3 15.4H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.25 8.4l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9.95 4.6V4a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.93 1.15l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.31 1.87V10a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
            </svg>
          </span>`],
]);

// ── the volume track ─────────────────────────────────────────────────────
edit('src/renderer/index.js', [
  [`  const range = el('volumeRange');
  if (document.activeElement !== range) range.value = String(level);
  range.setAttribute('aria-valuetext', silent ? 'Muted' : \`\${level}%\`);`,
`  const range = el('volumeRange');
  if (document.activeElement !== range) range.value = String(level);
  range.setAttribute('aria-valuetext', silent ? 'Muted' : \`\${level}%\`);
  // The track is painted from this, not by accent-color: Chromium tints the
  // thumb and leaves the bar itself a flat colour, so "full bar at full
  // volume" has to be drawn. Muted reads as empty rather than as a level,
  // because a bar still showing 70% while nothing can be heard is a lie.
  range.style.setProperty('--fill', \`\${silent ? 0 : level}%\`);`],
]);

// ── stylesheet ───────────────────────────────────────────────────────────
edit('src/renderer/styles.css', [
  [`.volume input[type="range"] {
  width: 84px;
  flex: 0 0 auto;
  /* accent-color fills the track up to the thumb, so the amber IS the level —
     full bar at 100%, and no separate readout needed to see where it sits. */
  accent-color: var(--signal);
}`,
`/* Drawn rather than themed. accent-color only reaches the thumb here, which
   left the bar reading empty at every volume; --fill comes from applyVolume so
   the amber IS the level — a full bar at full volume, and nothing else to read
   to see where it sits. */
.volume input[type="range"] {
  width: 84px;
  height: 14px;
  flex: 0 0 auto;
  appearance: none;
  -webkit-appearance: none;
  background: transparent;
  cursor: pointer;
}
.volume input[type="range"]::-webkit-slider-runnable-track {
  height: 4px;
  border-radius: var(--r-pill);
  background: linear-gradient(to right,
    var(--signal) 0 var(--fill, 100%),
    var(--hair) var(--fill, 100%) 100%);
}
.volume input[type="range"]::-webkit-slider-thumb {
  appearance: none;
  -webkit-appearance: none;
  width: 11px;
  height: 11px;
  margin-top: -3.5px;      /* centres the thumb on a 4px track */
  border-radius: 50%;
  background: var(--signal);
}
.volume input[type="range"]:focus-visible { outline: 2px solid var(--signal); outline-offset: 3px; }`],

  [`.volume[data-silent="true"] input[type="range"] { accent-color: var(--ink-faint); }`,
`.volume[data-silent="true"] input[type="range"]::-webkit-slider-runnable-track {
  background: var(--hair);
}
.volume[data-silent="true"] input[type="range"]::-webkit-slider-thumb { background: var(--ink-faint); }`],

  // The gear is artwork now, so it rotates as a box rather than as a glyph.
  [`.settingsbtn__gear { font-size: var(--t-lead); line-height: 1; transition: transform var(--med); }`,
`.settingsbtn__gear { display: grid; place-items: center; transition: transform var(--med); }
.settingsbtn__gear svg { display: block; }`],
]);

console.log(misses.length ? `MISSED ${misses.length}` : 'wired');
for (const m of misses) console.log('  •', m);
