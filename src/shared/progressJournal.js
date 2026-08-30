'use strict';

/**
 * Describe how far each show has moved between two saves.
 *
 * "My progress went backwards" has been reported repeatedly and has never been
 * answerable after the fact: by the time anyone looks, the bad state has been
 * overwritten by a good one, and neither the state file nor its single backup
 * carries a date. This produces the line that gets written to the journal.
 *
 * Pure and separate from the file I/O so it can be tested — a diagnostic that
 * silently produces useless lines is worse than none, because it is only ever
 * read at the moment it is most needed.
 */

/** A compact, order-stable fingerprint of every show's position. */
function digestCursors(cursors) {
  const map = cursors || {};
  return Object.keys(map).sort()
    .map((id) => `${id}:${(map[id] || {}).index}`)
    .join(',');
}

function parseDigest(digest) {
  const out = new Map();
  for (const part of String(digest || '').split(',')) {
    if (!part) continue;
    const cut = part.lastIndexOf(':');
    if (cut === -1) continue;
    out.set(part.slice(0, cut), Number(part.slice(cut + 1)));
  }
  return out;
}

/**
 * What changed, in words. `null` previous means this is the first save seen.
 *
 * BACKWARD is called out explicitly because it is the only direction that
 * represents lost progress — a show moving forward is just someone watching.
 */
function describeChange(previousDigest, cursors) {
  if (previousDigest === null || previousDigest === undefined) return 'first save this session';

  const before = parseDigest(previousDigest);
  const now = cursors || {};
  const notes = [];

  for (const id of Object.keys(now).sort()) {
    const was = before.get(id);
    const is = (now[id] || {}).index;
    if (was === undefined) { notes.push(`${id} NEW at ${is}`); continue; }
    if (was === is) continue;
    notes.push(`${id} ${was}->${is}${is < was ? ' BACKWARD' : ''}`);
  }

  for (const id of [...before.keys()].sort()) {
    if (!(id in now)) notes.push(`${id} DROPPED`);
  }

  return notes.length ? notes.join('; ') : 'no cursor change';
}

module.exports = { digestCursors, describeChange };
