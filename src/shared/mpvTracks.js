'use strict';

/**
 * Track choice and track labels, over mpv's own track-list.
 *
 * The old pipeline probed with ffprobe, planned a conversion around the
 * chosen track, and REBUILT THE FILE to move it into position one. mpv
 * switches tracks live, so the whole decision collapses to: read track-list,
 * pick an id, set `aid`/`sid`. The POLICY, though, is inherited verbatim
 * from playability.js — the ordering rules there were argued out across
 * several sessions of wrong-language reports, and the language matching
 * (eng/jpn/spa families, tag variants) is the same tested function.
 *
 * The menu's `selected` flag comes from mpv itself — the same source the
 * sound comes from. Two surfaces answering "which track" from two sources
 * is how the confidently-wrong-label bug happened; here there is one.
 *
 * mpv track-list entries (the fields this module reads, verified against a
 * real file in the embed harness): { id, type: 'audio'|'sub'|'video',
 * lang, title, default, forced, selected, codec, 'demux-channel-count' }.
 */

const { matchesLanguage, describeLanguage, isUndeterminedLanguage, isCommentary } = require('./playability.js');

/**
 * playability's language functions read a probe-track's `.language`; mpv
 * calls the same field `lang`. One adapter at the boundary, so the tested
 * matching logic is shared rather than re-implemented with fresh bugs.
 */
const asLanguageTrack = (track) => ({ language: track.lang });

/**
 * Commentary and described-audio tracks, by the SHARED judgement.
 *
 * A first draft matched only /commentary/ and quietly re-admitted the
 * tracks playability's fuller pattern excludes — "Audio Description",
 * narration, director tracks — which would have played described audio as
 * the episode. mpv has no comment disposition, but it DOES flag described
 * audio as `visual-impaired`, which stands in for the disposition half.
 */
function isCommentaryTitle(track) {
  return isCommentary({ name: track.title, comment: false })
    || track['visual-impaired'] === true;
}

function audioTracks(trackList) {
  return (Array.isArray(trackList) ? trackList : []).filter((t) => t && t.type === 'audio');
}

function subtitleTracks(trackList) {
  return (Array.isArray(trackList) ? trackList : []).filter((t) => t && t.type === 'sub');
}

/**
 * Which audio track should play — playability.pickAudioTrack's ladder,
 * MIRRORED rung for rung (a first draft re-derived it and broke three
 * rules the original earned the hard way):
 *
 *  - one track answers immediately, whatever it is;
 *  - commentaries are removed as a POOL, not per-rung — so a commentary can
 *    never win via its default flag, yet an all-commentary file still plays;
 *  - a missing dub falls back to ENGLISH, then to an undetermined-tagged
 *    track ('und'/'unk' mean "nobody said", not "not English"), then the
 *    default flag, then the first — someone who set a show to Japanese
 *    gets English when the file has no Japanese, never silence.
 *
 * Returns the mpv id, or null for a file with no audio at all.
 */
function pickAudioTrackId(trackList, { preferLanguage = 'eng' } = {}) {
  const tracks = audioTracks(trackList);
  if (tracks.length === 0) return null;
  if (tracks.length === 1) return tracks[0].id;

  const speakable = tracks.filter((t) => !isCommentaryTitle(t));
  const pool = speakable.length ? speakable : tracks;

  if (preferLanguage && preferLanguage !== 'eng') {
    const wanted = pool.find((t) => matchesLanguage(asLanguageTrack(t), preferLanguage));
    if (wanted) return wanted.id;
  }

  const english = pool.find((t) => matchesLanguage(asLanguageTrack(t), 'eng'));
  if (english) return english.id;

  const untagged = pool.find((t) => !t.lang || isUndeterminedLanguage(t.lang));
  if (untagged) return untagged.id;

  const flagged = pool.find((t) => t.default);
  if (flagged) return flagged.id;

  return pool[0].id;
}

/**
 * Which subtitle track a per-show subs preference means.
 *
 * Non-forced first: a forced track carries only the foreign-dialogue lines,
 * which is not what "subtitles on" means to a person who asked for them.
 * A forced match is still better than nothing. No text-only filter — mpv
 * renders image subs (PGS/VobSub), which the old pipeline had to refuse.
 */
function pickSubtitleTrackId(trackList, { preferLanguage } = {}) {
  if (!preferLanguage) return null;
  const tracks = subtitleTracks(trackList);
  const matching = tracks.filter((t) => matchesLanguage(asLanguageTrack(t), preferLanguage));
  const plain = matching.find((t) => !t.forced);
  if (plain) return plain.id;
  const forced = matching.find((t) => t.forced);
  return forced ? forced.id : null;
}

/**
 * Menu rows for a track kind, labelled for a person to choose between.
 * Same labelling rules the old listTracks earned: language first, a real
 * title when it adds something, commentary/forced flags, technical detail
 * ONLY when two tracks would otherwise read identically, and a positional
 * "(n)" as the last resort so every row is at least pickable.
 */
function menuFrom(tracks, kind, { technicalDetail = false } = {}) {
  const languageCounts = new Map();
  for (const track of tracks) {
    const key = describeLanguage(asLanguageTrack(track).language);
    languageCounts.set(key, (languageCounts.get(key) || 0) + 1);
  }

  const rows = tracks.map((track, i) => {
    const language = describeLanguage(asLanguageTrack(track).language);
    const parts = [language === 'untagged' ? `${kind} ${i + 1}` : language];
    if (track.title && track.title.toLowerCase() !== language.toLowerCase()) parts.push(track.title);
    if (isCommentaryTitle(track) && !/comment|descri|narrat/i.test(parts.join(' '))) parts.push('commentary');
    if (track.forced) parts.push('forced');
    // Channel layout and codec disambiguate AUDIO tracks sharing a language;
    // for subtitles which of srt/ass a track is says nothing about whether
    // it is the one you want to read, so they never get the noise.
    if (technicalDetail && languageCounts.get(language) > 1) {
      const channels = track['demux-channel-count'];
      if (channels) parts.push(`${channels}ch`);
      if (track.codec) parts.push(track.codec);
    }
    return {
      id: track.id,
      label: parts.join(' · '),
      language: track.lang || null,
      selected: Boolean(track.selected),
    };
  });

  const labelCounts = new Map();
  for (const row of rows) labelCounts.set(row.label, (labelCounts.get(row.label) || 0) + 1);
  return rows.map((row, i) => (labelCounts.get(row.label) > 1
    ? { ...row, label: `${row.label} (${i + 1})` }
    : row));
}

function audioMenuFrom(trackList) {
  return menuFrom(audioTracks(trackList), 'Track', { technicalDetail: true });
}

function subtitleMenuFrom(trackList) {
  return menuFrom(subtitleTracks(trackList), 'Subtitles');
}

module.exports = {
  pickAudioTrackId,
  pickSubtitleTrackId,
  audioMenuFrom,
  subtitleMenuFrom,
};
