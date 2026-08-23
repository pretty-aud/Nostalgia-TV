/**
 * Movies in the renderer: the playback chain, the up-next card, the settings.
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
    if (!text.includes(from)) { misses.push(`${rel}: ${from.slice(0, 62).replace(/\n/g, ' | ')}`); continue; }
    text = text.split(from).join(to);
  }
  fs.writeFileSync(file, text);
}

// ── HTML: a Movies section in settings ────────────────────────────────────
edit('src/renderer/index.html', [
  [`        <section class="setgroup">
          <h3 class="setgroup__head mono">Library</h3>`,
`        <section class="setgroup" id="movieGroup" hidden>
          <h3 class="setgroup__head">Movies</h3>

          <label class="field">
            <span class="field__label">Play a movie</span>
            <span class="field__control">
              <select class="select" id="movieEvery">
                <option value="0">Never</option>
                <option value="3">Every 3 hours</option>
                <option value="6">Every 6 hours</option>
                <option value="12">Every 12 hours</option>
                <option value="24">Every 24 hours</option>
                <option value="48">Every 48 hours</option>
              </select>
            </span>
          </label>
          <p class="modes__note" id="movieNote"></p>

          <label class="check" id="presentationRow" hidden>
            <input type="checkbox" id="presentationToggle" />
            <span>Play a presentation before each movie <span class="mono" id="presentationCount"></span></span>
          </label>
        </section>

        <section class="setgroup">
          <h3 class="setgroup__head">Library</h3>`],
]);

// ── Renderer ──────────────────────────────────────────────────────────────
edit('src/renderer/index.js', [
  // imports
  ['  nextBumper,\n  nextPromo,', '  nextBumper,\n  nextPromo,\n  nextMovie,\n  shouldPlayMovie,\n  markMoviePlayed,'],

  // globals
  ['let promoClips = [];       // clips from the PROMOS folder, played after the bumper',
`let promoClips = [];       // clips from the PROMOS folder, played after the bumper
let movieFiles = [];       // features from the MOVIES folder
let presentationClips = [];// idents from the MOVIE PRESENTATION folder

/**
 * The movie chosen for THIS transition, decided before the up-next card so the
 * card can announce it, and consumed when it actually starts.
 */
let pendingMovie = null;
let presentationLast = null;`],

  // library load
  ['  promoClips = result.promos || [];',
`  promoClips = result.promos || [];
  movieFiles = result.movies || [];
  presentationClips = result.presentations || [];`],
  ['  const promoPaths = new Set(promoClips.map((clip) => clip.relPath));\n  state.promoDeck = (state.promoDeck || []).filter((relPath) => promoPaths.has(relPath));',
`  const promoPaths = new Set(promoClips.map((clip) => clip.relPath));
  state.promoDeck = (state.promoDeck || []).filter((relPath) => promoPaths.has(relPath));
  const moviePaths = new Set(movieFiles.map((movie) => movie.relPath));
  state.movieDeck = (state.movieDeck || []).filter((relPath) => moviePaths.has(relPath));`],

  // scan toast
  ['    promoCount ? count(promoCount, \'promo\', \'promos\') : null,',
   '    promoCount ? count(promoCount, \'promo\', \'promos\') : null,\n    result.stats.movieCount ? count(result.stats.movieCount, \'movie\', \'movies\') : null,'],

  // the chain
  [`  state.resume = null;
  // Broadcast order: sting, then the promo, then the continuity card, then the
  // next programme. Each step passes through instantly when it has nothing to
  // play, so the chain is the same whether or not those folders exist.
  playBumperClip(() => {
    playPromoClip(() => {
      if (state.settings.bumperEnabled && state.settings.bumperSeconds > 0) {
        showBumper(() => playNext());
      } else {
        playNext();
      }
    });
  });`,
`  state.resume = null;
  // Broadcast order: sting, promo, continuity card, then the next programme —
  // or, when the clock says one is due, the movie presentation and the movie.
  // Each step passes through instantly when it has nothing to play.
  playBumperClip(() => {
    playPromoClip(() => {
      // The movie is DEALT here, before the card, so the card can announce it
      // by name. It is not marked as played until it actually starts.
      if (shouldPlayMovie(state, movieFiles, {})) {
        const picked = nextMovie(movieFiles, state, {});
        state = picked.state;
        pendingMovie = picked.movie;
      }

      const after = () => (pendingMovie ? startMovie() : playNext());
      if (state.settings.bumperEnabled && state.settings.bumperSeconds > 0) {
        showBumper(after, pendingMovie ? movieItem(pendingMovie) : null);
      } else {
        after();
      }
    });
  });`],

  // card accepts a lead override
  ['async function showBumper(onDone) {\n  const upcoming = peek(shows, state, 3);\n  if (upcoming.length === 0) { onDone(); return; }\n\n  const lead = upcoming[0];',
`async function showBumper(onDone, leadOverride) {
  const upcoming = peek(shows, state, 3);
  if (upcoming.length === 0 && !leadOverride) { onDone(); return; }

  // A movie takes the headline; the episodes behind it still list underneath,
  // because they are genuinely what follows it.
  const lead = leadOverride || upcoming[0];`],
  ['  const then = el(\'bumperThen\');\n  then.textContent = \'\';\n  for (let i = 1; i < upcoming.length; i += 1) {',
   '  const then = el(\'bumperThen\');\n  then.textContent = \'\';\n  for (let i = leadOverride ? 0 : 1; i < upcoming.length; i += 1) {'],

  // resume must not be written for a movie
  ['  if (current && !playingBumperClip && performance.now() - lastSavedAt > 5000) {',
   '  if (current && !current.isMovie && !playingBumperClip && performance.now() - lastSavedAt > 5000) {'],
]);

console.log(misses.length ? `MISSED ${misses.length}` : 'renderer wired');
for (const m of misses) console.log('  •', m);
