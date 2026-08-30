'use strict';

/**
 * What the library table says about each title, derived from the ingest
 * ledger — never from probing files.
 *
 * The ledger records, per episode and movie, whether the file will need
 * converting before it plays (see electron/ingest.js). This module turns those
 * records into the rollups and row copy the table shows, and it is pure so the
 * words the table uses are pinned by tests rather than living inline in the
 * renderer.
 */

const entryOf = (entries, kind, id) => entries[`${kind}:${id}`] || null;

/**
 * Does a ledger entry mean a REAL conversion at play time?
 *
 * The planner is deliberately pessimistic: it marks every Matroska file
 * "remux" because it will not PROMISE Chromium demuxes it — but the player
 * measures at first play, and in this library those files play natively.
 * Recording the planner's caution as "needs converting" painted a wall of
 * false warnings over a library that plays fine.
 *
 * So: a remux verdict with the wanted track already FIRST counts as playing
 * as-is — the app hands that file straight to the player. A remux forced by
 * track selection (audioIndex > 0), or any audio/full re-encode, is a real
 * conversion. A remux entry with no recorded audioIndex is from before this
 * distinction existed and counts as unknown, so it gets re-checked rather
 * than guessed about.
 */
function entryConverts(entry) {
  if (!entry || typeof entry.needsWork !== 'boolean') return null;   // unknown
  if (!entry.needsWork) return false;
  if (entry.tier === 'remux') {
    if (!Number.isInteger(entry.audioIndex)) return null;            // pre-fix entry
    return entry.audioIndex > 0;
  }
  return true;
}

/**
 * One show's conversion story, from its episodes' ledger entries.
 *
 * `unknown` counts episodes the ingest has not judged yet — either never
 * ingested, or ingested while the file was unreadable. The table must show
 * that as "not checked", never fold it into "plays as-is": absence of a
 * verdict is not a verdict.
 */
function summarizeShow(show, entries) {
  let needsWork = 0;
  let playsAsIs = 0;
  let unknown = 0;
  for (const episode of show.episodes || []) {
    const converts = entryConverts(entryOf(entries, 'episode', episode.relPath));
    if (converts === null) unknown += 1;
    else if (converts) needsWork += 1;
    else playsAsIs += 1;
  }
  return { total: (show.episodes || []).length, needsWork, playsAsIs, unknown };
}

function movieVerdict(movie, entries) {
  const entry = entryOf(entries, 'movie', movie.relPath);
  const converts = entryConverts(entry);
  if (converts === null) return { known: false };
  return { known: true, needsWork: converts, tier: entry.tier || null };
}

/** The conversion cell for a show row. */
function describeShowConversion(summary) {
  if (summary.total === 0) return 'no episodes';
  if (summary.unknown === summary.total) return 'not checked — ingest first';
  const bits = [];
  // "convert automatically", never "need converting": these conversions are
  // work the app does for itself during the bumper, not a chore on the
  // viewer's list — the old wording read as a to-do.
  if (summary.needsWork) bits.push(`${summary.needsWork} convert${summary.needsWork === 1 ? 's' : ''} automatically`);
  if (summary.playsAsIs) bits.push(`${summary.playsAsIs} play${summary.playsAsIs === 1 ? 's' : ''} as-is`);
  if (summary.unknown) bits.push(`${summary.unknown} not checked`);
  return bits.join(' · ');
}

/** The conversion cell for a movie row. */
function describeMovieConversion(verdict) {
  if (!verdict.known) return 'not checked — ingest first';
  return verdict.needsWork ? 'converts automatically' : 'plays as-is';
}

/** The conversion cell for one episode's detail row. */
function describeEpisodeConversion(entries, relPath) {
  const converts = entryConverts(entryOf(entries, 'episode', relPath));
  if (converts === null) return 'not checked';
  return converts ? 'converts' : 'plays as-is';
}

module.exports = {
  entryConverts,
  summarizeShow,
  movieVerdict,
  describeShowConversion,
  describeMovieConversion,
  describeEpisodeConversion,
};
