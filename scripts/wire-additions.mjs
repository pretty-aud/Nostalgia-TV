/**
 * Four additions: promos on the seam between shows, a skip-just-this-episode
 * option, a shuffle button, and a manual progress checkpoint.
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

// ── markup ───────────────────────────────────────────────────────────────
edit('src/renderer/index.html', [

  // 1. Promos on the seam between shows. A labelled toggle rather than a magic
  //    position on the slider: a control you have to discover is a control most
  //    people never find.
  [`          <label class="field" id="promoEveryField">
            <span class="field__label mono">Promo every</span>`,
`          <label class="check">
            <input type="checkbox" id="promoBetweenToggle" />
            <span>Only between shows or blocks</span>
          </label>
          <p class="modes__note" id="promoBetweenNote"></p>

          <label class="field" id="promoEveryField">
            <span class="field__label mono">Promo every</span>`],

  // 2. A third skip, for "this one episode, carry on with the block".
  [`          <button class="btn btn--signal" id="skipCount" type="button">Skip it on the counter</button>
          <button class="btn" id="skipBlock" type="button">Just skip it for now</button>`,
`          <button class="btn btn--signal" id="skipEpisode" type="button">Skip just this episode</button>
          <button class="btn" id="skipCount" type="button">Skip the rest of this block</button>
          <button class="btn" id="skipBlock" type="button">Just skip it for now</button>`],

  // 3. Shuffle, beside the movie switch.
  [`        <button class="settingsbtn" id="btnMovies" type="button" hidden`,
`        <button class="settingsbtn" id="btnShuffle" type="button"
                aria-label="Shuffle the running order" title="Shuffle the running order">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
               stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M3 7h3.5l3 5M3 17h3.5l3-5" />
            <path d="M14.5 7H21M14.5 17H21" />
            <path d="M18.5 4.5 21 7l-2.5 2.5M18.5 14.5 21 17l-2.5 2.5" />
          </svg>
        </button>

        <button class="settingsbtn" id="btnMovies" type="button" hidden`],

  // 4. The manual checkpoint, next to the reset it exists to undo.
  [`        <section class="setgroup">
          <h3 class="setgroup__head">Library</h3>`,
`        <section class="setgroup">
          <h3 class="setgroup__head">Saved progress</h3>
          <p class="modes__note" id="manualSaveNote"></p>
          <div class="setrow">
            <button class="btn" id="btnManualSave" type="button">Save progress now</button>
            <button class="btn btn--quiet" id="btnManualLoad" type="button">Load saved progress</button>
          </div>
        </section>

        <section class="setgroup">
          <h3 class="setgroup__head">Library</h3>`],
]);

// ── styles ───────────────────────────────────────────────────────────────
edit('src/renderer/styles.css', [
  [`#btnMovies svg { display: block; }`,
`#btnMovies svg { display: block; }
#btnShuffle svg { display: block; }
#btnShuffle:hover { color: var(--ink); }

/* Two buttons that belong to one decision, sitting on one line. */
.setrow { display: flex; flex-wrap: wrap; gap: var(--u); margin-top: var(--u); }`],
]);

console.log(misses.length ? `MISSED ${misses.length}` : 'wired');
for (const m of misses) console.log('  •', m);
