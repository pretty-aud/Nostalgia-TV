'use strict';

/**
 * Break a show title where its own punctuation says it should break.
 *
 * The Up next list gives a title one narrow column, and this library is full
 * of names that do not fit in it: "Ghost in the Shell - Stand Alone Complex",
 * and the Mobile Suit Gundam titles to come. Left to itself the line broke
 * wherever the column ran out — usually orphaning the episode code onto a
 * line of its own, which reads as the text falling out of the row rather than
 * as a title with two parts.
 *
 * A dash WITH SPACES AROUND IT is never part of a word. It is the seam
 * between a series and its subtitle, which is exactly where a human would
 * break the line, so that is where this breaks it:
 *
 *   Ghost in the Shell - Stand Alone Complex  ->  Ghost in the Shell
 *                                                 Stand Alone Complex
 *
 * ONCE, at the first seam. "Rurouni Kenshin - Trust and Betrayal -
 * Director's Cut" becomes two lines and not three: the row has a fixed
 * height budget, and a title that keeps subdividing would push the list off
 * the bottom of the sidebar.
 *
 * En and em dashes count too. They are the same typographic seam, they turn
 * up in real release names, and nothing is lost by accepting them — a spaced
 * dash of any width is a separator, never a hyphenated word.
 */

/** ASCII hyphen, en dash, em dash — each surrounded by whitespace. */
const SEAM = /\s+[-–—]\s+/;

/**
 * The lines to draw for a title: one, or two when it has a seam.
 *
 * Never returns an empty line, and never returns a single-line result as an
 * empty array — callers render exactly what comes back, so " - Subtitle" and
 * "Series - " have to degrade to the original string rather than to a blank
 * row.
 */
function titleLines(name) {
  const title = String(name == null ? '' : name).trim();
  if (!title) return [''];

  const at = title.search(SEAM);
  if (at < 0) return [title];

  const seam = SEAM.exec(title);
  const head = title.slice(0, at).trim();
  const tail = title.slice(at + seam[0].length).trim();
  // A seam at either end is punctuation, not structure.
  if (!head || !tail) return [title];
  return [head, tail];
}

/** Does this title have a seam to break at? Useful for tests and callers. */
function hasSeam(name) {
  return titleLines(name).length > 1;
}

module.exports = { titleLines, hasSeam, SEAM };
