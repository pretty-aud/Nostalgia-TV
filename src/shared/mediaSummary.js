'use strict';

/**
 * What a file IS, in one line: how big the picture is, what you can hear it
 * in, and whether it carries subtitles.
 *
 * Takes the track list the prepare module already produces — ffprobe's, or
 * the Matroska header parser's when ffmpeg is absent — so nothing here reads
 * a disk or spawns anything. Pure, and tested.
 */

const { describeLanguage } = require('./playability.js');

/**
 * The shorthand people actually use, from the coded dimensions.
 *
 * Classified on an EFFECTIVE height, not the raw one: a 2.39:1 film at
 * "1080p" is commonly encoded 1920x816 with the bars cut off, and judging
 * that by its 816 pixels would call it 720p. Taking the larger of the real
 * height and the height a 16:9 frame of that width would have puts a
 * letterboxed scope encode back in the bucket its width says it belongs to,
 * while leaving 4:3 and pillarboxed material alone.
 *
 * Falls back to the exact dimensions rather than guessing when nothing fits —
 * an honest "1440x1080" beats a confident wrong label.
 */
const BUCKETS = [
  [2000, '4K'],
  [1300, '1440p'],
  [950, '1080p'],
  [620, '720p'],
  [520, '576p'],
  [420, '480p'],
  [300, '360p'],
  [200, '240p'],
];

function resolutionLabel(width, height) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (w <= 0 || h <= 0) return null;
  const effective = Math.max(h, Math.round((w * 9) / 16));
  for (const [floor, label] of BUCKETS) {
    if (effective >= floor) return label;
  }
  return `${w}×${h}`;
}

/** Unique language names in track order, with untagged tracks left out. */
function languageNames(tracks, type) {
  const seen = new Set();
  const out = [];
  for (const track of tracks || []) {
    if (!track || track.type !== type) continue;
    const name = describeLanguage(track.language || track.lang);
    if (name === 'untagged') continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * One summary for the detail panel.
 *
 * `audio` and `subtitles` are NAMES, already deduplicated. `audioCount` and
 * `subtitleCount` are the raw track counts, because "two English tracks" is a
 * real thing (a commentary, a different mix) and the names alone would hide
 * it — a caller can say "English" and still know there are two.
 */
function mediaSummary(tracks) {
  const list = Array.isArray(tracks) ? tracks : [];
  const video = list.find((t) => t && t.type === 'video') || null;
  const audio = list.filter((t) => t && t.type === 'audio');
  const subtitles = list.filter((t) => t && t.type === 'subtitle');

  return {
    resolution: video ? resolutionLabel(video.width, video.height) : null,
    dimensions: video && video.width && video.height ? `${video.width}×${video.height}` : null,
    audio: languageNames(list, 'audio'),
    audioCount: audio.length,
    subtitles: languageNames(list, 'subtitle'),
    subtitleCount: subtitles.length,
    hasSubtitles: subtitles.length > 0,
  };
}

/**
 * The line the panel prints. Empty string when there is genuinely nothing to
 * say, so the caller can hide the row rather than print a lone separator.
 */
function summaryLine(summary) {
  if (!summary) return '';
  const parts = [];
  if (summary.resolution) parts.push(summary.resolution);
  if (summary.audio.length) {
    parts.push(summary.audio.join(', '));
  } else if (summary.audioCount) {
    // Tracks exist but nobody tagged them. Say how many rather than nothing:
    // "1 audio track" is true and useful, "" looks like a failed read.
    parts.push(`${summary.audioCount} audio track${summary.audioCount === 1 ? '' : 's'}`);
  }
  return parts.join(' · ');
}

module.exports = { mediaSummary, summaryLine, resolutionLabel, languageNames };
