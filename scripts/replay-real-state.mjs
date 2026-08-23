/**
 * Replay the REAL saved state through boot()'s merge + migration.
 *
 * A fixture would have whatever shape I imagined; the file on disk has the
 * shape that actually exists, including the movieEvery: 0 that the "Never"
 * option used to write and that no option in the new menu can represent.
 *
 * Read-only. Nothing here writes to userData.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createState, shouldPlayMovie } from '../src/shared/scheduler.js';

const statePath = path.join(process.env.APPDATA, 'shuffle-tv', 'channel-state.json');
const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));

// The same merge boot() performs.
let state = { ...createState(saved.rootPath), ...saved };
state.settings = { ...createState(null).settings, ...(saved.settings || {}) };

console.log('saved on disk :', JSON.stringify({
  movieEvery: saved.settings.movieEvery,
  moviesEnabled: saved.settings.moviesEnabled,
  lastMovieAt: saved.lastMovieAt,
}));

// The migration, copied from boot().
const MOVIE_INTERVALS = [3, 6, 12, 24, 48];
if (!MOVIE_INTERVALS.includes(Number(state.settings.movieEvery))) {
  state.settings = { ...state.settings, movieEvery: 24 };
}

console.log('after boot    :', JSON.stringify({
  movieEvery: state.settings.movieEvery,
  moviesEnabled: state.settings.moviesEnabled,
}));

const inMenu = MOVIE_INTERVALS.includes(Number(state.settings.movieEvery));
console.log(`menu can show it: ${inMenu ? 'yes' : 'NO — the select would render blank'}`);

const films = [{ relPath: 'MOVIES/x.mkv', fileName: 'x.mkv', name: 'x' }];
console.log(`a movie is due now: ${shouldPlayMovie(state, films, { now: Date.now() })}`);

// Does the library the state points at actually contain a MOVIES folder? The
// switch hides itself without one, so this decides whether she sees it at all.
if (state.rootPath && fs.existsSync(state.rootPath)) {
  const tops = fs.readdirSync(state.rootPath, { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name);
  const movies = tops.filter((n) => /^movies$/i.test(n));
  const pres = tops.filter((n) => /^(?:movie|move)[\s._-]*presentations?$/i.test(n));
  console.log(`root          : ${state.rootPath}`);
  console.log(`MOVIES folder : ${movies.length ? movies.join(', ') : 'NOT PRESENT — the switch stays hidden'}`);
  console.log(`presentation  : ${pres.length ? pres.join(', ') : 'not present'}`);
  if (movies.length) {
    const files = fs.readdirSync(path.join(state.rootPath, movies[0]), { recursive: true })
      .filter((f) => /\.(mkv|mp4|avi|mov|m4v|webm)$/i.test(String(f)));
    console.log(`movie files   : ${files.length}`);
  }
} else {
  console.log(`root          : ${state.rootPath} (not reachable from here)`);
}
