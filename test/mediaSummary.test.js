import { describe, it, expect } from 'vitest';
import { mediaSummary, summaryLine, resolutionLabel } from '../src/shared/mediaSummary.js';

const video = (width, height) => ({ type: 'video', width, height });
const audio = (language) => ({ type: 'audio', language });
const subtitle = (language) => ({ type: 'subtitle', language });

describe('resolutionLabel', () => {
  it('names the common shapes', () => {
    expect(resolutionLabel(3840, 2160)).toBe('4K');
    expect(resolutionLabel(2560, 1440)).toBe('1440p');
    expect(resolutionLabel(1920, 1080)).toBe('1080p');
    expect(resolutionLabel(1280, 720)).toBe('720p');
    expect(resolutionLabel(1024, 576)).toBe('576p');
    expect(resolutionLabel(854, 480)).toBe('480p');
    expect(resolutionLabel(640, 360)).toBe('360p');
  });

  it('does not demote a letterboxed scope encode', () => {
    // 2.39:1 at 1080p is commonly stored 1920x816 with the bars cut. Judging
    // that by its 816 pixels would call it 720p, which is wrong and is the
    // whole reason this is not a plain height lookup.
    expect(resolutionLabel(1920, 816)).toBe('1080p');
    expect(resolutionLabel(1920, 800)).toBe('1080p');
    expect(resolutionLabel(1280, 536)).toBe('720p');
  });

  it('leaves 4:3 and anamorphic material where it belongs', () => {
    expect(resolutionLabel(720, 480)).toBe('480p');
    expect(resolutionLabel(640, 480)).toBe('480p');
    expect(resolutionLabel(1440, 1080)).toBe('1080p');
  });

  it('gives the exact size rather than a wrong label', () => {
    expect(resolutionLabel(160, 120)).toBe('160×120');
  });

  it('says nothing when it has nothing', () => {
    expect(resolutionLabel(0, 0)).toBeNull();
    expect(resolutionLabel(null, null)).toBeNull();
    expect(resolutionLabel(undefined, 1080)).toBeNull();
  });
});

describe('mediaSummary', () => {
  it('reads her Kenshin file: one Japanese track and English subtitles', () => {
    const s = mediaSummary([
      video(1920, 1080),
      audio('jpn'),
      subtitle('eng'),
    ]);
    expect(s.resolution).toBe('1080p');
    expect(s.audio).toEqual(['Japanese']);
    expect(s.subtitles).toEqual(['English']);
    expect(s.hasSubtitles).toBe(true);
  });

  it('lists a dual-audio release once per language', () => {
    const s = mediaSummary([video(1280, 720), audio('eng'), audio('jpn')]);
    expect(s.audio).toEqual(['English', 'Japanese']);
    expect(s.audioCount).toBe(2);
  });

  it('keeps the COUNT when two tracks share a language', () => {
    // A commentary track is a second English track. The name list collapses
    // to one, so the count is what tells the caller there are two.
    const s = mediaSummary([video(1920, 1080), audio('eng'), audio('eng')]);
    expect(s.audio).toEqual(['English']);
    expect(s.audioCount).toBe(2);
  });

  it('drops untagged tracks from the names but not from the count', () => {
    const s = mediaSummary([video(1920, 1080), audio(null), audio('eng')]);
    expect(s.audio).toEqual(['English']);
    expect(s.audioCount).toBe(2);
  });

  it('reports no subtitles honestly', () => {
    const s = mediaSummary([video(1920, 1080), audio('eng')]);
    expect(s.hasSubtitles).toBe(false);
    expect(s.subtitles).toEqual([]);
    expect(s.subtitleCount).toBe(0);
  });

  it('survives a file with no video track', () => {
    const s = mediaSummary([audio('eng')]);
    expect(s.resolution).toBeNull();
    expect(s.dimensions).toBeNull();
    expect(s.audio).toEqual(['English']);
  });

  it('survives nothing at all', () => {
    for (const input of [null, undefined, []]) {
      const s = mediaSummary(input);
      expect(s.resolution).toBeNull();
      expect(s.audio).toEqual([]);
      expect(s.hasSubtitles).toBe(false);
    }
  });
});

describe('summaryLine', () => {
  it('joins what it has', () => {
    expect(summaryLine(mediaSummary([video(1920, 1080), audio('jpn'), audio('eng')])))
      .toBe('1080p · Japanese, English');
  });

  it('says how many tracks when none are tagged', () => {
    // "" would read as a failed probe; "1 audio track" is true and useful.
    expect(summaryLine(mediaSummary([video(1280, 720), audio(null)])))
      .toBe('720p · 1 audio track');
  });

  it('is empty when there is genuinely nothing to say', () => {
    expect(summaryLine(mediaSummary([]))).toBe('');
    expect(summaryLine(null)).toBe('');
  });
});
