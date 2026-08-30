import { describe, it, expect } from 'vitest';
import { newItems, keyOf } from '../electron/ingest.js';

/**
 * The pure half of the ingest ledger: which titles count as new.
 *
 * The grey/lit state of the Library button rides entirely on this diff, so the
 * rules that keep it honest are pinned here: identity is kind + id (relPath or
 * show id, never absPath), and malformed entries are dropped rather than
 * reported as forever-new.
 */

const show = (id) => ({ kind: 'show', id, absPath: `X:/lib/${id}/E1.mkv` });
const episode = (rel) => ({ kind: 'episode', id: rel, absPath: `X:/lib/${rel}` });

describe('newItems', () => {
  it('reports only what the ledger has never seen', () => {
    const entries = { [keyOf(show('bigo'))]: { at: 1 } };
    const fresh = newItems([show('bigo'), show('lazarus')], entries);
    expect(fresh.map((i) => i.id)).toEqual(['lazarus']);
  });

  it('keys by kind, so a show and an episode never collide', () => {
    // 'show:x' and 'episode:x' are different titles even with the same id text.
    const entries = { 'show:x': { at: 1 } };
    expect(newItems([{ kind: 'episode', id: 'x', absPath: 'X:/x' }], entries)).toHaveLength(1);
  });

  it('is indifferent to absPath — a drive-letter change is not news', () => {
    // The whole point of relPath keying: H: becoming I: must not relight the
    // button for a library that was ingested yesterday.
    const entries = { [keyOf(episode('BigO/S01E01.mkv'))]: { at: 1 } };
    const moved = { kind: 'episode', id: 'BigO/S01E01.mkv', absPath: 'Z:/elsewhere/BigO/S01E01.mkv' };
    expect(newItems([moved], entries)).toHaveLength(0);
  });

  it('drops malformed items instead of reporting them as forever-new', () => {
    const fresh = newItems([null, {}, { kind: 'show' }, { id: 'orphan' }], {});
    expect(fresh).toHaveLength(0);
  });

  it('an empty ledger means everything is new', () => {
    expect(newItems([show('a'), episode('a/1.mkv')], {})).toHaveLength(2);
  });
});
