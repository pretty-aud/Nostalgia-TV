import { describe, it, expect } from 'vitest';
import {
  pickAudioTrackId, pickSubtitleTrackId, audioMenuFrom, subtitleMenuFrom,
} from '../src/shared/mpvTracks.js';

/**
 * Track policy over mpv's track-list shape. The fixture entries mirror the
 * fields a real mpv reports (verified live by the embed harness against a
 * generated dual-audio file — the harness asserts this module's pick against
 * the real list, so the SHAPE assumed here cannot silently drift from the
 * shape mpv speaks).
 *
 * The ordering ladder is inherited from playability.pickAudioTrack, which
 * was argued out across several sessions of wrong-language reports. These
 * tests hold the ladder; the language-matching itself is playability's,
 * already tested there.
 */
const track = (over) => ({
  id: 1, type: 'audio', lang: null, title: null,
  default: false, forced: false, selected: false, codec: 'aac', ...over,
});

describe('pickAudioTrackId', () => {
  it('picks the preferred language over position, default flags and English', () => {
    const list = [
      track({ id: 1, lang: 'eng', default: true }),
      track({ id: 2, lang: 'jpn' }),
    ];
    expect(pickAudioTrackId(list, { preferLanguage: 'jpn' })).toBe(2);
    expect(pickAudioTrackId(list, { preferLanguage: 'eng' })).toBe(1);
    expect(pickAudioTrackId(list)).toBe(1);   // English is the house default
  });

  it('never picks a commentary as the preferred-language track', () => {
    const list = [
      track({ id: 1, lang: 'eng', title: "Director's Commentary" }),
      track({ id: 2, lang: 'eng' }),
    ];
    expect(pickAudioTrackId(list, { preferLanguage: 'eng' })).toBe(2);
  });

  it('described audio is excluded by the SHARED judgement, title or flag', () => {
    // A first draft matched only /commentary/ and would have played the
    // "Audio Description" track as the episode. playability's fuller
    // pattern and mpv's visual-impaired flag both exclude it.
    expect(pickAudioTrackId([
      track({ id: 1, lang: 'eng', title: 'Audio Description' }),
      track({ id: 2, lang: 'eng' }),
    ], { preferLanguage: 'eng' })).toBe(2);
    expect(pickAudioTrackId([
      track({ id: 1, lang: 'eng', 'visual-impaired': true }),
      track({ id: 2, lang: 'eng' }),
    ], { preferLanguage: 'eng' })).toBe(2);
  });

  it('falls back: English, untagged, the default flag, then the first', () => {
    // A missing dub falls back to English — someone who set a show to
    // Japanese gets English when the file has no Japanese, never silence.
    expect(pickAudioTrackId([
      track({ id: 1, lang: 'fra' }),
      track({ id: 2, lang: 'eng' }),
    ], { preferLanguage: 'jpn' })).toBe(2);

    expect(pickAudioTrackId([
      track({ id: 3, lang: 'fra' }),
      track({ id: 4 }),                          // untagged: usually the only real track
    ], { preferLanguage: 'eng' })).toBe(4);

    // 'und' means "nobody said", not "not English" — same as untagged.
    expect(pickAudioTrackId([
      track({ id: 3, lang: 'fra' }),
      track({ id: 6, lang: 'und' }),
    ], { preferLanguage: 'eng' })).toBe(6);

    expect(pickAudioTrackId([
      track({ id: 3, lang: 'fra' }),
      track({ id: 5, lang: 'deu', default: true }),
    ], { preferLanguage: 'eng' })).toBe(5);

    expect(pickAudioTrackId([
      track({ id: 7, lang: 'fra' }),
      track({ id: 8, lang: 'deu' }),
    ], { preferLanguage: 'eng' })).toBe(7);
  });

  it('a commentary can never win through its default flag', () => {
    // The commentary filter is a POOL, not a per-rung test — the original
    // ladder's rule, kept: [jpn commentary (default), fra] under an English
    // preference must land on fra, not the flagged commentary.
    expect(pickAudioTrackId([
      track({ id: 1, lang: 'jpn', title: 'Commentary', default: true }),
      track({ id: 2, lang: 'fra' }),
    ], { preferLanguage: 'eng' })).toBe(2);
  });

  it('an all-commentary file still plays something', () => {
    expect(pickAudioTrackId([
      track({ id: 1, lang: 'eng', title: 'Commentary A' }),
      track({ id: 2, lang: 'eng', title: 'Commentary B' }),
    ], { preferLanguage: 'eng' })).toBe(1);
  });

  it('a single track answers immediately, whatever it is', () => {
    expect(pickAudioTrackId([
      track({ id: 5, lang: 'fra', title: 'Commentary' }),
    ], { preferLanguage: 'eng' })).toBe(5);
  });

  it('answers null only for a file with no audio at all', () => {
    expect(pickAudioTrackId([track({ id: 1, type: 'video' })])).toBeNull();
    expect(pickAudioTrackId([])).toBeNull();
    expect(pickAudioTrackId(undefined)).toBeNull();
  });
});

describe('pickSubtitleTrackId', () => {
  const subs = [
    track({ id: 1, type: 'sub', lang: 'eng', forced: true }),
    track({ id: 2, type: 'sub', lang: 'eng' }),
    track({ id: 3, type: 'sub', lang: 'jpn' }),
  ];

  it('prefers the full track over the forced one in the same language', () => {
    // Forced tracks carry only the foreign-dialogue lines — not what
    // "subtitles on" means to a person who asked for them.
    expect(pickSubtitleTrackId(subs, { preferLanguage: 'eng' })).toBe(2);
  });

  it('takes a forced match when it is all the language has', () => {
    expect(pickSubtitleTrackId([subs[0], subs[2]], { preferLanguage: 'eng' })).toBe(1);
  });

  it('finds nothing without a preference or without a match', () => {
    expect(pickSubtitleTrackId(subs, {})).toBeNull();
    expect(pickSubtitleTrackId(subs, { preferLanguage: 'spa' })).toBeNull();
  });
});

describe('the menus', () => {
  it('labels by language, carries mpv\'s own selected flag', () => {
    const menu = audioMenuFrom([
      track({ id: 1, lang: 'eng', selected: true }),
      track({ id: 2, lang: 'jpn' }),
      track({ id: 9, type: 'video' }),           // never a menu row
    ]);
    expect(menu).toHaveLength(2);
    expect(menu[0]).toMatchObject({ id: 1, label: 'English', selected: true });
    expect(menu[1]).toMatchObject({ id: 2, label: 'Japanese', selected: false });
  });

  it('adds technical detail only when two tracks would read identically', () => {
    const menu = audioMenuFrom([
      track({ id: 1, lang: 'eng', 'demux-channel-count': 6, codec: 'eac3' }),
      track({ id: 2, lang: 'eng', 'demux-channel-count': 2, codec: 'aac' }),
      track({ id: 3, lang: 'jpn', 'demux-channel-count': 2, codec: 'aac' }),
    ]);
    expect(menu[0].label).toBe('English · 6ch · eac3');
    expect(menu[1].label).toBe('English · 2ch · aac');
    expect(menu[2].label).toBe('Japanese');       // alone in its language: clean
  });

  it('numbers rows that still read identically, so every row is pickable', () => {
    const menu = audioMenuFrom([
      track({ id: 1, lang: 'eng', 'demux-channel-count': 2, codec: 'aac' }),
      track({ id: 2, lang: 'eng', 'demux-channel-count': 2, codec: 'aac' }),
    ]);
    // Exact and 1-based, matching the old dedupe's convention — "(0)" on a
    // menu row is a programmer's number, not a person's.
    expect(menu[0].label).toBe('English · 2ch · aac (1)');
    expect(menu[1].label).toBe('English · 2ch · aac (2)');
  });

  it('an untagged audio track gets the positional Track name', () => {
    expect(audioMenuFrom([track({ id: 1 })])[0].label).toBe('Track 1');
  });

  it('gives untagged tracks a positional name and marks commentary and forced', () => {
    const menu = subtitleMenuFrom([
      track({ id: 1, type: 'sub' }),
      track({ id: 2, type: 'sub', lang: 'eng', forced: true }),
      track({ id: 3, type: 'sub', lang: 'eng', title: 'Commentary notes' }),
    ]);
    expect(menu[0].label).toBe('Subtitles 1');
    expect(menu[1].label).toBe('English · forced');
    expect(menu[2].label).toBe('English · Commentary notes');
  });
});
