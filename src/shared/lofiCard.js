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

/**
 * A title, upper-cased, with the run length as a suffix when there is one.
 *
 * `x2` rather than `X2`: it is the multiplication sign as an editor would type
 * it, and it is the one lowercase thing on the card, which is what makes it
 * read as a quantity rather than as part of the name.
 */
function titleOf(name, count) {
  const base = String(name || '').toUpperCase();
  return count > 1 ? `${base}  x${count}` : base;
}

/**
 * How many of the SAME show sit consecutively at the front of a list.
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
    title: titleOf(next.movieBlock ? 'MOVIE' : next.showName, nextCount),
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
      title: titleOf(
        after.entry.movieBlock ? 'MOVIE' : after.entry.showName,
        runLength(items, after.at),
      ),
    },
    deduped,
  };
}

/**
 * WHERE THE TEXT SITS, on the thirds.
 *
 * Six anchors, all of them on a third rather than at a corner or the centre —
 * the reference frame puts its block at the lower-left third and lets the
 * picture have the rest, and that is the composition being followed.
 *
 * Both lines of a group share an anchor, because they are one block of
 * information; the second is indented under the first exactly as `3. 45 P . M`
 * sits under `//SHIBUYA-KU// TOKYO`.
 *
 * `bias` is which way the block grows, so text near the right edge is set
 * right-aligned and never runs off.
 */
const ANCHORS = [
  { id: 'lower-left', x: 0.06, y: 0.78, bias: 'left' },
  { id: 'lower-right', x: 0.94, y: 0.78, bias: 'right' },
  { id: 'upper-left', x: 0.06, y: 0.18, bias: 'left' },
  { id: 'upper-right', x: 0.94, y: 0.18, bias: 'right' },
  { id: 'mid-left', x: 0.06, y: 0.46, bias: 'left' },
  { id: 'mid-right', x: 0.94, y: 0.46, bias: 'right' },
];

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
  const first = ANCHORS[n % ANCHORS.length];
  const opposite = ANCHORS.filter((a) => a.bias !== first.bias);
  const second = opposite[Math.trunc(n / ANCHORS.length) % opposite.length];
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
