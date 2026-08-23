import { describe, it, expect } from 'vitest';
import { digestCursors, describeChange } from '../src/shared/progressJournal.js';

/**
 * The journal exists to answer one question after the fact: did a show's
 * position go backwards, and when? A diagnostic is only ever read at the moment
 * it matters most, so it has to be right before it is needed rather than after.
 */

const at = (pairs) => Object.fromEntries(
  Object.entries(pairs).map(([id, index]) => [id, { index, lastRelPath: `${id}/e${index}.mkv` }]),
);

describe('digestCursors', () => {
  it('is stable regardless of key order', () => {
    expect(digestCursors(at({ b: 2, a: 1 }))).toBe(digestCursors(at({ a: 1, b: 2 })));
  });

  it('changes when any show moves', () => {
    expect(digestCursors(at({ a: 1 }))).not.toBe(digestCursors(at({ a: 2 })));
  });

  it('survives a missing cursors object', () => {
    expect(digestCursors(null)).toBe('');
  });
});

describe('describeChange', () => {
  it('names a backward move as BACKWARD, which is the whole point', () => {
    const before = digestCursors(at({ 'outlaw-star': 5 }));
    expect(describeChange(before, at({ 'outlaw-star': 3 })))
      .toBe('outlaw-star 5->3 BACKWARD');
  });

  it('does not cry wolf when a show simply advances', () => {
    const before = digestCursors(at({ 'outlaw-star': 5 }));
    const line = describeChange(before, at({ 'outlaw-star': 6 }));
    expect(line).toBe('outlaw-star 5->6');
    expect(line).not.toContain('BACKWARD');
  });

  it('reports a show that vanished from the scan', () => {
    const before = digestCursors(at({ trigun: 3, 'big-o': 2 }));
    expect(describeChange(before, at({ trigun: 3 }))).toBe('big-o DROPPED');
  });

  it('reports a newly seen show without calling it a move', () => {
    const before = digestCursors(at({ trigun: 3 }));
    expect(describeChange(before, at({ trigun: 3, primal: 0 }))).toBe('primal NEW at 0');
  });

  it('says nothing changed rather than writing an empty line', () => {
    const before = digestCursors(at({ trigun: 3 }));
    expect(describeChange(before, at({ trigun: 3 }))).toBe('no cursor change');
  });

  it('marks the first save of a session', () => {
    expect(describeChange(null, at({ trigun: 3 }))).toBe('first save this session');
  });

  it('lists every show that moved, not just the first', () => {
    const before = digestCursors(at({ a: 4, b: 4, c: 4 }));
    const line = describeChange(before, at({ a: 5, b: 2, c: 4 }));
    expect(line).toContain('a 4->5');
    expect(line).toContain('b 4->2 BACKWARD');
    expect(line).not.toContain('c ');
  });
});
