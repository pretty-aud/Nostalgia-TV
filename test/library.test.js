import { describe, it, expect } from 'vitest';
import { buildLibrary } from '../src/shared/parseEpisode.js';

/**
 * The library model, stated as a test.
 *
 * You point the app at ONE folder. Every folder inside it is a show, named by
 * that folder. The files inside are its episodes. This is the contract the
 * bumper depends on — it announces `show.name`, so if grouping is wrong the
 * bumper confidently announces the wrong thing.
 */

const paths = (...relPaths) => relPaths.map((relPath) => ({ relPath, absPath: `D:/TV/${relPath}` }));

describe('one root folder, one folder per show', () => {
  it('names each show after its folder', () => {
    const { shows } = buildLibrary(paths(
      'Seinfeld/S01E01.mkv',
      'Seinfeld/S01E02.mkv',
      'The Office/S02E03.mkv',
    ), { rootName: 'TV' });

    expect(shows.map((s) => s.name)).toEqual(['Seinfeld', 'The Office']);
    expect(shows.find((s) => s.name === 'Seinfeld').episodes).toHaveLength(2);
  });

  it('keeps season subfolders inside their show rather than splitting them out', () => {
    const { shows } = buildLibrary(paths(
      'The Office/Season 1/S01E01.mkv',
      'The Office/Season 2/S02E01.mkv',
    ), { rootName: 'TV' });

    expect(shows).toHaveLength(1);
    expect(shows[0].name).toBe('The Office');
    expect(shows[0].episodes).toHaveLength(2);
    // Broadcast order across seasons, which is what "in order" has to mean.
    expect(shows[0].episodes.map((e) => e.season)).toEqual([1, 2]);
  });

  it('does not let a messy filename override the folder name', () => {
    // Release names carry the show name in a different form; the folder is the
    // authority, so "Seinfeld" does not fragment into three separate shows.
    const { shows } = buildLibrary(paths(
      'Seinfeld/seinfeld.s01e01.1080p.web-dl.x264-GROUP.mkv',
      'Seinfeld/Seinfeld - S01E02 - The Stakeout.mkv',
      'Seinfeld/S01E03.mkv',
    ), { rootName: 'TV' });

    expect(shows).toHaveLength(1);
    expect(shows[0].name).toBe('Seinfeld');
    expect(shows[0].episodes.map((e) => e.episode)).toEqual([1, 2, 3]);
  });

  it('falls back to the chosen folder when it IS the show', () => {
    // Pointing at a single show's folder: the files have no folder above them,
    // so without this the show would be named from whatever the filename says.
    const { shows } = buildLibrary(paths('S01E01.mkv', 'S01E02.mkv'), { rootName: 'Seinfeld' });
    expect(shows).toHaveLength(1);
    expect(shows[0].name).toBe('Seinfeld');
  });

  it('does not name a show after a season folder', () => {
    const { shows } = buildLibrary(
      paths('Season 1/S01E01.mkv', 'Season 2/S02E01.mkv'),
      { rootName: 'Sopranos' },
    );
    expect(shows.map((s) => s.name)).toEqual(['Sopranos']);
    expect(shows[0].episodes).toHaveLength(2);
  });

  it('groups every episode of a show under one id so progress survives a rescan', () => {
    const { shows } = buildLibrary(paths(
      'Star Trek/S01E01.mkv',
      'Star Trek/Season 2/S02E01.mkv',
      'Star Trek/Specials/S00E01.mkv',
    ), { rootName: 'TV' });

    expect(shows).toHaveLength(1);
    expect(shows[0].id).toBe('star-trek');
    // Specials sort last: a channel should not open a show on a Christmas
    // special instead of the pilot.
    expect(shows[0].episodes.at(-1).season).toBe(0);
  });
});
