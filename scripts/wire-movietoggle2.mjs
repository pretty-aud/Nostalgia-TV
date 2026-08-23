/**
 * Part two: the renderer + stylesheet side of the movie switch, and the
 * amber sound controls.
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

// ── HTML: the frequency field needs an id so it can be dimmed ─────────────
edit('src/renderer/index.html', [
  [`          <label class="field">
            <span class="field__label">Play a movie</span>`,
`          <label class="field" id="movieEveryField">
            <span class="field__label">Play a movie</span>`],
]);

// ── renderer ─────────────────────────────────────────────────────────────
edit('src/renderer/index.js', [

  // -- 1. the frequency list is a fixed set, and old files hold a stale 0 ---
  [`function renderSidebar() {`,
`/**
 * The frequencies the menu actually offers.
 *
 * Kept as data because two separate things depend on it: the select can only
 * display a value that matches one of its options, and a state file written
 * before this list existed holds 0 — the old "Never" entry — which would
 * select nothing at all and leave the control looking empty.
 */
const MOVIE_INTERVALS = [3, 6, 12, 24, 48];

function movieIntervalHours(settings) {
  const saved = Number((settings || {}).movieEvery);
  return MOVIE_INTERVALS.includes(saved) ? saved : 24;
}

/**
 * The movie switch that sits beside the settings gear.
 *
 * Hidden without a MOVIES folder: a switch for something the library does not
 * contain is a control with nothing behind it. Off is drawn as a legible
 * state rather than an absence — a control that disappears when you switch it
 * off cannot be switched back on.
 */
function renderMovieToggle() {
  const button = el('btnMovies');
  const on = state.settings.moviesEnabled !== false;
  const hours = movieIntervalHours(state.settings);

  button.hidden = movieFiles.length === 0;
  button.setAttribute('aria-pressed', String(on));
  const label = on ? \`Movies on — one every \${hours} hours\` : 'Movies off';
  button.title = label;
  button.setAttribute('aria-label', label);
}

function renderSidebar() {`],

  // -- 2. settings panel reads the switch ----------------------------------
  [`  el('movieGroup').hidden = movieFiles.length === 0;
  const movieHours = Number(state.settings.movieEvery) || 0;
  el('movieEvery').value = String(movieHours);
  el('movieNote').textContent = movieHours === 0
    ? \`\${movieFiles.length} in the library. Movies are off.\`
    : \`\${movieFiles.length} in the library, shuffled. A movie interrupts the rotation; it is not part of a block.\`;`,
`  el('movieGroup').hidden = movieFiles.length === 0;
  const moviesOn = state.settings.moviesEnabled !== false;
  el('movieEvery').value = String(movieIntervalHours(state.settings));
  // Dimmed rather than hidden while movies are off: it still says how often
  // they would play if you switched them back on.
  el('movieEveryField').dataset.muted = String(!moviesOn);
  el('movieNote').textContent = moviesOn
    ? \`\${movieFiles.length} in the library, shuffled. A movie interrupts the rotation; it is not part of a block.\`
    : \`\${movieFiles.length} in the library. Switched off — the film button beside the settings gear turns them back on.\`;
  renderMovieToggle();`],

  // -- 3. speaker icons that can take a colour -----------------------------
  [`function applyVolume() {`,
`/**
 * The speaker is an inline SVG rather than an emoji.
 *
 * An emoji is a colour bitmap in most fonts, so \`color\` does nothing to it —
 * the glyph arrived in the system's own palette next to an amber slider and
 * could not be made to match. A stroked path inherits currentColor, which is
 * the only way these can be the one accent colour in both states.
 */
const SPEAKER_CONE = '<path d="M4.2 9.4h3.1L11.8 5.6v12.8L7.3 14.6H4.2z" fill="currentColor" />';
const MUTE_ICONS = {
  muted: \`\${SPEAKER_CONE}<path d="M15.6 9.8l4.6 4.4M20.2 9.8l-4.6 4.4" />\`,
  low: \`\${SPEAKER_CONE}<path d="M15.2 9.9a3 3 0 0 1 0 4.2" />\`,
  high: \`\${SPEAKER_CONE}<path d="M15.2 9.9a3 3 0 0 1 0 4.2" /><path d="M17.9 7.5a6.6 6.6 0 0 1 0 9" />\`,
};

/** Only redrawn when the state changes — applyVolume runs on every drag tick. */
let muteIconState = null;
function setMuteIcon(name) {
  if (muteIconState === name) return;
  muteIconState = name;
  el('btnMute').innerHTML =
    '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" '
    + 'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + MUTE_ICONS[name] + '</svg>';
}

function applyVolume() {`],

  [`  el('btnMute').textContent = silent ? '🔇' : (level < 50 ? '🔈' : '🔊');`,
`  setMuteIcon(silent ? 'muted' : (level < 50 ? 'low' : 'high'));`],

  // -- 4. the switch itself, and a frequency that can no longer be zero -----
  [`  el('movieEvery').addEventListener('change', (event) => {
    const hours = Number(event.target.value) || 0;
    setSetting({ movieEvery: hours });
    toast(hours === 0
      ? 'Movies are off.'
      : \`A movie every \${hours} hours. The first one plays at the next break.\`, 3600);
  });`,
`  el('movieEvery').addEventListener('change', (event) => {
    const hours = Number(event.target.value) || 24;
    setSetting({ movieEvery: hours });
    toast(state.settings.moviesEnabled === false
      ? \`Set to every \${hours} hours — movies are still switched off.\`
      : \`A movie every \${hours} hours. The first one plays at the next break.\`, 3600);
  });

  // On/off is its own control rather than a "never" entry in the list above,
  // so switching movies off and back on does not make you re-pick how often
  // you wanted them. The two are different questions.
  el('btnMovies').addEventListener('click', () => {
    const turningOn = state.settings.moviesEnabled === false;
    setSetting({ moviesEnabled: turningOn });
    toast(turningOn
      ? \`Movies on — one every \${movieIntervalHours(state.settings)} hours.\`
      : 'Movies off.', 3000);
  });`],

  // -- 5. carry old state across -------------------------------------------
  [`  applySubtitleStyle();
  applyUiScale();`,
`  // "Never" used to be an entry in the frequency menu, saved as 0. It is a
  // switch now, so a 0 left in an older file would match no option at all and
  // leave the menu blank. Move it to the default interval; whether movies
  // actually play is the switch's job.
  if (!MOVIE_INTERVALS.includes(Number(state.settings.movieEvery))) {
    state.settings = { ...state.settings, movieEvery: 24 };
  }

  applySubtitleStyle();
  applyUiScale();`],
]);

// ── stylesheet ───────────────────────────────────────────────────────────
edit('src/renderer/styles.css', [

  /* A selector was lost from this pair in an earlier edit, leaving a leading
     comma. An invalid item invalidates the whole selector list, so the browser
     was dropping the rule and the up-next label had no styling at all. */
  [`,
.upnext { font-size: var(--t-meta); color: var(--ink-faint); margin-right: 6px; }`,
`.upnext { font-size: var(--t-meta); color: var(--ink-faint); margin-right: 6px; }`],

  // Two icon buttons sharing one line at the trailing edge.
  [`.settingsbtn {
  margin-top: calc(var(--u) * 2);
  margin-left: auto;
  margin-right: var(--gutter);   /* clears the sidebar edge, matching the rows */`,
`/* Grouped in a common region so they read as one family of switches, and so
   the gear stays exactly where it has always been. */
.footactions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--u);
  margin-top: calc(var(--u) * 2);
  padding-right: var(--gutter);   /* clears the sidebar edge, matching the rows */
}
.footactions .settingsbtn { margin: 0; }

/* On is the app's amber; off keeps the icon and drops the accent. A control
   that vanishes when you switch it off cannot be switched back on. */
#btnMovies[aria-pressed="true"] { color: var(--signal); border-color: var(--signal-soft); }
#btnMovies[aria-pressed="true"]:hover { color: var(--signal); border-color: var(--signal); }
#btnMovies[aria-pressed="false"] { color: var(--ink-faint); }
#btnMovies svg { display: block; }

.settingsbtn {
  margin-top: calc(var(--u) * 2);
  margin-left: auto;
  margin-right: var(--gutter);   /* clears the sidebar edge, matching the rows */`],

  // Amber sound controls.
  [`.volume input[type="range"] {
  width: 84px;
  flex: 0 0 auto;
  accent-color: var(--ink);
}
.volume #btnMute { min-width: 30px; font-size: var(--t-body); }

/* Muted and turned-fully-down sound identical, so they must look identical
   too — otherwise silence looks like a fault. */
.volume[data-silent="true"] input[type="range"] { accent-color: var(--ink-faint); }
.volume[data-silent="true"] #btnMute { color: var(--ink-faint); }`,
`.volume input[type="range"] {
  width: 84px;
  flex: 0 0 auto;
  /* accent-color fills the track up to the thumb, so the amber IS the level —
     full bar at 100%, and no separate readout needed to see where it sits. */
  accent-color: var(--signal);
}

/* A square target for a glyph with no text: .ctl's padding is sized for a
   word, and left on an icon it puts the artwork off-centre. */
.ctl--icon {
  min-width: 34px;
  width: 34px;
  padding: 0;
  display: grid;
  place-items: center;
}
.volume #btnMute { color: var(--signal); }
.volume #btnMute:hover { color: #ffce68; border-color: var(--signal-soft); }
.volume #btnMute svg { display: block; }

/* Muted and turned-fully-down sound identical, so they must look identical
   too — otherwise silence looks like a fault. The icon stays amber in both
   states; the crossed-out speaker is what says silent, and a greyed control
   would read as unavailable rather than switched off. */
.volume[data-silent="true"] input[type="range"] { accent-color: var(--ink-faint); }`],
]);

console.log(misses.length ? `MISSED ${misses.length}` : 'wired');
for (const m of misses) console.log('  •', m);
