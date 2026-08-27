'use strict';

/**
 * Decide how a file has to be handled before it can play.
 *
 * Chromium can only play a narrow set of codecs, and the .mkv files most rips
 * ship as routinely fall outside it — almost always because of the AUDIO track.
 * A typical episode is H.264 video (fine) paired with AC3 audio (not fine). If
 * we treat that as simply "broken" we throw away a file whose picture is
 * perfectly playable and whose sound is thirty seconds of work to fix.
 *
 * So instead of a yes/no, every file gets sorted into a tier that says what
 * would have to happen for it to play:
 *
 *   direct  — hand it straight to <video>
 *   remux   — codecs are fine, the CONTAINER is not; repackage, no re-encoding
 *   audio   — keep the video stream as-is, re-encode only the audio
 *   full    — the video codec is unplayable too; re-encode everything (slow)
 *   unknown — we could not read the header; try it and see
 *
 * The middle two tiers are the point of this module. `remux` and `audio` both
 * copy the video stream untouched, which is I/O-bound rather than CPU-bound and
 * runs orders of magnitude faster than real playback — fast enough to prepare
 * the next episode while the current one is still going.
 *
 * Pure module: no filesystem, no ffmpeg, no Electron. Feeds off probeMatroska.
 */

const TIER = {
  DIRECT: 'direct',
  REMUX: 'remux',
  AUDIO: 'audio',
  FULL: 'full',
  UNKNOWN: 'unknown',
};

/**
 * Containers Chromium demuxes natively.
 *
 * Matroska is deliberately absent. Chromium's demuxer will sometimes accept a
 * .mkv — its WebM support is a Matroska demuxer underneath — but whether it
 * does depends on the build and the codecs inside, so relying on it makes
 * playback a coin flip. Remuxing to MP4 costs a few seconds and removes the
 * question entirely, and we still verify at runtime (see needsFallback).
 */
const NATIVE_CONTAINERS = new Set(['.mp4', '.m4v', '.webm', '.ogv']);

/** Containers ffmpeg can repackage from without touching the streams. */
const REMUXABLE_CONTAINERS = new Set([
  '.mkv', '.mov', '.avi', '.ts', '.m2ts', '.flv', '.wmv', '.mpg', '.mpeg',
]);

/**
 * Matroska CodecID -> can Chromium decode it.
 *
 * 'maybe' means hardware- or platform-dependent: we plan optimistically and let
 * the runtime error path demote it, rather than re-encoding something that
 * would have played fine.
 */
const VIDEO_SUPPORT = {
  'V_MPEG4/ISO/AVC': 'yes',    // H.264 — the overwhelming majority of rips
  'V_VP8': 'yes',
  'V_VP9': 'yes',
  'V_AV1': 'yes',
  'V_MPEGH/ISO/HEVC': 'maybe', // H.265 — needs OS/hardware support on Windows
  'V_MPEG4/ISO/ASP': 'no',     // XviD / DivX 4-6
  'V_MPEG4/ISO/SP': 'no',
  'V_MPEG4/MS/V3': 'no',       // DivX 3
  'V_MPEG1': 'no',
  'V_MPEG2': 'no',
  'V_MS/VFW/FOURCC': 'no',     // arbitrary AVI codec smuggled into Matroska
  'V_THEORA': 'no',            // dropped from Chromium in 2024
  'V_QUICKTIME': 'no',
};

const AUDIO_SUPPORT = {
  'A_AAC': 'yes',
  'A_MPEG/L3': 'yes',          // MP3
  'A_OPUS': 'yes',
  'A_VORBIS': 'yes',
  'A_FLAC': 'yes',
  'A_AC3': 'no',               // Dolby Digital — the single most common blocker
  'A_EAC3': 'no',              // Dolby Digital Plus
  'A_DTS': 'no',
  'A_TRUEHD': 'no',
  'A_MLP': 'no',
  'A_MPEG/L2': 'no',
  'A_PCM/INT/LIT': 'no',
  'A_PCM/INT/BIG': 'no',
  'A_PCM/FLOAT/IEEE': 'no',
  'A_MS/ACM': 'no',
};

/**
 * Codec ids carry variant suffixes — "A_AAC/MPEG4/LC", "A_DTS/EXPRESS",
 * "V_MPEG4/ISO/AVC". Look the full id up first, then walk back one path
 * segment at a time so a variant we have never seen still resolves to its
 * family instead of falling through to 'unknown'.
 */
function lookupSupport(table, codecId) {
  if (!codecId) return 'unknown';
  const id = String(codecId).toUpperCase();
  if (table[id]) return table[id];

  const parts = id.split('/');
  for (let i = parts.length - 1; i > 0; i -= 1) {
    const prefix = parts.slice(0, i).join('/');
    if (table[prefix]) return table[prefix];
  }
  return 'unknown';
}

function codecSupport(codecId, kind) {
  return lookupSupport(kind === 'video' ? VIDEO_SUPPORT : AUDIO_SUPPORT, codecId);
}

/**
 * ffprobe reports codecs by ffmpeg's own short name; the tables above are keyed
 * by Matroska CodecID.
 *
 * Translating at the probe boundary keeps ONE support table rather than two
 * that can disagree — and two tables of codec verdicts drifting apart is
 * exactly the kind of bug that shows up as "some files play and some don't"
 * with no pattern anyone can see.
 */
const FFPROBE_CODEC_IDS = {
  // video
  h264: 'V_MPEG4/ISO/AVC',
  hevc: 'V_MPEGH/ISO/HEVC',
  vp8: 'V_VP8',
  vp9: 'V_VP9',
  av1: 'V_AV1',
  mpeg4: 'V_MPEG4/ISO/ASP',
  msmpeg4v3: 'V_MPEG4/MS/V3',
  mpeg2video: 'V_MPEG2',
  mpeg1video: 'V_MPEG1',
  theora: 'V_THEORA',
  vc1: 'V_MS/VFW/FOURCC',
  wmv3: 'V_MS/VFW/FOURCC',
  // audio
  aac: 'A_AAC',
  mp3: 'A_MPEG/L3',
  mp2: 'A_MPEG/L2',
  ac3: 'A_AC3',
  eac3: 'A_EAC3',
  dts: 'A_DTS',
  truehd: 'A_TRUEHD',
  mlp: 'A_MLP',
  flac: 'A_FLAC',
  opus: 'A_OPUS',
  vorbis: 'A_VORBIS',
  pcm_s16le: 'A_PCM/INT/LIT',
  pcm_s24le: 'A_PCM/INT/LIT',
  wmav2: 'A_MS/ACM',
};

function codecIdFromFfprobe(name) {
  if (!name) return null;
  const key = String(name).toLowerCase();
  // Unmapped names pass through: codecSupport reports them 'unknown', which is
  // planned optimistically, rather than being wrongly called unsupported.
  return FFPROBE_CODEC_IDS[key] || key.toUpperCase();
}

/** Subtitle formats that can become WebVTT, i.e. ones made of text. */
const TEXT_SUBTITLE_CODECS = new Set([
  'subrip', 'srt', 'ass', 'ssa', 'webvtt', 'vtt', 'mov_text', 'text', 'subviewer', 'microdvd',
]);

/**
 * Image-based subtitles (PGS, VobSub) are pictures, not text, so they cannot
 * become WebVTT — the only way to show them is to burn them into the video,
 * which re-encodes the picture and is not something to do silently.
 */
function isTextSubtitle(codecName) {
  return TEXT_SUBTITLE_CODECS.has(String(codecName || '').toLowerCase());
}

function extnameOf(fileName) {
  const dot = String(fileName || '').lastIndexOf('.');
  return dot === -1 ? '' : String(fileName).slice(dot).toLowerCase();
}

/**
 * Pick the track that will actually be played.
 *
 * Chromium plays the FIRST track of each kind and offers no track switcher, so
 * judging a file by its best track would call a file playable on the strength
 * of a stream the user will never hear. A dual-audio release with AC3 first and
 * AAC second plays as AC3, i.e. silent. Judge the first one.
 */
function firstTrack(tracks, kind) {
  return (tracks || []).find((t) => t.type === kind) || null;
}

/**
 * Everything that means "English" in the wild.
 *
 * Files carry ISO 639-2 ("eng"), ISO 639-1 ("en"), BCP-47 ("en-US"), or a
 * human-written name. Matching only "eng" would miss most of them.
 */
const ENGLISH = new Set(['eng', 'en', 'eng-us', 'en-us', 'en-gb', 'english', 'enm']);

/** Codes meaning "nobody said": treated as a candidate, not a rejection. */
const UNDETERMINED = new Set(['', 'und', 'unk', 'mis', 'zxx', 'qaa']);

function normaliseLanguage(track) {
  // BCP-47 wins when present: a file carrying both is the newer convention and
  // the older field is often a stale "und" left by the muxer.
  const raw = (track && (track.languageBcp47 || track.language)) || '';
  return String(raw).trim().toLowerCase();
}

function isEnglish(track) {
  const code = normaliseLanguage(track);
  if (ENGLISH.has(code)) return true;
  // "en-CA", "eng-GB" and friends.
  return /^en(g)?[-_]/.test(code);
}

/**
 * Tracks that are English but are NOT the ones you want playing.
 *
 * A director's commentary is tagged `eng` exactly like the feature audio, so
 * language alone would happily select it and the episode would play with two
 * people discussing it over the top.
 */
function isCommentary(track) {
  // ffprobe exposes an explicit disposition flag; trust it over the title.
  if (track && track.comment) return true;
  const name = String((track && track.name) || '').toLowerCase();
  if (!name) return false;
  return /comment|descri|narrat|director|audio description/.test(name);
}

/**
 * Choose the audio track to keep, and say where it sits among the audio tracks.
 *
 * `index` is the index WITHIN the audio streams, which is what ffmpeg's
 * `-map 0:a:N` counts — not the index in the file's overall track list.
 *
 * Order of preference: English and not commentary, then an untagged track
 * (plenty of single-audio English rips tag nothing at all), then whatever the
 * file flags as default, then simply the first. There is always an answer, so
 * a file with unusual tagging still plays rather than being rejected.
 */
function pickAudioTrack(tracks, options = {}) {
  const audio = (tracks || []).filter((t) => t.type === 'audio');
  if (audio.length === 0) return { track: null, index: -1, reason: 'no audio' };
  if (audio.length === 1) return { track: audio[0], index: 0, reason: 'only track' };

  const prefersEnglish = options.preferEnglish !== false;
  const speakable = audio.filter((t) => !isCommentary(t));
  const pool = speakable.length ? speakable : audio;

  const pick = (track, reason) => ({ track, index: audio.indexOf(track), reason });

  if (prefersEnglish) {
    const english = pool.find(isEnglish);
    if (english) return pick(english, 'English');

    const untagged = pool.find((t) => UNDETERMINED.has(normaliseLanguage(t)));
    if (untagged) return pick(untagged, 'untagged');
  }

  const flagged = pool.find((t) => t.default);
  if (flagged) return pick(flagged, 'default track');

  return pick(pool[0], 'first track');
}

/**
 * Work out what has to happen to a file before it will play.
 *
 * @param {object} input
 * @param {string} input.fileName  used for the container extension
 * @param {object} [input.probe]   result from probeMatroska, when it ran
 * @returns {{tier, reason, video, audio, videoCodec, audioCodec, container, confident}}
 */
function planPlayback({ fileName, probe, audioIndex: forcedAudioIndex, preferEnglish } = {}) {
  const container = extnameOf(fileName);
  const native = NATIVE_CONTAINERS.has(container);

  // No probe, or the probe failed. For a native container that is fine — those
  // play or they do not, and the runtime error path will catch it. For anything
  // else we cannot tell, and guessing "full" would burn CPU re-encoding files
  // that only needed repackaging.
  if (!probe || !probe.ok) {
    if (native) {
      return plan(TIER.DIRECT, 'native container', {
        container, confident: false,
        reason: 'Container plays natively; codecs not inspected.',
      });
    }
    return plan(TIER.UNKNOWN, 'unreadable header', {
      container, confident: false,
      reason: probe && probe.reason ? `Could not read codecs (${probe.reason}).` : 'Could not read codecs.',
    });
  }

  const videoTrack = firstTrack(probe.tracks, 'video');
  const audioTracks = (probe.tracks || []).filter((t) => t.type === 'audio');

  // A forced index is the viewer overriding the automatic choice from the
  // player's audio menu. English stays the default for every new episode; this
  // only applies to the one they explicitly changed.
  const forced = Number.isInteger(forcedAudioIndex)
    && forcedAudioIndex >= 0
    && forcedAudioIndex < audioTracks.length;

  const chosen = forced
    ? { track: audioTracks[forcedAudioIndex], index: forcedAudioIndex, reason: 'chosen by viewer' }
    : pickAudioTrack(probe.tracks, { preferEnglish });

  const audioTrack = chosen.track;
  const audioIndex = Math.max(0, chosen.index);
  const audioCount = (probe.tracks || []).filter((t) => t.type === 'audio').length;
  const videoCodec = videoTrack ? videoTrack.codecId : null;
  const audioCodec = audioTrack ? audioTrack.codecId : null;

  const video = videoTrack ? codecSupport(videoCodec, 'video') : 'none';
  // A file with no audio track at all is not a problem — it just plays silent.
  const audio = audioTrack ? codecSupport(audioCodec, 'audio') : 'none';

  const videoOk = video === 'yes' || video === 'maybe' || video === 'none';
  const audioOk = audio === 'yes' || audio === 'maybe' || audio === 'none';

  // 'unknown' on either side means a codec id absent from the tables. Treat it
  // as playable-until-proven-otherwise: the tables are a shortcut, not an
  // authority, and the runtime error path is the real backstop.
  const videoUnknown = video === 'unknown';
  const audioUnknown = audio === 'unknown';

  const base = {
    container,
    videoCodec,
    audioCodec,
    video,
    audio,
    audioIndex,
    audioCount,
    audioLanguage: audioTrack ? normaliseLanguage(audioTrack) : null,
    audioPick: chosen.reason,
    // Passed straight through for the progress display. Nothing here uses it
    // to decide anything — a file is not more or less playable for being long.
    durationMs: (probe && Number(probe.durationMs)) || null,
    confident: !videoUnknown && !audioUnknown && video !== 'maybe' && audio !== 'maybe',
  };

  if (!videoOk && !videoUnknown) {
    return plan(TIER.FULL, 'video codec unsupported', {
      ...base,
      reason: `${prettyCodec(videoCodec)} video needs re-encoding.`,
    });
  }

  if (!audioOk && !audioUnknown) {
    return plan(TIER.AUDIO, 'audio codec unsupported', {
      ...base,
      reason: `${prettyCodec(audioCodec)} audio needs converting; video is kept as-is.`,
    });
  }

  // The wanted audio is not track 0. Chromium always plays the first audio
  // track and offers no switcher, so the file has to be repackaged with the
  // chosen track as the only one — otherwise a dual-audio release plays in
  // whichever language the muxer happened to put first.
  if (audioIndex > 0) {
    return plan(TIER.REMUX, 'audio track selection', {
      ...base,
      reason: `Selecting the ${describeLanguage(base.audioLanguage)} audio track (${audioIndex + 1} of ${audioCount}).`,
    });
  }

  if (!native) {
    return plan(TIER.REMUX, 'container not native', {
      ...base,
      reason: `Codecs are fine; repackaging ${container} into MP4.`,
    });
  }

  return plan(TIER.DIRECT, 'plays as-is', {
    ...base,
    reason: 'Plays directly.',
  });
}

/** "eng" -> "English", for anything we can name; the raw code otherwise. */
const LANGUAGE_NAMES = {
  eng: 'English', en: 'English',
  jpn: 'Japanese', ja: 'Japanese',
  spa: 'Spanish', es: 'Spanish',
  fra: 'French', fre: 'French', fr: 'French',
  deu: 'German', ger: 'German', de: 'German',
  ita: 'Italian', it: 'Italian',
  por: 'Portuguese', pt: 'Portuguese',
  rus: 'Russian', ru: 'Russian',
  kor: 'Korean', ko: 'Korean',
  zho: 'Chinese', chi: 'Chinese', cmn: 'Chinese', zh: 'Chinese',
  ara: 'Arabic', ar: 'Arabic',
  nld: 'Dutch', dut: 'Dutch', nl: 'Dutch',
  pol: 'Polish', pl: 'Polish',
  swe: 'Swedish', sv: 'Swedish',
  hin: 'Hindi', hi: 'Hindi',
};

function describeLanguage(code) {
  if (!code) return 'untagged';
  const key = String(code).toLowerCase();
  if (LANGUAGE_NAMES[key]) return LANGUAGE_NAMES[key];
  const base = key.split(/[-_]/)[0];
  return LANGUAGE_NAMES[base] || key;
}

function plan(tier, summary, extra) {
  return {
    tier,
    summary,
    needsWork: tier !== TIER.DIRECT && tier !== TIER.UNKNOWN,
    // Copying the video stream is the difference between seconds and minutes.
    copiesVideo: tier === TIER.REMUX || tier === TIER.AUDIO,
    ...extra,
  };
}

/** "A_AC3" -> "AC3", "V_MPEG4/ISO/AVC" -> "H.264" where we have a nicer name. */
const PRETTY = {
  'V_MPEG4/ISO/AVC': 'H.264',
  'V_MPEGH/ISO/HEVC': 'H.265',
  'V_MPEG4/ISO/ASP': 'XviD',
  'V_MPEG4/MS/V3': 'DivX 3',
  'A_MPEG/L3': 'MP3',
  'A_AC3': 'AC3',
  'A_EAC3': 'E-AC3',
  'A_TRUEHD': 'TrueHD',
};

function prettyCodec(codecId) {
  if (!codecId) return 'Unknown';
  const id = String(codecId).toUpperCase();
  if (PRETTY[id]) return PRETTY[id];
  const parts = id.split('/');
  for (let i = parts.length - 1; i > 0; i -= 1) {
    const prefix = parts.slice(0, i).join('/');
    if (PRETTY[prefix]) return PRETTY[prefix];
  }
  return id.replace(/^[VAS]_/, '').replace(/\//g, ' ');
}

/**
 * ffmpeg arguments for a plan.
 *
 * Always targets MP4, because that is the one container Chromium is guaranteed
 * to demux. `-c:v copy` is what keeps remux and audio-only fast.
 *
 * No `+faststart`. It moves the index to the front so a player can begin before
 * it holds the whole file — which matters when the file arrives over a network
 * and not at all here: these are local, and the app waits for the conversion to
 * finish before it plays anything. What it costs is a COMPLETE second pass over
 * the output. Measured on a 58GB remux at 34 MB/s, that is 29 minutes of
 * rewriting on top of the 29 the first pass took, to save a seek on a file
 * sitting on the same disk.
 */
function ffmpegArgsFor(planResult, inputPath, outputPath) {
  if (!planResult || !planResult.needsWork) return null;

  // Which audio track to keep. Chromium plays track 0 and cannot switch, so
  // whichever track we map here IS the audio for that episode — this is the
  // only place the English preference actually takes effect.
  const audioIndex = Number.isInteger(planResult.audioIndex) ? planResult.audioIndex : 0;

  const common = [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-y',
    '-i', inputPath,
    '-map', '0:v:0?',
    '-map', `0:a:${audioIndex}?`,
    '-sn', '-dn',           // no subtitles, no data streams: MP4 rejects most
  ];

  if (planResult.tier === TIER.REMUX) {
    return [...common, '-c', 'copy', outputPath];
  }

  if (planResult.tier === TIER.AUDIO) {
    return [
      ...common,
      '-c:v', 'copy',
      '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
      outputPath,
    ];
  }

  // Full re-encode. veryfast because this is a background job racing a running
  // episode; quality past this point is not worth the risk of losing the race.
  return [
    ...common,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
    outputPath,
  ];
}

/**
 * Rough guess at how long preparation will take, as a multiple of runtime.
 * Used only to decide whether it is worth starting a job we may not finish.
 */
function speedFactorFor(tier) {
  if (tier === TIER.REMUX) return 0.02;  // I/O bound
  if (tier === TIER.AUDIO) return 0.05;
  if (tier === TIER.FULL) return 0.8;    // can genuinely lose the race
  return 0;
}

/**
 * Did playback fail in a way that means "this file needs converting" rather
 * than "this file is missing"?
 *
 * MediaError codes: 3 = DECODE (we got data, could not decode it), 4 =
 * SRC_NOT_SUPPORTED (container or codec refused outright). Both mean the same
 * thing for our purposes. 2 = NETWORK and 1 = ABORTED do not.
 */
function needsFallback(mediaError) {
  if (!mediaError) return false;
  const code = typeof mediaError === 'number' ? mediaError : mediaError.code;
  return code === 3 || code === 4;
}

module.exports = {
  TIER,
  NATIVE_CONTAINERS,
  REMUXABLE_CONTAINERS,
  VIDEO_SUPPORT,
  AUDIO_SUPPORT,
  codecSupport,
  codecIdFromFfprobe,
  isTextSubtitle,
  firstTrack,
  pickAudioTrack,
  isEnglish,
  isCommentary,
  normaliseLanguage,
  describeLanguage,
  planPlayback,
  ffmpegArgsFor,
  speedFactorFor,
  prettyCodec,
  needsFallback,
};
