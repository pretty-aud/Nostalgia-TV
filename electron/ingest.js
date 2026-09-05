'use strict';

/**
 * The ingest ledger: which titles have been taken in, and what they need.
 *
 * "Ingesting" a newly scanned show or movie means two things, done once:
 * capture its artwork, and answer "will this need converting before it plays?"
 * The ledger records both, so the Library button can say honestly whether a
 * scan brought anything new — and go grey when it did not — and so a status
 * table can later show conversion needs without re-probing the whole library.
 *
 * Keyed exactly like the artwork store (show id / relPath), so a drive-letter
 * change does not make the whole library look new again. Persisted in its own
 * file under userData rather than in channel state: this is a fact about the
 * FILES, not about anyone's watch progress, and it must survive a state reset.
 */

const path = require('node:path');
const fsp = require('node:fs/promises');

let ledgerPath = null;
let ledger = null;   // { entries: { [key]: { at, tier?, needsWork? } } }
let ledgerMtime = 0; // mtime of the file the cache was read from

function init(options) {
  ledgerPath = options.file;
  ledger = null;
  ledgerMtime = 0;
}

/**
 * Cached, but never past the file's own mtime.
 *
 * A forever-cache burned us: an external tool rewrote the ledger while the
 * app was open, and every table and status readout served the stale memory
 * copy until a restart. The file is ~100 KB — one stat per read is the whole
 * price of always being right about it.
 */
async function load() {
  let mtime = 0;
  try { mtime = (await fsp.stat(ledgerPath)).mtimeMs; } catch { /* no file yet */ }
  if (ledger && mtime === ledgerMtime) return ledger;
  try {
    const parsed = JSON.parse(await fsp.readFile(ledgerPath, 'utf8'));
    ledger = { entries: (parsed && parsed.entries) || {} };
  } catch {
    ledger = { entries: {} };
  }
  ledgerMtime = mtime;
  return ledger;
}

async function save() {
  if (!ledger) return;
  await fsp.mkdir(path.dirname(ledgerPath), { recursive: true });
  const tmp = `${ledgerPath}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(ledger, null, 2));
  await fsp.rename(tmp, ledgerPath);
  try { ledgerMtime = (await fsp.stat(ledgerPath)).mtimeMs; } catch { ledgerMtime = 0; }
}

const keyOf = (item) => `${item.kind}:${item.id}`;

/**
 * Which of these items the ledger has never seen.
 *
 * Pure given the loaded ledger, so the button's grey/lit state is a cheap
 * dictionary diff — no disk reads, no probes, safe to call on every settings
 * open.
 */
function newItems(items, entries) {
  return (items || []).filter((item) => {
    if (!item || !item.kind || !item.id) return false;
    const entry = entries[keyOf(item)];
    if (!entry) return true;
    /**
     * Same name, different bytes: a file swapped in place (the normalised
     * copy replacing an original, a better rip) is a NEW file to judge, and
     * name-only keying was blind to exactly that. Only sizes both sides
     * actually know can disagree — absence stays "already ingested".
     */
    if (Number.isFinite(item.size) && Number.isFinite(entry.size) && item.size !== entry.size) {
      return true;
    }
    return false;
  });
}

async function status(items) {
  const { entries } = await load();
  const fresh = newItems(items, entries);
  return {
    newCount: fresh.length,
    newShows: fresh.filter((i) => i.kind === 'show').length,
    newEpisodes: fresh.filter((i) => i.kind === 'episode').length,
    newMovies: fresh.filter((i) => i.kind === 'movie').length,
  };
}

/**
 * Take in everything new: artwork plus a conversion verdict, one file at a
 * time, with the same courtesy to the disk the background sweep shows.
 *
 * The two halves are deliberately independent: a failed capture still records
 * the conversion verdict, and vice versa — an unreadable frame must not leave
 * a title looking "new" forever.
 */
/** One run at a time: the ledger is a shared mutable object. */
let running = false;

async function run(items, deps) {
  if (running) return { ok: false, busy: true };
  running = true;
  try {
    return await runLocked(items, deps);
  } finally {
    running = false;
  }
}

async function runLocked(items, deps) {
  const { artwork, shouldPause, onProgress } = deps;
  const { entries } = await load();
  const fresh = newItems(items, entries);

  let done = 0;
  let captured = 0;

  for (const item of fresh) {
    // Tell the button WHY nothing is moving: a silent pause while an episode
    // streams reads as a hang, and this loop can legitimately sit for a whole
    // episode's length.
    let announcedWait = false;
    while (shouldPause && shouldPause()) {
      if (onProgress && !announcedWait) {
        announcedWait = true;
        onProgress({ done, total: fresh.length, waiting: true });
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    const record = { at: Date.now() };
    let gotArt = false;

    /**
     * ARTWORK ONLY. The conversion verdict is gone from here.
     *
     * Every new title used to cost a full ffprobe on top of the frame grab,
     * to work out which tier it would need converting to. mpv plays
     * everything, so nothing reads that verdict any more — and once this run
     * stopped being a button and started following every scan, it became an
     * unattended ffprobe of every new file on a USB drive that has dropped
     * off the bus under sustained reads before now. Dead work is bad; dead
     * work nobody asked for, on that drive, is worse.
     */
    if (item.absPath && item.kind !== 'show') {
      try {
        if (await artwork.has(item.kind, item.id)) {
          gotArt = true;
        } else {
          const at = item.kind === 'movie' ? 300 : 90;
          if (await artwork.capture(item.kind, item.id, item.absPath, at)) {
            captured += 1;
            gotArt = true;
          }
        }
      } catch { /* art is best-effort */ }
    }

    /**
     * A show row and a row with no file have nothing to capture, so they are
     * recorded on sight. An EPISODE or MOVIE whose file was unreachable is
     * not: writing it would permanently record "taken in, with nothing", and
     * a drive dropping off mid-run would swallow every remaining title that
     * way. Left out of the ledger, it simply stays new for the next scan.
     */
    const nothingToCapture = !item.absPath || item.kind === 'show';
    if (gotArt || nothingToCapture) {
      entries[keyOf(item)] = record;
      done += 1;
    }
    if (onProgress) onProgress({ done, total: fresh.length });
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  await save();
  return {
    ok: true,
    ingested: done,
    captured,
    shows: fresh.filter((i) => i.kind === 'show').length,
    episodes: fresh.filter((i) => i.kind === 'episode').length,
    movies: fresh.filter((i) => i.kind === 'movie').length,
  };
}

/**
 * A read-only copy of the ledger for the library table. A COPY on purpose:
 * the table must never hold a live reference to the object run() mutates.
 */
module.exports = { init, status, run, newItems, keyOf };
