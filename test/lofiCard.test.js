import { describe, it, expect } from 'vitest';
import {
  wrap, codeOf, titleOf, runLength, linesFor, placementFor, ANCHORS, LOOK_AHEAD,
} from '../src/shared/lofiCard.js';
import { MOVIE_BLOCK } from '../src/shared/scheduler.js';

/**
 * The Minimal Lofi card's WORDS, which is the half of it a person will notice
 * being wrong. A duplicated show name or an "x4" against a single episode is
 * plainly broken; a slightly late cut is only a feeling.
 */
const ep = (showId, showName, season, episode) => ({
  showId, showName, episode: { season, episode },
});
const film = () => ({ movieBlock: true, showId: MOVIE_BLOCK });

describe('the card vocabulary', () => {
  it('wraps the label in slashes, as the reference does', () => {
    expect(wrap('up next')).toBe('//UP NEXT//');
  });

  it('spaces the episode code the way the reference spaces its clock', () => {
    // "3. 45 P . M" floats a period between letters. The code does the same.
    expect(codeOf(ep('a', 'A', 1, 5))).toBe('S01 . E05');
    expect(codeOf(ep('a', 'A', 12, 103))).toBe('S12 . E103');
  });

  it('gives a film a word rather than a made-up code', () => {
    expect(codeOf(film())).toBe('FEATURE');
  });

  it('has no code to show when the episode numbering is unknown', () => {
    expect(codeOf({ showId: 'a', showName: 'A', episode: {} })).toBe('');
  });

  it('never carries the count itself', () => {
    expect(titleOf('Scavengers Reign')).toBe('SCAVENGERS REIGN');
    // The count is NOT part of the title. Glued on it came out as X2, because
    // the card upper-cases the whole group — it has to be a separate node so
    // CSS can leave it alone.
    expect(titleOf('Scavengers Reign')).not.toMatch(/x/);
  });
});

describe('counting a block', () => {
  it('counts consecutive episodes of one show', () => {
    expect(runLength([ep('a', 'A', 1, 1), ep('a', 'A', 1, 2), ep('b', 'B', 1, 1)])).toBe(2);
  });

  /**
   * FROM THE QUEUE, NOT FROM THE SETTING, and they genuinely differ: a block is
   * cut short when a show runs out of episodes, and a schedule can place the
   * same show in two consecutive blocks so they read as one longer run. The
   * queue is what will actually play.
   */
  it('reads a short final block as its real length', () => {
    // Block size is 3, but this show has one episode left.
    expect(runLength([ep('a', 'A', 1, 9), ep('b', 'B', 1, 1)])).toBe(1);
  });

  it('reads two consecutive blocks of one show as a single run', () => {
    const items = [ep('a', 'A', 1, 1), ep('a', 'A', 1, 2), ep('a', 'A', 1, 3), ep('a', 'A', 1, 4), ep('b', 'B', 1, 1)];
    expect(runLength(items)).toBe(4);
  });
});

describe('the two lines', () => {
  it('names what is next and what genuinely follows it', () => {
    const lines = linesFor([ep('a', 'Alpha', 1, 1), ep('b', 'Beta', 2, 7)]);
    expect(lines.first.label).toBe('//UP NEXT//');
    expect(lines.first.title).toBe('ALPHA');
    expect(lines.first.code).toBe('S01 . E01');
    expect(lines.second.label).toBe('//FOLLOWED BY//');
    expect(lines.second.title).toBe('BETA');
    expect(lines.second.code).toBe('S02 . E07');
  });

  /**
   * HER RULE, and the reason this module exists. Two blocks of Alpha then Beta:
   * the card must not say ALPHA twice.
   */
  it('skips a duplicate and names the first different show', () => {
    const lines = linesFor([
      ep('a', 'Alpha', 1, 1), ep('a', 'Alpha', 1, 2),
      ep('a', 'Alpha', 1, 3),
      ep('b', 'Beta', 1, 1),
    ]);
    expect(lines.first.title).toBe('ALPHA');
    expect(lines.first.count).toBe(3);
    expect(lines.second.title).toBe('BETA');
    expect(lines.deduped).toBe(true);
  });

  it('counts the followed-by block too, not just the next one', () => {
    const lines = linesFor([
      ep('a', 'Alpha', 1, 1),
      ep('b', 'Beta', 1, 1), ep('b', 'Beta', 1, 2),
      ep('c', 'Gamma', 1, 1),
    ]);
    expect(lines.first.title).toBe('ALPHA');
    expect(lines.second.title).toBe('BETA');
    expect(lines.second.count).toBe(2);
  });

  /**
   * A MARATHON. Nothing different is coming, and the card must neither repeat
   * the name nor drop a beat — it carries the episode code instead. Her choice,
   * from three offered.
   */
  it('says the episode rather than repeating the show when nothing else follows', () => {
    const lines = linesFor([
      ep('a', 'Alpha', 1, 1), ep('a', 'Alpha', 1, 2), ep('a', 'Alpha', 1, 3),
    ]);
    expect(lines.first.title).toBe('ALPHA');
    expect(lines.first.count).toBe(3);
    expect(lines.second.label).toBe('//THEN//');
    expect(lines.second.title).not.toMatch(/ALPHA/);
    expect(lines.second.title).toBe('S01 . E02');
  });

  it('still fills the second line when the queue holds exactly one item', () => {
    const lines = linesFor([ep('a', 'Alpha', 1, 1)]);
    expect(lines.first.title).toBe('ALPHA');
    expect(lines.second.title).toBe('CONTINUES');
  });

  it('has nothing to say about an empty queue', () => {
    expect(linesFor([])).toBe(null);
    expect(linesFor(null)).toBe(null);
  });

  it('handles a placed film as the thing coming up', () => {
    const lines = linesFor([film(), ep('b', 'Beta', 1, 1)]);
    expect(lines.first.title).toBe('MOVIE');
    expect(lines.first.code).toBe('FEATURE');
    expect(lines.second.title).toBe('BETA');
  });

  /**
   * A very long run must not send the search down the whole running order. It
   * gives up at LOOK_AHEAD and falls back to the episode line, which is the
   * same honest answer as a marathon.
   */
  it('gives up looking after a bounded distance', () => {
    const many = Array.from({ length: 40 }, (_, i) => ep('a', 'Alpha', 1, i + 1));
    const lines = linesFor([...many, ep('b', 'Beta', 1, 1)]);
    expect(lines.second.label).toBe('//THEN//');
    expect(lines.second.title).toBe('S01 . E02');
  });

  it('finds a different show that sits just inside the bound', () => {
    const run = Array.from({ length: LOOK_AHEAD - 1 }, (_, i) => ep('a', 'Alpha', 1, i + 1));
    const lines = linesFor([...run, ep('b', 'Beta', 1, 1)]);
    expect(lines.second.title).toBe('BETA');
  });
});

describe('where it sits in the frame', () => {
  it('covers the whole thirds grid, not just two edges', () => {
    // It landed in the same two places because every anchor was pinned to the
    // far left or far right. Three columns and three rows, all present.
    expect(new Set(ANCHORS.map((a) => a.col))).toEqual(new Set(['left', 'mid', 'right']));
    expect(new Set(ANCHORS.map((a) => a.row))).toEqual(new Set(['top', 'mid', 'low']));
    expect(ANCHORS).toHaveLength(9);
  });

  it('keeps every anchor inside a safe margin', () => {
    for (const a of ANCHORS) {
      expect(a.x, `${a.id} x`).toBeGreaterThanOrEqual(0.08);
      expect(a.x, `${a.id} x`).toBeLessThanOrEqual(0.92);
      expect(a.y, `${a.id} y`).toBeGreaterThan(0.1);
      expect(a.y, `${a.id} y`).toBeLessThan(0.85);
    }
  });

  /**
   * DETERMINISTIC, which is the only reason a screenshot probe can assert what
   * it photographed. Placement by Math.random could be reviewed by eye and by
   * nothing else.
   */
  it('gives the same seed the same placement', () => {
    for (const seed of [0, 1, 7, 41, 1234]) {
      expect(placementFor(seed)).toEqual(placementFor(seed));
    }
  });

  /**
   * A DIFFERENT COLUMN AND A DIFFERENT ROW, which is what actually stops a
   * collision — a long show name is wide, so two blocks sharing a row would
   * overlap even from opposite sides, and only some seeds would reveal it.
   */
  it('never puts the two groups in the same row or column', () => {
    for (let seed = 0; seed < 200; seed += 1) {
      const { first, second } = placementFor(seed);
      expect(first.col, `seed ${seed} column`).not.toBe(second.col);
      expect(first.row, `seed ${seed} row`).not.toBe(second.row);
    }
  });

  /**
   * THE COMPLAINT THAT PROMPTED THIS. Six anchors existed and the text still
   * only ever appeared in two places, because the seed was the show's title —
   * stable per show — and the anchors were all on two edges. Both are fixed, so
   * the test asks for real spread rather than for the list to be long.
   */
  it('actually reaches most of the grid across a run of cards', () => {
    const seen = new Set();
    for (let card = 1; card <= 12; card += 1) {
      // The renderer's seed: a card counter plus the title's characters.
      const seed = card * 7 + [...'TRIGUN'].reduce((a, c) => a + c.charCodeAt(0), 0);
      seen.add(placementFor(seed).first.id);
    }
    expect(seen.size, `only reached ${[...seen].join(', ')}`).toBeGreaterThanOrEqual(6);
  });

  it('does not put the same show in the same place every time', () => {
    const title = [...'SCAVENGERS REIGN'].reduce((a, c) => a + c.charCodeAt(0), 0);
    const first = placementFor(1 * 7 + title).first.id;
    const second = placementFor(2 * 7 + title).first.id;
    expect(second).not.toBe(first);
  });
});
