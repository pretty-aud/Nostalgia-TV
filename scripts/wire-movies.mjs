/**
 * Wire movies + the movie presentation through the remaining files.
 *
 * A script file rather than inline shell, because the replacements contain
 * backticks and braces that a shell will happily eat.
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
    if (!text.includes(from)) { misses.push(`${rel}: ${from.slice(0, 60).replace(/\n/g, ' | ')}`); continue; }
    text = text.split(from).join(to);
  }
  fs.writeFileSync(file, text);
}

// ── parseEpisode: collect and export ──────────────────────────────────────
edit('src/shared/parseEpisode.js', [
  ['  const promos = [];', '  const promos = [];\n  const movies = [];\n  const presentations = [];'],
  ['  promos.sort((a, b) => naturalCompare(a.fileName, b.fileName));\n  return { shows, bumpers, promos, skipped };',
   '  promos.sort((a, b) => naturalCompare(a.fileName, b.fileName));\n  movies.sort((a, b) => naturalCompare(a.name, b.name));\n  presentations.sort((a, b) => naturalCompare(a.fileName, b.fileName));\n  return { shows, bumpers, promos, movies, presentations, skipped };'],
  ['  PROMO_FOLDER,\n  isVideoFile,\n  isBumperPath,\n  isPromoPath,',
   '  PROMO_FOLDER,\n  MOVIES_FOLDER,\n  PRESENTATION_FOLDER,\n  isVideoFile,\n  isBumperPath,\n  isPromoPath,\n  isMoviePath,\n  isPresentationPath,\n  parseMovie,'],
]);

// ── scheduler: settings, state, and the movie clock ───────────────────────
edit('src/shared/scheduler.js', [
  ['  promoEvery: 1,            // gap in episodes: 1 = between every episode',
   `  promoEvery: 1,            // gap in episodes: 1 = between every episode

  /**
   * Movies run on a CLOCK, not on the episode counter.
   *
   * "Every three hours" has to mean three hours of wall time; counting
   * episodes would drift with their length and with how long the app was
   * closed. 0 means never.
   */
  movieEvery: 0,            // hours between movies; 0 = never
  moviePresentationEnabled: true,`],

  ['    promoDeck: [],            // same, for the PROMOS folder\n    lastPromoRelPath: null,',
   '    promoDeck: [],            // same, for the PROMOS folder\n    lastPromoRelPath: null,\n    movieDeck: [],            // same, for the MOVIES folder\n    lastMovieRelPath: null,\n    lastMovieAt: null,        // ms timestamp of the last movie that played'],

  ['function nextPromo(promos, state, options = {}) {',
   `/**
 * Is a movie due?
 *
 * \`now\` is injected so this is testable without waiting three hours.
 *
 * A null \`lastMovieAt\` means one is due immediately. Starting the clock
 * silently instead would leave someone who has just switched the feature on
 * with no way to tell whether it works short of waiting out the interval.
 */
function shouldPlayMovie(state, movies, options = {}) {
  const now = options.now || Date.now();
  const settings = { ...DEFAULT_SETTINGS, ...(state.settings || {}) };
  const hours = Number(settings.movieEvery) || 0;
  if (hours <= 0) return false;
  if (!movies || movies.length === 0) return false;
  if (!state.lastMovieAt) return true;
  return now - Number(state.lastMovieAt) >= hours * 3600 * 1000;
}

/** Deal the next movie, on its own deck so none repeats until all have run. */
function nextMovie(movies, state, options = {}) {
  const rng = options.rng || Math.random;
  const clips = movies || [];
  if (clips.length === 0) return { state, movie: null };

  const dealt = dealInterstitial(clips, state.movieDeck, state.lastMovieRelPath, rng);
  return {
    state: { ...state, movieDeck: dealt.deck, lastMovieRelPath: dealt.relPath },
    movie: dealt.clip,
  };
}

/** Restart the clock. Called when a movie actually STARTS, not when it is due. */
function markMoviePlayed(state, options = {}) {
  return { ...state, lastMovieAt: options.now || Date.now() };
}

function nextPromo(promos, state, options = {}) {`],

  ['  nextPromo,\n  shouldPlayPromo,', '  nextPromo,\n  nextMovie,\n  shouldPlayMovie,\n  markMoviePlayed,\n  shouldPlayPromo,'],
]);

// ── main: return the new collections from a scan ──────────────────────────
edit('electron/main.js', [
  ['  const { shows, bumpers, promos, skipped } = buildLibrary(files, { rootName: path.basename(rootPath) });',
   '  const { shows, bumpers, promos, movies, presentations, skipped } = buildLibrary(files, { rootName: path.basename(rootPath) });'],
  ['  for (const clip of [...bumpers, ...promos]) {\n    clip.mediaUrl = mediaUrlFor(clip.absPath);\n  }',
   '  for (const clip of [...bumpers, ...promos, ...movies, ...presentations]) {\n    clip.mediaUrl = mediaUrlFor(clip.absPath);\n  }'],
  ['    shows,\n    bumpers,\n    promos,\n    skipped,', '    shows,\n    bumpers,\n    promos,\n    movies,\n    presentations,\n    skipped,'],
  ['      bumperCount: bumpers.length,\n      promoCount: promos.length,',
   '      bumperCount: bumpers.length,\n      promoCount: promos.length,\n      movieCount: movies.length,\n      presentationCount: presentations.length,'],
]);

console.log(misses.length ? `MISSED ${misses.length}` : 'all wired');
for (const m of misses) console.log('  •', m);
