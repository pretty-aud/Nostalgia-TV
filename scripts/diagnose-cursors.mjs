/**
 * Where does each saved cursor LAND after a real scan?
 *
 * The saved index is not what the sidebar shows. reconcileCursors re-anchors by
 * PATH against the freshly scanned episode list, so the number on screen is the
 * anchor's position in THIS scan, not the number that was saved. When those two
 * disagree the app looks like it lost progress even though the file is intact.
 *
 * Read-only: scans the real library and reads the real state, writes nothing.
 */

import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { buildLibrary, isVideoFile } from '../src/shared/parseEpisode.js';
import { reconcileCursors } from '../src/shared/scheduler.js';

const statePath = process.argv[2]
  || path.join(process.env.APPDATA, 'shuffle-tv', 'channel-state.json');
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));

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
const after = reconcileCursors(shows, state);

const lastPlayed = new Map();
for (const h of state.history || []) if (h && h.showId && !lastPlayed.has(h.showId)) lastPlayed.set(h.showId, h);

console.log('show'.padEnd(28), 'saved', 'shown', 'anchor found at', '  verdict');
for (const show of shows) {
  const saved = (state.cursors || {})[show.id];
  const savedIndex = saved && Number.isInteger(saved.index) ? saved.index : 0;
  const shown = after[show.id].index;
  const anchor = saved && saved.lastRelPath;
  const at = anchor ? show.episodes.findIndex((e) => e.relPath === anchor) : -1;

  let verdict = 'ok';
  if (anchor && at === -1) verdict = 'ANCHOR FILE IS GONE from this scan';
  else if (shown < savedIndex) verdict = `MOVED BACK ${savedIndex - shown}`;
  else if (shown > savedIndex) verdict = `moved forward ${shown - savedIndex}`;

  const played = lastPlayed.get(show.id);
  const histNote = played ? ` | history: ep#${played.episodeIndex + 1}` : '';

  console.log(
    show.id.padEnd(28),
    String(savedIndex).padEnd(5),
    String(shown).padEnd(5),
    (at === -1 ? (anchor ? 'NOT FOUND' : 'no anchor') : String(at)).padEnd(15),
    verdict + histNote,
  );
}

const star = shows.find((s) => s.id === 'outlaw-star');
if (star) {
  const saved = (state.cursors || {})['outlaw-star'];
  console.log('\n--- outlaw-star detail ---');
  console.log('saved anchor:', saved && saved.lastRelPath);
  console.log('episodes as this scan orders them:');
  star.episodes.slice(0, 10).forEach((e, i) => {
    const mark = saved && e.relPath === saved.lastRelPath ? '  <== saved anchor' : '';
    console.log(`  [${i}] ${e.relPath.split('/').pop()}${mark}`);
  });
  console.log(`  … ${star.episodes.length} episodes total`);
}
