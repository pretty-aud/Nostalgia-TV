import { describe, it, expect } from 'vitest';
import {
  parseEpisode,
  buildLibrary,
  naturalCompare,
  extractNumbering,
} from '../src/shared/parseEpisode.js';

describe('extractNumbering', () => {
  it('reads the standard SxxExx form', () => {
    expect(extractNumbering('Show S01E02')).toMatchObject({ season: 1, episode: 2 });
    expect(extractNumbering('show.s10e24.720p')).toMatchObject({ season: 10, episode: 24 });
    expect(extractNumbering('Show S1 E5')).toMatchObject({ season: 1, episode: 5 });
    expect(extractNumbering('Show s01.e07')).toMatchObject({ season: 1, episode: 7 });
  });

  it('reads multi-episode files as a span starting at the first episode', () => {
    expect(extractNumbering('Show S01E01-E02')).toMatchObject({
      season: 1, episode: 1, episodeEnd: 2,
    });
    expect(extractNumbering('Show S02E05E06')).toMatchObject({
      season: 2, episode: 5, episodeEnd: 6,
    });
  });

  it('reads the 1x02 form', () => {
    expect(extractNumbering('Show 1x02')).toMatchObject({ season: 1, episode: 2 });
    expect(extractNumbering('Show 12x07 title')).toMatchObject({ season: 12, episode: 7 });
  });

  // The classic failure: a resolution in the filename being read as an episode.
  it('does NOT treat a resolution as a season/episode pair', () => {
    expect(extractNumbering('Show 1920x1080')).not.toMatchObject({ season: 20 });
    const parsed = parseEpisode('Show/Show 1920x1080 pilot.mp4');
    expect(parsed.season).not.toBe(20);
    expect(parsed.episode).not.toBe(108);
  });

  it('does not read 1080p or x264 as an episode number', () => {
    const parsed = parseEpisode('Show/Show.Name.1080p.WEB-DL.x264.mp4');
    expect(parsed.episode).not.toBe(1080);
    expect(parsed.episode).not.toBe(264);
  });

  it('reads spelled-out season/episode', () => {
    expect(extractNumbering('Season 3 Episode 12')).toMatchObject({ season: 3, episode: 12 });
  });

  it('reads date-stamped daily shows in date order', () => {
    const a = extractNumbering('Show 2024.03.15');
    const b = extractNumbering('Show 2024.03.16');
    expect(a.season).toBe(2024);
    expect(b.episode).toBeGreaterThan(a.episode);
  });

  it('returns null when there is genuinely no numbering', () => {
    expect(extractNumbering('The Pilot')).toBeNull();
  });
});

describe('parseEpisode', () => {
  it('takes the show name from the top-level folder', () => {
    const ep = parseEpisode('Peep Show/S01E01 - Warring Factions.mp4');
    expect(ep.showName).toBe('Peep Show');
    expect(ep.season).toBe(1);
    expect(ep.episode).toBe(1);
    expect(ep.title).toBe('Warring Factions');
  });

  it('reads a season subfolder', () => {
    const ep = parseEpisode('Show B/Season 2/ep04.mp4');
    expect(ep.showName).toBe('Show B');
    expect(ep.season).toBe(2);
    expect(ep.episode).toBe(4);
  });

  it('reads an S02-style season subfolder', () => {
    const ep = parseEpisode('Show B/S03/episode 9.mkv');
    expect(ep.season).toBe(3);
    expect(ep.episode).toBe(9);
  });

  it('treats a Specials folder as season 0', () => {
    const ep = parseEpisode('Show C/Specials/ep01.mp4');
    expect(ep.season).toBe(0);
  });

  it('strips a repeated show name out of the title', () => {
    const ep = parseEpisode('Show B/Show B - S01E02 - The Reckoning.mp4');
    expect(ep.showName).toBe('Show B');
    expect(ep.title).toBe('The Reckoning');
  });

  it('cleans release noise out of the title', () => {
    const ep = parseEpisode('Show/Show.S01E03.The.Big.One.1080p.WEB-DL.x264-GRP.mkv');
    expect(ep.title).toBe('The Big One');
  });

  it('derives a show name from a loose file at the root', () => {
    const ep = parseEpisode('Corner Gas - S01E01 - Ruby Reborn.mp4');
    expect(ep.showName).toBe('Corner Gas');
    expect(ep.episode).toBe(1);
  });

  it('flags files it could not parse rather than inventing a number', () => {
    const ep = parseEpisode('Show/the pilot.mp4');
    expect(ep.episode).toBeNull();
    expect(ep.confidence).toBe('none');
  });
});

describe('naturalCompare', () => {
  it('sorts ep2 before ep10', () => {
    const sorted = ['ep10.mp4', 'ep2.mp4', 'ep1.mp4'].sort(naturalCompare);
    expect(sorted).toEqual(['ep1.mp4', 'ep2.mp4', 'ep10.mp4']);
  });
});

describe('buildLibrary', () => {
  const files = [
    'Show A/Show A - S01E02 - Second.mp4',
    'Show A/Show A - S01E01 - First.mp4',
    'Show A/Show A - S02E01 - Third.mp4',
    'Show B/Season 1/ep10.mp4',
    'Show B/Season 1/ep2.mp4',
    'Show B/Season 1/ep1.mp4',
    'Show A/cover.jpg',
    'Show A/.DS_Store',
  ];

  it('groups by show and ignores non-video files', () => {
    const { shows, skipped } = buildLibrary(files);
    expect(shows.map((s) => s.name)).toEqual(['Show A', 'Show B']);
    expect(skipped).toHaveLength(2);
  });

  it('sorts episodes into broadcast order, seasons included', () => {
    const { shows } = buildLibrary(files);
    const a = shows.find((s) => s.name === 'Show A');
    expect(a.episodes.map((e) => `${e.season}-${e.episode}`)).toEqual(['1-1', '1-2', '2-1']);
  });

  it('sorts loose numbering naturally, not lexically', () => {
    const { shows } = buildLibrary(files);
    const b = shows.find((s) => s.name === 'Show B');
    expect(b.episodes.map((e) => e.episode)).toEqual([1, 2, 10]);
  });

  it('sorts specials after the main run so a channel never opens on one', () => {
    const { shows } = buildLibrary([
      'Show C/Specials/Christmas.S00E01.mp4',
      'Show C/Season 1/S01E01.mp4',
      'Show C/Season 1/S01E02.mp4',
    ]);
    const c = shows[0];
    expect(c.episodes[0].season).toBe(1);
    expect(c.episodes[c.episodes.length - 1].season).toBe(0);
  });

  it('marks a show for review when its files could not be parsed', () => {
    const { shows } = buildLibrary(['Show D/whatever.mp4', 'Show D/another.mp4']);
    expect(shows[0].needsReview).toBe(true);
  });

  it('gives every episode a stable index matching its sorted position', () => {
    const { shows } = buildLibrary(files);
    for (const show of shows) {
      expect(show.episodes.map((e) => e.index)).toEqual(show.episodes.map((_, i) => i));
    }
  });
});
