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
    const entry = entryOf(entries, 'episode', episode.relPath);
    if (!entry || typeof entry.needsWork !== 'boolean') unknown += 1;
    else if (entry.needsWork) needsWork += 1;
    else playsAsIs += 1;
  }
  return { total: (show.episodes || []).length, needsWork, playsAsIs, unknown };
}

function movieVerdict(movie, entries) {
  const entry = entryOf(entries, 'movie', movie.relPath);
  if (!entry || typeof entry.needsWork !== 'boolean') return { known: false };
  return { known: true, needsWork: entry.needsWork, tier: entry.tier || null };
}

/** The conversion cell for a show row. */
function describeShowConversion(summary) {
  if (summary.total === 0) return 'no episodes';
  if (summary.unknown === summary.total) return 'not checked — ingest first';
  const bits = [];
  if (summary.needsWork) bits.push(`${summary.needsWork} need${summary.needsWork === 1 ? 's' : ''} converting`);
  if (summary.playsAsIs) bits.push(`${summary.playsAsIs} play${summary.playsAsIs === 1 ? 's' : ''} as-is`);
  if (summary.unknown) bits.push(`${summary.unknown} not checked`);
  return bits.join(' · ');
}

/** The conversion cell for a movie row. */
function describeMovieConversion(verdict) {
  if (!verdict.known) return 'not checked — ingest first';
  return verdict.needsWork ? 'needs converting' : 'plays as-is';
}

/** The conversion cell for one episode's detail row. */
function describeEpisodeConversion(entries, relPath) {
  const entry = entryOf(entries, 'episode', relPath);
  if (!entry || typeof entry.needsWork !== 'boolean') return 'not checked';
  return entry.needsWork ? 'converts' : 'plays as-is';
}

module.exports = {
  summarizeShow,
  movieVerdict,
  describeShowConversion,
  describeMovieConversion,
  describeEpisodeConversion,
};
