import { describe, it, expect } from 'vitest';
import {
  TIER,
  pickAudioTrack,
  isEnglish,
  isCommentary,
  describeLanguage,
  codecIdFromFfprobe,
  isTextSubtitle,
  planPlayback,
  ffmpegArgsFor,
} from '../src/shared/playability.js';

const audio = (language, extra = {}) => ({
  type: 'audio', codecId: 'A_AAC', language, ...extra,
});
const video = { type: 'video', codecId: 'V_MPEG4/ISO/AVC' };
const probeOf = (...tracks) => ({ ok: true, tracks: [video, ...tracks] });

describe('isEnglish', () => {
  it('accepts every form a file might use', () => {
    for (const code of ['eng', 'en', 'EN', 'English', 'en-US', 'en_GB', 'eng-us']) {
      expect(isEnglish({ language: code }), code).toBe(true);
    }
  });

  it('rejects other languages', () => {
    for (const code of ['jpn', 'ja', 'spa', 'fre', 'por']) {
      expect(isEnglish({ language: code }), code).toBe(false);
    }
  });

  it('prefers the BCP-47 field when a file carries both', () => {
    // Muxers leave a stale "und" in the old field; the newer one is the truth.
    expect(isEnglish({ language: 'und', languageBcp47: 'en' })).toBe(true);
  });
});

describe('isCommentary', () => {
  it('trusts the disposition flag', () => {
    expect(isCommentary({ comment: true })).toBe(true);
  });

  it('reads the usual titles', () => {
    for (const name of ['Commentary', "Director's Commentary", 'Audio Description', 'Narration']) {
      expect(isCommentary({ name }), name).toBe(true);
    }
  });

  it('does not flag ordinary titles', () => {
    for (const name of ['English', 'Stereo', 'Original', 'Surround 5.1']) {
      expect(isCommentary({ name }), name).toBe(false);
    }
  });
});

describe('pickAudioTrack', () => {
  it('picks English when it is not the first track', () => {
    // The whole point: a dual-audio release with Japanese first would otherwise
    // play in Japanese forever, because Chromium always plays track 0.
    const picked = pickAudioTrack([video, audio('jpn'), audio('eng')]);
    expect(picked.index).toBe(1);
    expect(picked.reason).toBe('English');
  });

  it('indexes within the AUDIO tracks, not the whole track list', () => {
    // ffmpeg's -map 0:a:N counts audio streams. Counting all streams would map
    // the wrong track on any file with subtitles or several video streams.
    const picked = pickAudioTrack([video, { type: 'subtitle', codecId: 'S_TEXT/UTF8' }, audio('jpn'), audio('eng')]);
    expect(picked.index).toBe(1);
  });

  it('skips a commentary track even though it is English', () => {
    const picked = pickAudioTrack([
      video,
      audio('eng', { name: "Director's Commentary" }),
      audio('eng'),
    ]);
    expect(picked.index).toBe(1);
  });

  it('falls back to an untagged track when nothing says English', () => {
    const picked = pickAudioTrack([video, audio('jpn'), audio('und')]);
    expect(picked.index).toBe(1);
    expect(picked.reason).toBe('untagged');
  });

  it('uses the default flag when no track is English or untagged', () => {
    const picked = pickAudioTrack([video, audio('jpn'), audio('spa', { default: true })]);
    expect(picked.index).toBe(1);
  });

  it('always returns something, even with nothing to go on', () => {
    // A file we cannot reason about must still play.
    const picked = pickAudioTrack([video, audio('jpn'), audio('fre')]);
    expect(picked.index).toBe(0);
  });

  it('takes the only track without deliberating', () => {
    expect(pickAudioTrack([video, audio('jpn')])).toMatchObject({ index: 0, reason: 'only track' });
  });

  it('reports no audio rather than pretending there is some', () => {
    expect(pickAudioTrack([video]).index).toBe(-1);
  });

  it('picks commentary only when it is the sole option', () => {
    const picked = pickAudioTrack([video, audio('eng', { comment: true })]);
    expect(picked.index).toBe(0);
  });
});

describe('planPlayback with multiple audio tracks', () => {
  it('repackages a native MP4 when English is not the first track', () => {
    // Nothing else would be wrong with this file — but left alone it plays in
    // Japanese, so it has to be remuxed with the English track as the only one.
    const plan = planPlayback({ fileName: 'ep.mp4', probe: probeOf(audio('jpn'), audio('eng')) });
    expect(plan.tier).toBe(TIER.REMUX);
    expect(plan.audioIndex).toBe(1);
    expect(plan.reason).toMatch(/English/);
  });

  it('leaves a native MP4 alone when English is already first', () => {
    const plan = planPlayback({ fileName: 'ep.mp4', probe: probeOf(audio('eng'), audio('jpn')) });
    expect(plan.tier).toBe(TIER.DIRECT);
    expect(plan.audioIndex).toBe(0);
  });

  it('judges the codec of the CHOSEN track, not the first one', () => {
    // English is AC3 here; the Japanese first track is AAC. Judging track 0
    // would call the file fine and then play it silent.
    const plan = planPlayback({
      fileName: 'ep.mkv',
      probe: probeOf(audio('jpn'), { type: 'audio', codecId: 'A_AC3', language: 'eng' }),
    });
    expect(plan.tier).toBe(TIER.AUDIO);
    expect(plan.audioIndex).toBe(1);
  });

  it('honours an explicit override from the audio menu', () => {
    const plan = planPlayback({
      fileName: 'ep.mkv',
      probe: probeOf(audio('eng'), audio('jpn')),
      audioIndex: 1,
    });
    expect(plan.audioIndex).toBe(1);
    expect(plan.audioPick).toBe('chosen by viewer');
  });

  it('ignores an override that is out of range', () => {
    const plan = planPlayback({
      fileName: 'ep.mkv',
      probe: probeOf(audio('jpn'), audio('eng')),
      audioIndex: 9,
    });
    expect(plan.audioIndex).toBe(1); // back to the English default
  });

  it('reports the count so the UI knows whether to offer a choice', () => {
    const plan = planPlayback({ fileName: 'ep.mkv', probe: probeOf(audio('eng'), audio('jpn'), audio('spa')) });
    expect(plan.audioCount).toBe(3);
  });
});

describe('ffmpegArgsFor maps the chosen track', () => {
  it('maps the English track, not track zero', () => {
    const plan = planPlayback({ fileName: 'ep.mkv', probe: probeOf(audio('jpn'), audio('eng')) });
    const args = ffmpegArgsFor(plan, 'in.mkv', 'out.mp4');
    expect(args.join(' ')).toContain('-map 0:a:1?');
    expect(args.join(' ')).not.toContain('-map 0:a:0?');
  });

  it('still maps track zero when that is the right answer', () => {
    const plan = planPlayback({ fileName: 'ep.mkv', probe: probeOf(audio('eng'), audio('jpn')) });
    expect(ffmpegArgsFor(plan, 'in.mkv', 'out.mp4').join(' ')).toContain('-map 0:a:0?');
  });
});

describe('codecIdFromFfprobe', () => {
  it('translates ffmpeg names into the ids the support tables use', () => {
    expect(codecIdFromFfprobe('h264')).toBe('V_MPEG4/ISO/AVC');
    expect(codecIdFromFfprobe('hevc')).toBe('V_MPEGH/ISO/HEVC');
    expect(codecIdFromFfprobe('eac3')).toBe('A_EAC3');
    expect(codecIdFromFfprobe('aac')).toBe('A_AAC');
  });

  it('passes unknown names through instead of guessing', () => {
    // They come out 'unknown' from codecSupport, which is planned
    // optimistically — better than being wrongly called unsupported.
    expect(codecIdFromFfprobe('some_new_codec')).toBe('SOME_NEW_CODEC');
  });
});

describe('isTextSubtitle', () => {
  it('accepts text formats that can become WebVTT', () => {
    for (const codec of ['subrip', 'ass', 'ssa', 'mov_text', 'webvtt']) {
      expect(isTextSubtitle(codec), codec).toBe(true);
    }
  });

  it('rejects image formats, which would need burning in', () => {
    for (const codec of ['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle']) {
      expect(isTextSubtitle(codec), codec).toBe(false);
    }
  });
});

describe('describeLanguage', () => {
  it('names languages a person would recognise', () => {
    expect(describeLanguage('eng')).toBe('English');
    expect(describeLanguage('jpn')).toBe('Japanese');
    expect(describeLanguage('pt-BR')).toBe('Portuguese');
  });

  it('says so when nothing is tagged', () => {
    expect(describeLanguage(null)).toBe('untagged');
  });
});
