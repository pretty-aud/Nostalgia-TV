/**
 * Rebuild the state as it exists just after a scan, then try to save it.
 *
 * `state:save` swallows its own errors and resolves with { ok:false }, and the
 * renderer never looked — so a failing save is invisible. This performs the two
 * steps that save actually depends on, against the real library and the real
 * saved file: the structured clone the IPC boundary does, and the
 * JSON.stringify the writer does.
 *
 * Read-only with respect to the app's data.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { buildLibrary, isVideoFile } from '../src/shared/parseEpisode.js';
import {
  createState, reconcileCursors, pruneQueue, refillQueue,
} from '../src/shared/scheduler.js';

const statePath = path.join(process.env.APPDATA, 'shuffle-tv', 'channel-state.json');
const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));

// boot()'s merge
let state = { ...createState(saved.rootPath), ...saved };
state.settings = { ...createState(null).settings, ...(saved.settings || {}) };
state.settings.subtitles = {
  ...createState(null).settings.subtitles,
  ...((saved.settings || {}).subtitles || {}),
};
const MOVIE_INTERVALS = [3, 6, 12, 24, 48];
if (!MOVIE_INTERVALS.includes(Number(state.settings.movieEvery))) {
  state.settings = { ...state.settings, movieEvery: 24 };
}

async function walk(root) {
  const found = [];
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift();
    if (depth > 6) break;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) queue.push({ dir: full, depth: depth + 1 });
      else if (e.isFile() && isVideoFile(e.name)) {
        found.push({ relPath: path.relative(root, full).split(path.sep).join('/'), absPath: full, size: 0 });
      }
    }
  }
  return found;
}

const { shows } = buildLibrary(await walk(state.rootPath), { rootName: path.basename(state.rootPath) });

// loadLibrary's tail
state.cursors = reconcileCursors(shows, state);
state.queue = pruneQueue(shows, state.queue);
const filled = refillQueue(shows, state, {});
state.queue = filled.queue;
state.deck = filled.deck;

console.log(`state rebuilt: ${Object.keys(state.cursors).length} cursors, queue ${state.queue.length}\n`);

// 1. the structured clone the IPC boundary performs
try {
  structuredClone(state);
  console.log('structuredClone : OK');
} catch (error) {
  console.log('structuredClone : FAILED —', error.message);
}

// 2. the stringify the writer performs
let json = null;
try {
  json = JSON.stringify(state, null, 2);
  console.log(`JSON.stringify  : OK (${json.length} bytes)`);
} catch (error) {
  console.log('JSON.stringify  : FAILED —', error.message);
}

// 3. anything in here that would not survive a round trip
if (json) {
  const back = JSON.parse(json);
  const lost = [];
  const compare = (a, b, at) => {
    for (const key of Object.keys(a || {})) {
      const va = a[key];
      const vb = (b || {})[key];
      if (typeof va === 'function' || typeof va === 'undefined') { lost.push(`${at}${key} (${typeof va})`); continue; }
      if (va && typeof va === 'object' && !Array.isArray(va)) compare(va, vb, `${at}${key}.`);
    }
  };
  compare(state, back, '');
  console.log('round trip      :', lost.length ? `LOSES ${lost.join(', ')}` : 'clean');
}
