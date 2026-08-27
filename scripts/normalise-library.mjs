/**
 * Rebuild films and episodes so nothing has to be converted during playback.
 *
 * The app converts on demand, and for a 4K disc remux that is half an hour of
 * copying while you wait. Doing it once, deliberately, up front means every
 * one of these starts instantly forever after.
 *
 * THE RULES, and how each is met:
 *
 *  1. No video quality loss.       -c:v copy. The bitstream is not decoded, not
 *                                  re-encoded, not touched. Verified elsewhere
 *                                  by hashing the video stream before and after:
 *                                  identical MD5.
 *
 *  2. As little audio loss as possible.
 *                                  Three cases, in order of preference:
 *                                    already playable -> COPY (no loss at all)
 *                                    lossless         -> FLAC (no loss at all)
 *                                    lossy            -> AAC 640k (some loss,
 *                                                        and unavoidable: the
 *                                                        player cannot decode
 *                                                        AC3, E-AC3, DTS core)
 *
 *  3. Japanese kept for sub mode.  Carried as a second audio track, under the
 *                                  same rules, with English left first so it is
 *                                  what plays by default.
 *
 *  4. English and Spanish subs.    Copied as they are, every one of them.
 *                                  Matroska carries bitmap subtitles, which is
 *                                  why the output is not MP4 — 28 of these
 *                                  files have English subs only as images, and
 *                                  MP4 would silently drop every one.
 *
 *  5. 5.1 or better.               Source channel count is preserved. Nothing
 *                                  is ever downmixed.
 *
 *  6. One format.                  Matroska throughout, which is what these
 *                                  already are.
 *
 * Nothing is overwritten and nothing is deleted. Output goes to a sibling of
 * the library rather than inside it, so a rescan does not find two copies of
 * every episode.
 *
 *   node scripts/normalise-library.mjs            what it would do
 *   node scripts/normalise-library.mjs --apply    do it
 *   --only <substring>   restrict to matching paths
 *   --limit N            stop after N files
 */

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FFMPEG = path.join(HERE, '..', 'vendor', 'ffmpeg', 'ffmpeg.exe');
const FFPROBE = path.join(HERE, '..', 'vendor', 'ffmpeg', 'ffprobe.exe');

const SOURCES = [
  'I:/TVandFilms/MOVIES',
  'I:/TVandFilms/Neon Genesis Evangelion',
];
/** Outside the library on purpose: inside it, a rescan would find both copies. */
const OUT_ROOT = 'I:/TVandFilms_converted';

const KEEP_SUBS = new Set(['eng', 'spa']);
const AUDIO_LANGS = ['eng', 'jpn'];

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const ONLY = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
const LIMIT = argv.includes('--limit') ? Number(argv[argv.indexOf('--limit') + 1]) : Infinity;

/** Codecs the player decodes as they stand — copying these loses nothing. */
const PLAYS_AS_IS = /^(aac|flac|mp3|opus|vorbis)$/i;
/** Lossless but undecodable: re-encoding to FLAC keeps every sample. */
const LOSSLESS = /^(truehd|mlp|pcm_)/i;

function probe(abs) {
  return JSON.parse(execFileSync(FFPROBE, [
    '-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', abs,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
}

/** "01:27:07.764000000" -> milliseconds. Null when the tag is absent. */
function hhmmssToMs(text) {
  const m = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(String(text || '').trim());
  if (!m) return null;
  return ((Number(m[1]) * 3600) + (Number(m[2]) * 60) + Number(m[3])) * 1000;
}

const langOf = (s) => String((s.tags && (s.tags.language || s.tags.LANGUAGE)) || 'und').toLowerCase();

function isLossless(stream) {
  if (LOSSLESS.test(stream.codec_name)) return true;
  if (/^flac$/i.test(stream.codec_name)) return true;
  // DTS is one name for a lossy core and a lossless master track; only the
  // profile separates them, and a missing profile means assume lossy — that
  // costs a bigger file, where the other mistake costs the audio.
  if (/^dts$/i.test(stream.codec_name)) return /\bMA\b|lossless/i.test(String(stream.profile || ''));
  return false;
}

/** How to carry one audio stream across. */
function audioPlan(stream) {
  if (PLAYS_AS_IS.test(stream.codec_name)) {
    return { how: 'copy', why: `${stream.codec_name} ${stream.channels}ch plays as-is` };
  }
  if (isLossless(stream)) {
    return { how: 'flac', why: `${stream.codec_name} ${stream.channels}ch lossless -> FLAC, no loss` };
  }
  const channels = Math.min(6, Number(stream.channels) || 2);
  return {
    how: 'aac',
    channels,
    bitrate: channels > 2 ? '640k' : '192k',
    why: `${stream.codec_name} ${stream.channels}ch lossy -> AAC ${channels}ch`,
  };
}

/**
 * The best audio track for a language.
 *
 * LOSSLESS first, then CHANNELS, and only then whether it happens to need
 * re-encoding.
 *
 * That order matters and the obvious one is wrong. Ghost in the Shell carries
 * English as FLAC 2.0 and as TrueHD 7.1, both lossless. Ranking "needs no
 * re-encode" above channel count picks the stereo — saving some CPU to throw
 * away five channels, when TrueHD to FLAC loses nothing at all. Quality is what
 * is scarce here; CPU is not.
 */
function bestAudio(streams, lang) {
  const candidates = streams.filter((s) => s.codec_type === 'audio' && langOf(s) === lang
    && !/commentary/i.test(String((s.tags && s.tags.title) || '')));
  if (!candidates.length) return null;
  return [...candidates].sort((a, b) => {
    const lossless = (s) => (isLossless(s) ? 0 : 1);
    const cheap = (s) => (PLAYS_AS_IS.test(s.codec_name) ? 0 : 1);
    return lossless(a) - lossless(b)
      || (Number(b.channels) || 0) - (Number(a.channels) || 0)
      || cheap(a) - cheap(b)
      || a.index - b.index;
  })[0];
}

function plan(abs) {
  const j = probe(abs);
  const streams = j.streams || [];

  // Cover art is stored as a video stream. Taking it as THE video would produce
  // a file that is one still image long.
  const video = streams.find((s) => s.codec_type === 'video'
    && !/^(png|mjpeg|bmp|gif)$/i.test(s.codec_name));
  if (!video) return null;

  const audioStreams = streams.filter((s) => s.codec_type === 'audio');
  const subStreams = streams.filter((s) => s.codec_type === 'subtitle');

  const chosenAudio = [];
  for (const lang of AUDIO_LANGS) {
    const pick = bestAudio(streams, lang);
    if (pick) chosenAudio.push({ stream: pick, lang, at: audioStreams.indexOf(pick), ...audioPlan(pick) });
  }
  // A file with neither English nor Japanese still needs sound.
  if (!chosenAudio.length && audioStreams.length) {
    const pick = audioStreams[0];
    chosenAudio.push({ stream: pick, lang: langOf(pick), at: 0, ...audioPlan(pick) });
  }

  const chosenSubs = subStreams
    .map((s, at) => ({ stream: s, lang: langOf(s), at }))
    .filter((s) => KEEP_SUBS.has(s.lang))
    // English first, then Spanish; text before bitmap inside each.
    .sort((a, b) => (a.lang === 'eng' ? 0 : 1) - (b.lang === 'eng' ? 0 : 1) || a.at - b.at);

  return {
    video,
    audio: chosenAudio,
    subs: chosenSubs,
    durationMs: (Number(j.format.duration) || 0) * 1000,
    /**
     * The VIDEO stream's own length, which is not the same as the container's.
     *
     * Several of these sources carry a track that runs past the end of the
     * picture — an extra dub, or a subtitle with a trailing entry — so the
     * container claims 24.2 minutes while the video is 23:22. Dropping those
     * tracks makes the output correctly SHORTER than its source, and comparing
     * it to the container's figure rejected six finished files as truncated.
     */
    videoMs: hhmmssToMs(video.tags && (video.tags.DURATION || video.tags['DURATION-eng'])),
    droppedAudio: audioStreams.length - chosenAudio.length,
    droppedSubs: subStreams.length - chosenSubs.length,
  };
}

function argsFor(abs, out, p) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-progress', 'pipe:1', '-i', abs];

  args.push('-map', '0:v:0', '-c:v', 'copy');

  p.audio.forEach((a, i) => {
    args.push('-map', `0:a:${a.at}`);
    if (a.how === 'copy') args.push(`-c:a:${i}`, 'copy');
    else if (a.how === 'flac') args.push(`-c:a:${i}`, 'flac', `-compression_level:a:${i}`, '5');
    else args.push(`-c:a:${i}`, 'aac', `-b:a:${i}`, a.bitrate, `-ac:a:${i}`, String(a.channels));
    args.push(`-metadata:s:a:${i}`, `language=${a.lang}`);
    // Only the first is default, so English is what plays without being asked.
    args.push(`-disposition:a:${i}`, i === 0 ? 'default' : '0');
  });

  p.subs.forEach((s, i) => {
    args.push('-map', `0:s:${s.at}`);
    args.push(`-c:s:${i}`, 'copy');
    args.push(`-metadata:s:s:${i}`, `language=${s.lang}`);
    args.push(`-disposition:s:${i}`, '0');
  });

  // Chapters and file-level metadata carried across; attachments (subtitle
  // fonts, cover art) deliberately not, since nothing here renders them.
  args.push('-map_chapters', '0');
  args.push('-map_metadata', '0');
  args.push(out);
  return args;
}

function run(args, onPercent) {
  return new Promise((resolve) => {
    /**
     * Its own process group, so a console break aimed at something else cannot
     * reach it.
     *
     * An overnight run was killed exactly that way: an unrelated command in the
     * same console was stopped, and every ffmpeg child took the break with it —
     * exit 0x40010004, DBG_TERMINATE_PROCESS, thirty-three files from the end.
     * Detached, the only thing that can stop this is this.
     */
    const child = spawn(FFMPEG, args, { windowsHide: true, detached: true });
    let stderr = '';
    let buffered = '';
    child.stdout.on('data', (chunk) => {
      buffered += chunk.toString();
      const lines = buffered.split('\n');
      buffered = lines.pop() || '';
      for (const line of lines) {
        const m = /^out_time_ms=(\d+)/.exec(line.trim());
        if (m) onPercent(Number(m[1]) / 1000);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.on('error', (e) => resolve({ ok: false, error: String(e.message) }));
    child.on('close', (code) => resolve({ ok: code === 0, code, error: stderr.trim().split('\n').pop() }));
  });
}

/**
 * Does the END of the file actually decode?
 *
 * The check that matters, and the one that was missing. Matroska writes its
 * duration into the HEADER, so a file killed mid-write still reports the full
 * running time — Fight Club came back as 8392.917 seconds, identical to its
 * source, while missing three gigabytes off the end. Track counts survive
 * truncation for the same reason. Both checks passed it, and the run skipped
 * it as done.
 *
 * Decoding the last few seconds cannot be faked by metadata. Cheap, too: it
 * seeks rather than reading the file through.
 *
 * The exit CODE is not the signal — ffmpeg returns 0 while printing "File
 * ended prematurely" — so the message is what gets read.
 */
function tailDecodes(out) {
  try {
    const r = spawnSync(FFMPEG, [
      '-hide_banner', '-nostdin', '-v', 'error',
      '-sseof', '-20', '-i', out, '-map', '0:v:0', '-frames:v', '30', '-f', 'null', '-',
    ], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
    const said = String(r.stderr || '');
    if (/ended prematurely|Invalid data|corrupt|Truncat/i.test(said)) return false;
    return !r.error;
  } catch { return false; }
}

/**
 * Why an existing output cannot be kept, or null if it can.
 *
 * Length is compared VIDEO to VIDEO, never container to container. This
 * library made that necessary twice over, in opposite directions:
 *
 *  - Some sources carry a track running PAST the end of the picture, so the
 *    container claims 24.2 minutes for 23:22 of video. Dropping those tracks
 *    makes a correct output look short.
 *  - Three Evangelion episodes have audio five and a half minutes LONGER than
 *    their video — 28:52 against 23:22, apparently from a longer cut. The
 *    output inherits that, so a correct file looks long.
 *  - And three sources report no container duration at all.
 *
 * The video streams match to the millisecond in every one of those cases,
 * because the video is copied. That is the comparison worth making; the rest
 * is left to the tail decode, which is the only check a truncated file cannot
 * pass anyway.
 */
function stale(out, p) {
  let j;
  try { j = probe(out); } catch { return 'unreadable'; }

  const outVideo = (j.streams || []).find((s) => s.codec_type === 'video');
  const outMs = outVideo
    ? hhmmssToMs(outVideo.tags && (outVideo.tags.DURATION || outVideo.tags['DURATION-eng']))
    : null;
  if (p.videoMs && outMs && Math.abs(outMs - p.videoMs) / p.videoMs > 0.02) {
    return `video is ${(outMs / 60000).toFixed(1)} min, source is ${(p.videoMs / 60000).toFixed(1)}`;
  }
  const audio = (j.streams || []).filter((s) => s.codec_type === 'audio');
  if (audio.length !== p.audio.length) return `has ${audio.length} audio tracks, expected ${p.audio.length}`;
  const subs = (j.streams || []).filter((s) => s.codec_type === 'subtitle');
  if (subs.length !== p.subs.length) return `has ${subs.length} subtitle tracks, expected ${p.subs.length}`;

  // Last, because it is the only one that costs anything — and the only one a
  // truncated file cannot get past.
  if (!tailDecodes(out)) return 'truncated — the end does not decode';

  return null;
}

const gb = (n) => `${(n / 1073741824).toFixed(2)} GB`;
const clock = (s) => {
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};

async function main() {
  const files = [];
  for (const dir of SOURCES) {
    if (!fs.existsSync(dir)) { console.log(`missing: ${dir}`); continue; }
    for (const name of fs.readdirSync(dir).sort()) {
      if (!/\.mkv$/i.test(name)) continue;
      // A .fixed.mkv supersedes its original: it already has the right track
      // order and the unwanted languages gone.
      if (fs.existsSync(path.join(dir, name.replace(/\.mkv$/i, '.fixed.mkv')))) continue;
      const abs = path.join(dir, name);
      if (ONLY && !abs.toLowerCase().includes(ONLY.toLowerCase())) continue;
      files.push({ abs, dir, name });
    }
  }

  console.log(APPLY ? 'CONVERTING' : 'DRY RUN — nothing will be written');
  console.log(`  out   ${OUT_ROOT}`);
  console.log(`  files ${files.length}\n`);

  let done = 0;
  let sourceBytes = 0;
  const started = Date.now();

  for (const f of files) {
    if (done >= LIMIT) break;

    let p;
    try { p = plan(f.abs); } catch (e) { console.log(`  ?? ${f.name} — ${e.message}`); continue; }
    if (!p) { console.log(`  ?? ${f.name} — no video stream`); continue; }

    const outDir = path.join(OUT_ROOT, path.basename(f.dir));
    const out = path.join(outDir, f.name.replace(/\.fixed\.mkv$/i, '.mkv'));
    const size = fs.statSync(f.abs).size;

    if (fs.existsSync(out)) {
      const why = stale(out, p);
      if (!why) { console.log(`  ${f.name.slice(0, 58)}\n      already done — skipped\n`); continue; }
      console.log(`  ${f.name.slice(0, 58)}\n      existing output is ${why} — redoing`);
      if (APPLY) await fsp.unlink(out).catch(() => {});
    } else {
      console.log(`  ${f.name.slice(0, 58)}`);
    }

    console.log(`      ${gb(size)}  ·  video copied as-is (${p.video.codec_name} ${p.video.width}x${p.video.height})`);
    for (const a of p.audio) console.log(`      audio ${a.lang}: ${a.why}`);
    console.log(`      subs: ${p.subs.length} kept (${p.subs.filter((s) => s.lang === 'eng').length} eng,`
      + ` ${p.subs.filter((s) => s.lang === 'spa').length} spa), ${p.droppedSubs} dropped`
      + `  ·  ${p.droppedAudio} audio tracks dropped`);

    done += 1;
    sourceBytes += size;

    if (!APPLY) { console.log(''); continue; }

    await fsp.mkdir(outDir, { recursive: true });
    const result = await run(argsFor(f.abs, out, p), (ms) => {
      if (!p.durationMs) return;
      const pct = Math.min(100, (ms / p.durationMs) * 100);
      process.stdout.write(`\r      ${pct.toFixed(0).padStart(3)}%   `);
    });
    process.stdout.write('\r');

    if (!result.ok) {
      console.log(`      FAILED (${result.code}) ${result.error || ''}\n`);
      await fsp.unlink(out).catch(() => {});
      continue;
    }
    const why = stale(out, p);
    if (why) {
      console.log(`      NOT ACCEPTED — ${why}. Left for inspection.\n`);
      continue;
    }
    console.log(`      done — ${gb(size)} to ${gb(fs.statSync(out).size)}`
      + `   (${clock((Date.now() - started) / 1000)} elapsed, ${done}/${files.length})\n`);
  }

  console.log(`\n  ${done} file${done === 1 ? '' : 's'}, ${gb(sourceBytes)} of source`);
  if (!APPLY && done) console.log('\n  Add --apply to do it.');
}

main().catch((e) => { console.error(e.stack || e); process.exit(1); });
