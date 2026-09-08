'use strict';

/**
 * WHAT THE MINIMAL LOFI CARD SAYS, and where it puts it.
 *
 * Pure — no DOM, no state, no clock. The card driver in the renderer asks this
 * what to draw and then draws it. That split is the point: "does it skip a
 * duplicate, does it count a block correctly, does it place two lines that do
 * not collide" are all answerable at a desk, and none of them are answerable by
 * looking at a fifteen-second video.
 */

const { MOVIE_BLOCK, isMovieBlock } = require('./scheduler.js');

/**
 * How far down the queue to look for something DIFFERENT to follow with.
 *
 * A block of one show is often several episodes, and she may have several
 * blocks of it in a row, so the first different title can be a long way down.
 * Six is enough for three blocks of two without being a scan of the whole
 * running order.
 */
const LOOK_AHEAD = 8;

/**
 * The card's own vocabulary, kept together so the look is one decision.
 *
 * From her reference frame: a `//`-wrapped primary token with a second,
 * unwrapped one beside it, and irregular spacing carried by PUNCTUATION rather
 * than by the letters. `3. 45 P . M` puts a period hard against the 3 and then
 * floats one between P and M — it is the stops that are spaced oddly, not the
 * words, which is what keeps it legible while still looking wrong on purpose.
 */
function wrap(token) {
  return `//${String(token).toUpperCase()}//`;
}

/**
 * An episode code in the reference's punctuation: `S01 . E05`.
 *
 * The space-period-space is the `P . M` treatment. A movie has no code, so it
 * gets the word instead of a fake one.
 */
function codeOf(entry) {
  if (!entry) return '';
  if (entry.movieBlock || entry.isMovie) return 'FEATURE';
  const s = entry.episode && entry.episode.season;
  const e = entry.episode && entry.episode.episode;
  if (!Number.isFinite(s) || !Number.isFinite(e)) return '';
  return `S${String(s).padStart(2, '0')} . E${String(e).padStart(2, '0')}`;
}

/** A title, upper-cased. Just the name — no run count, by her decision. */
function titleOf(name) {
  return String(name || '').toUpperCase();
}

/**
 * How many of the SAME show sit consecutively at the front of a list.
 *
 * Used by the DEDUP search rather than shown: the card no longer prints "x2",
 * but knowing how long a run is remains how it finds where the next different
 * programme begins.
 *
 * Counted from the queue as built, not from the block-size setting, and those
 * genuinely differ: a block is cut short when a show runs out of episodes, and
 * a schedule can place the same show twice in a row so two blocks read as one
 * longer run. The queue is what will actually play; the setting is what was
 * asked for.
 */
function runLength(items, from = 0) {
  const first = items[from];
  if (!first) return 0;
  const key = first.movieBlock ? MOVIE_BLOCK : first.showId;
  let n = 0;
  for (let i = from; i < items.length; i += 1) {
    const k = items[i].movieBlock ? MOVIE_BLOCK : items[i].showId;
    if (k !== key) break;
    n += 1;
  }
  return n;
}

/**
 * The two lines the card shows, with the duplicate skipped.
 *
 * Her rule: if what is up next and what follows it are the same show, the
 * follow-up is whatever comes after that instead. The card never says a name
 * twice.
 *
 * And when there is nothing different to say — a marathon, or a queue too short
 * to hold two shows — the second line does NOT repeat the name and does not
 * vanish either. It carries the episode code of what actually plays next, which
 * keeps the card's three-beat rhythm, tells her something true, and is already
 * in the card's vocabulary. Her call, given the choice.
 */
function linesFor(upcoming) {
  const items = (upcoming || []).filter(Boolean);
  const next = items[0];
  if (!next) return null;

  const nextCount = runLength(items, 0);
  const nextKey = next.movieBlock ? MOVIE_BLOCK : next.showId;

  // The first entry that is a DIFFERENT programme.
  let after = null;
  for (let i = nextCount; i < Math.min(items.length, LOOK_AHEAD); i += 1) {
    const k = items[i].movieBlock ? MOVIE_BLOCK : items[i].showId;
    if (k !== nextKey) { after = { entry: items[i], at: i }; break; }
  }

  const first = {
    label: wrap('up next'),
    code: codeOf(next),
    title: titleOf(next.movieBlock ? 'MOVIE' : next.showName),
  };

  /**
   * Did a naive card have a duplicate to avoid? That is what this flag means —
   * would taking items[1] have named the same show twice — and it is the
   * honest test of whether the rule did any work.
   *
   * The first version asked whether the different show sat further along than
   * the run, which is false for the commonest case of all: three episodes of
   * Alpha then Beta skips two duplicates and yet the search still finds Beta at
   * exactly the end of the run.
   */
  const secondKey = items[1] && (items[1].movieBlock ? MOVIE_BLOCK : items[1].showId);
  const deduped = Boolean(items[1]) && secondKey === nextKey;

  if (!after) {
    /**
     * NOTHING DIFFERENT IS COMING. The second line still appears — the card is
     * built on three beats and dropping one would leave a hole — but it names
     * the episode rather than repeating the show.
     *
     * The episode it names is the one that plays AFTER the one on the first
     * line, which is items[1]. Reaching past the whole run instead named the
     * episode at the far end of it, or nothing at all when the run was the
     * entire queue — a "CONTINUES" that appeared exactly when there was most to
     * say.
     */
    const following = items[1] || null;
    return {
      first,
      second: {
        label: wrap('then'),
        code: '',
        title: following ? (codeOf(following) || 'CONTINUES') : 'CONTINUES',
      },
      deduped,
    };
  }

  return {
    first,
    second: {
      label: wrap('followed by'),
      code: codeOf(after.entry),
      title: titleOf(after.entry.movieBlock ? 'MOVIE' : after.entry.showName),
    },
    deduped,
  };
}

/**
 * WHERE THE TEXT SITS, on the thirds.
 *
 * The full thirds grid: three columns by three rows, nine positions. It began
 * as six, all pinned to the far left or far right edge, and the text visibly
 * only ever appeared in two places — "dynamic placement" that had two columns
 * to be dynamic across. The centre column is what actually opened it up.
 *
 * Both lines of a group share an anchor, because they are one block of
 * information; the second is indented under the first exactly as `3. 45 P . M`
 * sits under `//SHIBUYA-KU// TOKYO`.
 *
 * `bias` is which way the block grows, so text near the right edge is set
 * right-aligned and never runs off.
 */
/**
 * FIVE COLUMNS, and the middle one is rare.
 *
 * It was three, and the text kept landing dead centre. Two causes, and the
 * second is the one that did the damage: the first group picks evenly across
 * the grid, so a third of cards started centre — but the SECOND group must sit
 * in a different column and row, which left only four candidates, and two of
 * those four were centre. Half of all second groups, by construction.
 *
 * Adding the two third-columns fixes the arithmetic, since there are now more
 * off-centre places to land than centre ones at every stage. The weight makes
 * it deliberate rather than merely diluted: dead centre is a strong, static
 * place to put type and it should be an occasional choice, not the default one.
 *
 * 0.33 and 0.67 are the actual thirds — the reference frame sets its block at
 * one — while 0.08 and 0.92 are the safe margins.
 */
const ANCHORS = [
  { id: 'upper-left', x: 0.08, y: 0.17, bias: 'left', col: 'left', row: 'top', weight: 3 },
  { id: 'upper-third-left', x: 0.33, y: 0.17, bias: 'left', col: 'left-third', row: 'top', weight: 3 },
  { id: 'upper-centre', x: 0.50, y: 0.17, bias: 'centre', col: 'mid', row: 'top', weight: 1 },
  { id: 'upper-third-right', x: 0.67, y: 0.17, bias: 'right', col: 'right-third', row: 'top', weight: 3 },
  { id: 'upper-right', x: 0.92, y: 0.17, bias: 'right', col: 'right', row: 'top', weight: 3 },

  { id: 'mid-left', x: 0.08, y: 0.45, bias: 'left', col: 'left', row: 'mid', weight: 3 },
  { id: 'mid-third-left', x: 0.33, y: 0.45, bias: 'left', col: 'left-third', row: 'mid', weight: 3 },
  { id: 'mid-centre', x: 0.50, y: 0.45, bias: 'centre', col: 'mid', row: 'mid', weight: 1 },
  { id: 'mid-third-right', x: 0.67, y: 0.45, bias: 'right', col: 'right-third', row: 'mid', weight: 3 },
  { id: 'mid-right', x: 0.92, y: 0.45, bias: 'right', col: 'right', row: 'mid', weight: 3 },

  { id: 'lower-left', x: 0.08, y: 0.76, bias: 'left', col: 'left', row: 'low', weight: 3 },
  { id: 'lower-third-left', x: 0.33, y: 0.76, bias: 'left', col: 'left-third', row: 'low', weight: 3 },
  { id: 'lower-centre', x: 0.50, y: 0.76, bias: 'centre', col: 'mid', row: 'low', weight: 1 },
  { id: 'lower-third-right', x: 0.67, y: 0.76, bias: 'right', col: 'right-third', row: 'low', weight: 3 },
  { id: 'lower-right', x: 0.92, y: 0.76, bias: 'right', col: 'right', row: 'low', weight: 3 },
];

/**
 * Pick from a list by weight, deterministically.
 *
 * A plain `list[n % list.length]` cannot express "this one less often", and
 * repeating an anchor in the array to fake a weight would mean the same
 * position appearing twice in any count of what the grid covers.
 */
function weightedPick(list, n) {
  const total = list.reduce((sum, a) => sum + (a.weight || 1), 0);
  let at = n % total;
  for (const anchor of list) {
    at -= (anchor.weight || 1);
    if (at < 0) return anchor;
  }
  return list[list.length - 1];
}

/**
 * Two anchors for one card: one per group, and never the same one twice.
 *
 * DETERMINISTIC from a seed, which is the only reason a screenshot probe can
 * assert what it photographed. A card that placed its text by Math.random
 * could only ever be reviewed by eye, and this project has learned what that
 * costs.
 *
 * The second group is placed on the OPPOSITE side, so the two never overlap
 * whatever the seed — a rule rather than a hope, since a long show name plus a
 * long code is wide enough that two blocks on the same side would collide and
 * only some seeds would reveal it.
 */
function placementFor(seed) {
  const n = Math.abs(Math.trunc(seed)) || 0;
  const first = weightedPick(ANCHORS, n);

  /**
   * A DIFFERENT COLUMN AND A DIFFERENT ROW, not merely a different side.
   *
   * The rule used to be "opposite bias", which with six edge-pinned anchors
   * left only three candidates and made the second group predictable from the
   * first. Requiring both coordinates to differ keeps the two blocks from ever
   * sharing a line or a column — which is what actually prevents a collision,
   * since a long show name is wide — while leaving four genuine choices.
   */
  const apart = ANCHORS.filter((a) => a.col !== first.col && a.row !== first.row);
  // Weighted here too. This was the worse half of the problem: with three
  // columns the filter left four candidates, two of them centre, so half of all
  // second groups were centred no matter what the first group did.
  const second = weightedPick(apart, Math.trunc(n / ANCHORS.length));
  return { first, second };
}

module.exports = {
  LOOK_AHEAD,
  ANCHORS,
  wrap,
  codeOf,
  titleOf,
  runLength,
  linesFor,
  placementFor,
};
