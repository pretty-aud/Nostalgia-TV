/**
 * Movie on/off as an icon button, a 24-hour default, and a yellow volume fill.
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
    if (!text.includes(from)) { misses.push(`${rel}: ${from.slice(0, 64).replace(/\n/g, ' | ')}`); continue; }
    text = text.split(from).join(to);
  }
  fs.writeFileSync(file, text);
}

// ── scheduler: on/off is now its own setting ─────────────────────────────
edit('src/shared/scheduler.js', [
  [`  movieEvery: 0,            // hours between movies; 0 = never
  moviePresentationEnabled: true,`,
`  /**
   * On/off is its own setting rather than a "never" entry in the interval
   * list. Switching movies off and back on should not make you re-pick how
   * often you wanted them — the two are different questions.
   */
  moviesEnabled: true,
  movieEvery: 24,           // hours between movies
  moviePresentationEnabled: true,`],

  [`  const hours = Number(settings.movieEvery) || 0;
  if (hours <= 0) return false;`,
`  if (!settings.moviesEnabled) return false;
  const hours = Number(settings.movieEvery) || 0;
  if (hours <= 0) return false;`],
]);

// ── HTML ─────────────────────────────────────────────────────────────────
edit('src/renderer/index.html', [
  // Never is gone from the list; the button carries that job now.
  [`              <select class="select" id="movieEvery">
                <option value="0">Never</option>
                <option value="3">Every 3 hours</option>`,
`              <select class="select" id="movieEvery">
                <option value="3">Every 3 hours</option>`],

  // Two icon buttons, right-aligned together.
  [`      <button class="settingsbtn" id="btnSettings" type="button"
              aria-haspopup="dialog" aria-label="Settings" title="Settings">
        <span class="settingsbtn__gear" aria-hidden="true">⚙</span>
      </button>`,
`      <div class="footactions">
        <!-- Hidden without a MOVIES folder: a switch for something the library
             does not contain is a control with nothing behind it. -->
        <button class="settingsbtn" id="btnMovies" type="button" hidden
                aria-pressed="true" aria-label="Play movies" title="Play movies">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
               stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
            <path d="M7 5v14M17 5v14M2.5 12h19M2.5 8.5h4.5M2.5 15.5h4.5M17 8.5h4.5M17 15.5h4.5" />
          </svg>
        </button>

        <button class="settingsbtn" id="btnSettings" type="button"
                aria-haspopup="dialog" aria-label="Settings" title="Settings">
          <span class="settingsbtn__gear" aria-hidden="true">⚙</span>
        </button>
      </div>`],

  // Emoji cannot be recoloured; an inline SVG inherits currentColor.
  [`            <button class="ctl" id="btnMute" type="button" aria-label="Mute"></button>`,
`            <button class="ctl ctl--icon" id="btnMute" type="button" aria-label="Mute"></button>`],
]);

console.log(misses.length ? `MISSED ${misses.length}` : 'wired');
for (const m of misses) console.log('  •', m);
