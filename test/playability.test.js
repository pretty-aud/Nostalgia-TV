import { describe, it, expect } from 'vitest';
import {
  TIER,
  codecSupport,
  firstTrack,
  planPlayback,
  ffmpegArgsFor,
  needsFallback,
  prettyCodec,
} from '../src/shared/playability.js';

/** Build a probe result of the shape probeMatroska returns. */
const probeOf = (video, audio) => ({
  ok: true,
  tracks: [
    ...(video ? [{ type: 'video', codecId: video }] : []),
    ...(audio ? [{ type: 'audio', codecId: audio }] : []),
  ],
});

describe('codecSupport', () => {
  it('resolves exact codec ids', () => {
    expect(codecSupport('V_MPEG4/ISO/AVC', 'video')).toBe('yes');
    expect(codecSupport('A_AC3', 'audio')).toBe('no');
    expect(codecSupport('A_OPUS', 'audio')).toBe('yes');
  });

  it('falls back to the codec family for variant suffixes', () => {
    // Real files carry these; a table lookup on the full id alone misses them
    // and would call a perfectly ordinary AAC track "unknown".
    expect(codecSupport('A_AAC/MPEG4/LC', 'audio')).toBe('yes');
    expect(codecSupport('A_AAC/MPEG4/LC/SBR', 'audio')).toBe('yes');
    expect(codecSupport('A_DTS/EXPRESS', 'audio')).toBe('no');
  });

  it('is case-insensitive', () => {
    expect(codecSupport('a_ac3', 'audio')).toBe('no');
    expect(codecSupport('v_vp9', 'video')).toBe('yes');
  });

  it('reports genuinely unknown codecs as unknown, not as unsupported', () => {
    // Guessing "no" here would re-encode files that would have played.
    expect(codecSupport('A_SOMETHING_NEW', 'audio')).toBe('unknown');
    expect(codecSupport('V_FUTURE_CODEC', 'video')).toBe('unknown');
  });
});

describe('firstTrack', () => {
  it('takes the first track of a kind, not the best one', () => {
    // Chromium plays the first audio track and offers no way to switch. A
    // dual-audio release with AC3 first plays silent, so judging the file by
    // its AAC track would call it fine and ship silence.
    const tracks = [
      { type: 'audio', codecId: 'A_AC3' },
      { type: 'audio', codecId: 'A_AAC' },
    ];
    expect(firstTrack(tracks, 'audio').codecId).toBe('A_AC3');
  });
});

describe('planPlayback', () => {
  it('plays a native container directly', () => {
    const plan = planPlayback({ fileName: 'ep.mp4' });
    expect(plan.tier).toBe(TIER.DIRECT);
    expect(plan.needsWork).toBe(false);
  });

  it('remuxes an mkv whose codecs are already supported', () => {
    const plan = planPlayback({ fileName: 'ep.mkv', probe: probeOf('V_MPEG4/ISO/AVC', 'A_AAC') });
    expect(plan.tier).toBe(TIER.REMUX);
    expect(plan.copiesVideo).toBe(true);
  });

  it('converts audio only when the video is fine but the audio is not', () => {
    // The single most common case in a real library: H.264 + AC3.
    const plan = planPlayback({ fileName: 'ep.mkv', probe: probeOf('V_MPEG4/ISO/AVC', 'A_AC3') });
    expect(plan.tier).toBe(TIER.AUDIO);
    expect(plan.copiesVideo).toBe(true);
    expect(plan.reason).toMatch(/AC3/);
  });

  it('re-encodes fully when the video codec is unsupported', () => {
    const plan = planPlayback({ fileName: 'ep.avi', probe: probeOf('V_MPEG4/ISO/ASP', 'A_MPEG/L3') });
    expect(plan.tier).toBe(TIER.FULL);
    expect(plan.copiesVideo).toBe(false);
  });

  it('prefers the video verdict when both streams are unsupported', () => {
    const plan = planPlayback({ fileName: 'ep.mkv', probe: probeOf('V_MPEG2', 'A_AC3') });
    expect(plan.tier).toBe(TIER.FULL);
  });

  it('treats a file with no audio track as playable, not broken', () => {
    const plan = planPlayback({ fileName: 'ep.mkv', probe: probeOf('V_MPEG4/ISO/AVC', null) });
    expect(plan.tier).toBe(TIER.REMUX);
  });

  it('plans H.265 optimistically because support is machine-dependent', () => {
    const plan = planPlayback({ fileName: 'ep.mkv', probe: probeOf('V_MPEGH/ISO/HEVC', 'A_AAC') });
    expect(plan.tier).toBe(TIER.REMUX);   // not FULL — copying the video first
    expect(plan.confident).toBe(false);   // ...but flagged, so the error path retries
  });

  it('reports unknown when the header could not be read', () => {
    const plan = planPlayback({ fileName: 'ep.mkv', probe: { ok: false, tracks: [], reason: 'x' } });
    expect(plan.tier).toBe(TIER.UNKNOWN);
    expect(plan.needsWork).toBe(false); // nothing to act on; try it and see
  });

  it('does not claim confidence about a native container it never probed', () => {
    expect(planPlayback({ fileName: 'ep.mp4' }).confident).toBe(false);
  });
});

describe('ffmpegArgsFor', () => {
  const args = (fileName, probe) => ffmpegArgsFor(planPlayback({ fileName, probe }), 'in', 'out');

  it('returns nothing for a file that needs no work', () => {
    expect(args('ep.mp4')).toBeNull();
  });

  it('copies both streams for a remux', () => {
    const a = args('ep.mkv', probeOf('V_MPEG4/ISO/AVC', 'A_AAC'));
    expect(a).toContain('copy');
    // The whole point of this tier: no encoder is invoked at all.
    expect(a).not.toContain('libx264');
    expect(a).not.toContain('aac');
  });

  it('copies the video and re-encodes only the audio', () => {
    const a = args('ep.mkv', probeOf('V_MPEG4/ISO/AVC', 'A_AC3'));
    expect(a.join(' ')).toContain('-c:v copy');
    expect(a.join(' ')).toContain('-c:a aac');
    expect(a).not.toContain('libx264');
  });

  it('re-encodes the video only in the full tier', () => {
    const a = args('ep.avi', probeOf('V_MPEG4/ISO/ASP', 'A_AC3'));
    expect(a).toContain('libx264');
  });

  it('keeps the output last and no longer pays for +faststart', () => {
    // This used to assert +faststart, on the reasoning that a seekable file
    // needs its index at the front. It does not: the index at the END is still
    // seekable, it just costs the player one range request for the tail, and
    // the app's media:// handler answers those. What +faststart actually costs
    // is a COMPLETE second pass over the output — measured at 29 minutes on a
    // 58GB remux, on top of the 29 the first pass took, to save one seek on a
    // local disk. The flag is gone; the container guarantee is what mattered.
    for (const probe of [probeOf('V_MPEG4/ISO/AVC', 'A_AAC'), probeOf('V_MPEG4/ISO/AVC', 'A_AC3')]) {
      const a = args('ep.mkv', probe);
      // The output path stays LAST, which partArgsFor depends on to slot the
      // format in front of it.
      expect(a[a.length - 1]).toBe('out');
      expect(a).not.toContain('+faststart');
    }
  });

  it('drops subtitle and data streams, which MP4 will not carry', () => {
    const a = args('ep.mkv', probeOf('V_MPEG4/ISO/AVC', 'A_AC3'));
    expect(a).toContain('-sn');
    expect(a).toContain('-dn');
  });
});

describe('needsFallback', () => {
  it('treats decode and unsupported-source as convertible', () => {
    expect(needsFallback({ code: 3 })).toBe(true); // MEDIA_ERR_DECODE
    expect(needsFallback({ code: 4 })).toBe(true); // MEDIA_ERR_SRC_NOT_SUPPORTED
  });

  it('does not convert in response to a missing file or an abort', () => {
    // Re-encoding because the file vanished would burn CPU and still fail.
    expect(needsFallback({ code: 1 })).toBe(false);
    expect(needsFallback({ code: 2 })).toBe(false);
    expect(needsFallback(null)).toBe(false);
  });
});

describe('prettyCodec', () => {
  it('uses names a person would recognise', () => {
    expect(prettyCodec('V_MPEG4/ISO/AVC')).toBe('H.264');
    expect(prettyCodec('A_AC3')).toBe('AC3');
    expect(prettyCodec('A_AAC/MPEG4/LC')).toBe('AAC MPEG4 LC');
  });
});

describe('how the audio is carried across', () => {
  const audioTrack = (codecId, channels, profile) => ({
    ok: true,
    tracks: [
      { type: 'video', index: 0, codecId: 'V_MPEGH/ISO/HEVC' },
      { type: 'audio', index: 0, codecId, channels, profile, language: 'eng' },
    ],
  });
  const argsFor = (probe) => ffmpegArgsFor(planPlayback({ fileName: 'film.mkv', probe }), 'in', 'out');

  it('keeps lossless audio lossless, in every channel', () => {
    // TrueHD 7.1 flattened to 192k stereo was the old behaviour, on a 4K disc
    // remux. FLAC is bit-for-bit the same audio and Chromium decodes it.
    const a = argsFor(audioTrack('A_TRUEHD', 8));
    expect(a).toContain('flac');
    expect(a).not.toContain('aac');
    expect(a).not.toContain('-ac');          // no downmix at all
  });

  it('treats a DTS-HD master track as lossless', () => {
    expect(argsFor(audioTrack('A_DTS', 6, 'DTS-HD MA'))).toContain('flac');
  });

  it('treats a plain DTS core as lossy, because it is', () => {
    // One codec id covers both. Guessing "lossless" here would spend gigabytes
    // making a perfect copy of already-degraded audio.
    const a = argsFor(audioTrack('A_DTS', 6, 'DTS-ES'));
    expect(a).toContain('aac');
    expect(a).not.toContain('flac');
  });

  it('assumes lossy when the profile is missing', () => {
    // The safe direction: this costs a bigger file than necessary, where the
    // other mistake costs the audio.
    expect(argsFor(audioTrack('A_DTS', 6, null))).toContain('aac');
  });

  it('keeps the channels on a lossy multichannel source', () => {
    const a = argsFor(audioTrack('A_EAC3', 6));
    expect(a[a.indexOf('-ac') + 1]).toBe('6');
    expect(a[a.indexOf('-b:a') + 1]).toBe('640k');
  });

  it('leaves a stereo source alone at the old bitrate', () => {
    const a = argsFor(audioTrack('A_AC3', 2));
    expect(a[a.indexOf('-ac') + 1]).toBe('2');
    expect(a[a.indexOf('-b:a') + 1]).toBe('192k');
  });

  it('caps a lossy 7.1 source at six rather than emitting 7.1 AAC', () => {
    expect(argsFor(audioTrack('A_EAC3', 8))[argsFor(audioTrack('A_EAC3', 8)).indexOf('-ac') + 1]).toBe('6');
  });

  it('never re-encodes the video for an audio-only problem', () => {
    const a = argsFor(audioTrack('A_TRUEHD', 8));
    expect(a).toContain('-c:v');
    expect(a[a.indexOf('-c:v') + 1]).toBe('copy');
    expect(a).not.toContain('libx264');
  });
});
