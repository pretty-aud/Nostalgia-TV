'use strict';

/**
 * Preparing unplayable files ahead of time.
 *
 * The scheduler commits its queue in advance, which is what makes this possible
 * at all: we know what is playing in twenty minutes, so anything that needs
 * converting can be converted NOW, from a real file on disk, while the current
 * episode is still running. That is why this app can handle codecs a streaming
 * player cannot — it is never converting under time pressure, and the result is
 * a complete local file with working seek rather than a fragile live pipe.
 *
 * Everything here is main-process only: spawning, filesystem, cache eviction.
 * The decision of WHAT to do lives in ../src/shared/playability.js, which is
 * pure and tested; this module only carries it out.
 */

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const { probeMatroska } = require('../src/shared/probeMatroska.js');
const {
  planPlayback, ffmpegArgsFor, TIER,
  codecIdFromFfprobe, isTextSubtitle, describeLanguage, isCommentary, pickAudioTrack,
} = require('../src/shared/playability.js');

// Tracks usually sits within the first megabyte, but a file carrying cover art
// or a fat SeekHead can push it back. Read small, escalate once if that missed.
const HEAD_BYTES = 4 * 1024 * 1024;
const HEAD_BYTES_RETRY = 24 * 1024 * 1024;

/** Leave the disk room to breathe; a full disk breaks far more than this app. */
const MIN_FREE_BYTES = 5 * 1024 * 1024 * 1024;
const DEFAULT_CACHE_BUDGET = 6 * 1024 * 1024 * 1024;

let cacheDir = null;
let ffmpegPathCache = undefined; // undefined = not looked for yet, null = absent

/** Paths that must survive eviction: what is playing, and what is next. */
const pinned = new Set();

/** absPath -> { promise, cancel, tier, startedAt } */
const jobs = new Map();

function setCacheDir(dir) {
  cacheDir = dir;
}

// ---------------------------------------------------------------------------
// locating ffmpeg
// ---------------------------------------------------------------------------

/**
 * ffmpeg is optional. Without it the app still plays everything Chromium can
 * handle and labels the rest honestly, which is a far better failure mode than
 * refusing to start — so this returns null rather than throwing.
 *
 * Checked in order: bundled alongside the app, then the PATH, then the usual
 * Windows install locations that never add themselves to the PATH.
 */
/**
 * Prove a candidate by RUNNING it, not by trusting the filesystem.
 *
 * winget installs ffmpeg as a zero-byte reparse point in its Links folder, and
 * statSync on one of those can report ENOENT even though spawning it works
 * perfectly. Existence checks also happily accept a dead symlink or a stub that
 * fails the moment it matters — which would be halfway through an episode.
 * Running `-version` once at startup settles it for good.
 */
function isRunnable(candidate) {
  if (!candidate) return false;
  try {
    const result = spawnSync(candidate, ['-version'], {
      windowsHide: true, timeout: 8000, stdio: 'ignore',
    });
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

/**
 * ffmpeg is optional. Without it the app still plays everything Chromium can
 * handle and labels the rest honestly, which is a far better failure mode than
 * refusing to start — so this returns null rather than throwing.
 */
/**
 * Every place ffmpeg might be, in the order they should be tried.
 *
 * Split out from findFfmpeg because the ORDER is the part with consequences and
 * the part that cannot otherwise be checked. The installer bundles a copy, and
 * that copy has to beat whatever the machine already has — but on any machine
 * that already has ffmpeg, which is every developer machine by definition, a
 * working app looks exactly the same whether the bundled copy won, lost, or
 * never shipped at all. Testing this list tests that. Running the candidates
 * cannot.
 */
function ffmpegCandidates() {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const candidates = [];

  // Shipped as an electron-builder extraResource. FIRST, deliberately: a copy
  // inside the app is the one this build was tested against, and the only one
  // that is certain to be there at all.
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'ffmpeg', exe));
    candidates.push(path.join(process.resourcesPath, exe));
  }

  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, exe));
  }

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || '';
    candidates.push(
      'C:\\ffmpeg\\bin\\ffmpeg.exe',
      'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
      path.join(localAppData, 'Microsoft\\WinGet\\Links\\ffmpeg.exe'),
      ...wingetPackageCandidates(localAppData, exe),
    );
  } else {
    candidates.push('/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg');
  }

  // Last resort: let the OS resolve it. This is what rescues an install whose
  // real location we do not know but which is genuinely on the PATH.
  candidates.push(exe);
  return candidates;
}

/**
 * ffmpeg is optional even now that it is bundled: an install can lose files,
 * and a dev run has no resourcesPath at all. Returning null lets the app fall
 * back to labelling what it cannot play rather than refusing to start.
 */
function findFfmpeg() {
  if (ffmpegPathCache !== undefined) return ffmpegPathCache;

  for (const candidate of ffmpegCandidates()) {
    if (isRunnable(candidate)) {
      ffmpegPathCache = candidate;
      return candidate;
    }
  }

  ffmpegPathCache = null;
  return null;
}

/**
 * winget's Links entry is a shim; the real binary lives under Packages in a
 * version-stamped folder. Finding it directly means a broken shim does not cost
 * us the whole feature.
 */
function wingetPackageCandidates(localAppData, exe) {
  if (!localAppData) return [];
  const root = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages');
  const found = [];
  try {
    for (const pkg of fs.readdirSync(root)) {
      if (!/ffmpeg/i.test(pkg)) continue;
      const pkgDir = path.join(root, pkg);
      for (const build of fs.readdirSync(pkgDir)) {
        found.push(path.join(pkgDir, build, 'bin', exe));
      }
    }
  } catch { /* no winget, or nothing installed through it */ }
  return found;
}

/**
 * Whether the player could actually decode a file, remembered on disk.
 *
 * The codec tables are a guess made from stream ids. This is the answer,
 * measured by the renderer playing a few seconds and reading how many bytes
 * came out of the decoders. Worth persisting because the measurement costs a
 * few seconds and the alternative it avoids costs half an hour.
 *
 * Keyed like every other cache entry, so it is evicted with the file it
 * describes and invalidated when that file changes.
 */
async function readVerdict(absPath) {
  try {
    const key = await cacheKeyFor(absPath, 'play');
    return JSON.parse(await fsp.readFile(path.join(cacheDir, key + '.play.json'), 'utf8'));
  } catch { return null; }
}

async function writeVerdict(absPath, verdict) {
  try {
    const key = await cacheKeyFor(absPath, 'play');
    await fsp.writeFile(
      path.join(cacheDir, key + '.play.json'),
      JSON.stringify({ ...verdict, at: Date.now() }),
    );
    return { ok: true };
  } catch (error) { return { ok: false, error: String(error && error.message) }; }
}

/** Forget the cached result, so a fresh install is picked up without a restart. */
function rescanFfmpeg() {
  ffmpegPathCache = undefined;
  ffprobePathCache = undefined;
  return findFfmpeg();
}

let ffprobePathCache = undefined;

/**
 * Muxer boilerplate that pretends to be a track title.
 *
 * Practically every MP4 carries handler names like "SoundHandler", and some
 * tools write the encoder string into the title. Shown in a menu these read as
 * meaningful descriptions when they describe nothing at all.
 */
const JUNK_TRACK_TITLES = /^(sound|video|subtitle|text|data)handler$|^core media|^iso media|^bento4|^gpac|^lavf|^\s*$/i;

function cleanTrackTitle(title) {
  const text = String(title || '').trim();
  if (!text || JUNK_TRACK_TITLES.test(text)) return null;
  return text;
}

/**
 * Run a short-lived tool and collect its stdout, without blocking the process.
 * Bounded by a timeout so a wedged probe cannot hold up a transition forever.
 */
function runCapture(exe, args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (error) {
      resolve({ ok: false, error: String(error) });
      return;
    }

    let stdout = '';
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } done({ ok: false, error: 'timeout' }); }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 8 * 1024 * 1024) { try { child.kill(); } catch { /* gone */ } }
    });
    child.on('error', (error) => done({ ok: false, error: String(error) }));
    child.on('close', (code) => done({ ok: code === 0, stdout, code }));
  });
}

/** ffprobe ships beside ffmpeg; same name, same folder, same proof-by-running. */
function findFfprobe() {
  if (ffprobePathCache !== undefined) return ffprobePathCache;
  const ffmpeg = findFfmpeg();
  const exe = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';

  const candidates = [];
  if (ffmpeg) candidates.push(path.join(path.dirname(ffmpeg), exe));
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, exe));
  }
  if (process.platform === 'win32') {
    candidates.push(...wingetPackageCandidates(process.env.LOCALAPPDATA || '', exe));
  }
  candidates.push(exe);

  for (const candidate of candidates) {
    if (isRunnable(candidate)) { ffprobePathCache = candidate; return candidate; }
  }
  ffprobePathCache = null;
  return null;
}

// ---------------------------------------------------------------------------
// track listing
// ---------------------------------------------------------------------------

/**
 * Read every stream in a file, in any container.
 *
 * The hand-written Matroska parser only understands .mkv, but a dual-audio
 * release is just as likely to be .mp4 — writing an ISO-BMFF parser to match
 * would be a lot of code to duplicate something ffprobe already does perfectly.
 * So ffprobe is preferred whenever it exists, and the header parser stays as
 * the no-ffmpeg fallback.
 */
async function probeWithFfprobe(absPath) {
  const ffprobe = findFfprobe();
  if (!ffprobe) return null;

  // Deliberately async. spawnSync here would block the MAIN process, and the
  // main process is what serves media:// — a synchronous probe would stall the
  // video currently playing, which is the one thing this app must never do.
  const result = await runCapture(ffprobe, [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_streams',
    // Duration too, which nothing needed until progress did: without a total
    // there is no percentage and no estimate, only a number going up.
    '-show_format',
    absPath,
  ]);

  if (!result.ok || !result.stdout) return null;

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return null;
  }

  const durationMs = Number(parsed.format && parsed.format.duration) > 0
    ? Number(parsed.format.duration) * 1000
    : null;

  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const tracks = streams
    .filter((s) => ['video', 'audio', 'subtitle'].includes(s.codec_type))
    .map((s) => {
      const tags = s.tags || {};
      const disposition = s.disposition || {};
      return {
        type: s.codec_type,
        codecId: codecIdFromFfprobe(s.codec_name),
        codecName: s.codec_name || null,
        language: tags.language || tags.LANGUAGE || null,
        languageBcp47: null,
        // handler_name is deliberately NOT used as a title. Muxers stamp every
        // MP4 with "SoundHandler"/"VideoHandler", which is not a description of
        // anything and turns every track label into noise.
        name: cleanTrackTitle(tags.title),
        // CODED dimensions — cropdetect reports in these, not display pixels.
        width: Number(s.coded_width) || Number(s.width) || null,
        height: Number(s.coded_height) || Number(s.height) || null,
        duration: Number(s.duration) || null,
        channels: Number.isFinite(s.channels) ? s.channels : null,
        channelLayout: s.channel_layout || null,
        default: disposition.default === 1,
        forced: disposition.forced === 1,
        comment: disposition.comment === 1,
      };
    });

  return { ok: tracks.length > 0, tracks, source: 'ffprobe', durationMs };
}

/**
 * The audio and subtitle tracks, labelled for a person to choose between.
 *
 * `index` counts within its own kind, because that is what both ffmpeg's
 * `-map 0:a:N` and the UI need.
 */
async function listTracks(absPath) {
  const probe = (await probeWithFfprobe(absPath)) || { ok: false, tracks: [] };

  const label = (track, i, kind, disambiguate) => {
    const language = describeLanguage(track.language);
    const parts = [language === 'untagged' ? `${kind} ${i + 1}` : language];
    if (track.name && track.name.toLowerCase() !== language.toLowerCase()) parts.push(track.name);
    if (isCommentary(track)) parts.push('commentary');
    if (track.forced) parts.push('forced');
    // Only when it is needed to tell two tracks apart. A file with one English
    // track does not need "English · 5.1 · eac3" — that is noise until the
    // moment there are two English tracks and no other way to choose.
    if (disambiguate) {
      if (track.channelLayout) parts.push(track.channelLayout);
      else if (track.channels) parts.push(`${track.channels}ch`);
      if (track.codecName) parts.push(track.codecName);
    }
    return parts.join(' · ');
  };

  const audioTracks = probe.tracks.filter((t) => t.type === 'audio');
  // Two tracks reading identically is the same as having no choice at all.
  const languageCounts = new Map();
  for (const track of audioTracks) {
    const key = describeLanguage(track.language);
    languageCounts.set(key, (languageCounts.get(key) || 0) + 1);
  }

  const audio = audioTracks.map((t, i) => ({
    index: i,
    label: label(t, i, 'Track', languageCounts.get(describeLanguage(t.language)) > 1),
    language: t.language || null,
    codec: t.codecName,
    default: t.default,
    commentary: isCommentary(t),
  }));

  const subtitleTracks = probe.tracks.filter((t) => t.type === 'subtitle');
  const subLanguageCounts = new Map();
  for (const track of subtitleTracks) {
    const key = describeLanguage(track.language);
    subLanguageCounts.set(key, (subLanguageCounts.get(key) || 0) + 1);
  }

  // Subtitles never disambiguate by codec: which of subrip/ass a track happens
  // to be tells you nothing about whether it is the one you want to read.
  const subtitles = subtitleTracks.map((t, i) => ({
    index: i,
    label: label(t, i, 'Subtitles', false),
    language: t.language || null,
    codec: t.codecName,
    forced: t.forced,
    // Image-based subs cannot become WebVTT; the UI has to say so rather than
    // offering a button that quietly does nothing.
    usable: isTextSubtitle(t.codecName),
  }));

  /**
   * Last resort: number anything that still reads identically.
   *
   * Releases really do ship two tracks with the same language, layout and
   * codec, distinguishable only by position. Two identical menu entries are the
   * same as having no choice, so this guarantees every row is at least pickable
   * even when the file gives us nothing to tell them apart with.
   */
  const dedupe = (items) => {
    const counts = new Map();
    for (const item of items) counts.set(item.label, (counts.get(item.label) || 0) + 1);
    return items.map((item) => (counts.get(item.label) > 1
      ? { ...item, label: `${item.label} (${item.index + 1})` }
      : item));
  };

  const chosen = pickAudioTrack(probe.tracks, {});
  return {
    ok: probe.ok,
    audio: dedupe(audio),
    subtitles: dedupe(subtitles),
    defaultAudioIndex: Math.max(0, chosen.index),
    probed: Boolean(probe.ok),
  };
}

function hasFfmpeg() {
  return findFfmpeg() !== null;
}

// ---------------------------------------------------------------------------
// probing
// ---------------------------------------------------------------------------

async function readHead(absPath, byteCount) {
  const handle = await fsp.open(absPath, 'r');
  try {
    const buffer = Buffer.alloc(byteCount);
    const { bytesRead } = await handle.read(buffer, 0, byteCount, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Read a file's codecs and decide its tier.
 *
 * Only Matroska needs the header parse — for MP4 and WebM the container itself
 * is the answer, and planPlayback handles a missing probe.
 */
async function inspect(absPath, options = {}) {
  const fileName = path.basename(absPath);
  const ext = path.extname(fileName).toLowerCase();

  // ffprobe first: it reads every container and, crucially, carries the
  // language tags. The header parser only understands Matroska, so without
  // this a dual-audio .mp4 would silently keep whatever track came first.
  let probe = await probeWithFfprobe(absPath);

  if ((!probe || !probe.ok) && (ext === '.mkv' || ext === '.webm')) {
    try {
      probe = probeMatroska(await readHead(absPath, HEAD_BYTES));
      // Tracks sat past our window — one bigger read before giving up, because
      // the alternative is re-encoding a file that only needed repackaging.
      if (!probe.ok && probe.truncated) {
        probe = probeMatroska(await readHead(absPath, HEAD_BYTES_RETRY));
      }
    } catch (error) {
      probe = { ok: false, tracks: [], reason: String(error && error.message) };
    }
  }

  return {
    ...planPlayback({ fileName, probe, audioIndex: options.audioIndex }),
    absPath,
  };
}

// ---------------------------------------------------------------------------
// cache
// ---------------------------------------------------------------------------

/**
 * Cache key includes size and mtime, so replacing a file with a different rip
 * at the same path produces a different key instead of silently serving the
 * old conversion for the rest of the library's life.
 */
async function cacheKeyFor(absPath, tier) {
  let stamp = '';
  try {
    const stat = await fsp.stat(absPath);
    stamp = `${stat.size}:${Math.floor(stat.mtimeMs)}`;
  } catch { /* fall through with an empty stamp */ }
  return crypto.createHash('sha1').update(`${absPath}|${stamp}|${tier}`).digest('hex');
}

function cachePathFor(key) {
  return path.join(cacheDir, `${key}.mp4`);
}

async function freeBytes() {
  try {
    const stats = await fsp.statfs(cacheDir);
    return stats.bavail * stats.bsize;
  } catch {
    return Number.MAX_SAFE_INTEGER; // cannot tell: do not block on it
  }
}

async function cacheEntries() {
  try {
    const names = await fsp.readdir(cacheDir);
    const entries = [];
    for (const name of names) {
      if (!name.endsWith('.mp4')) continue;
      const full = path.join(cacheDir, name);
      try {
        const stat = await fsp.stat(full);
        entries.push({ path: full, size: stat.size, atime: stat.atimeMs });
      } catch { /* vanished under us */ }
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Evict least-recently-used conversions until the cache fits its budget.
 *
 * Never evicts a pinned file. Deleting the episode currently on screen would
 * kill playback mid-scene, and deleting the next one would waste the work we
 * did precisely so the transition would be seamless.
 */
async function enforceBudget(budget = DEFAULT_CACHE_BUDGET) {
  const entries = await cacheEntries();
  let total = entries.reduce((n, e) => n + e.size, 0);
  if (total <= budget) return { evicted: 0, total };

  entries.sort((a, b) => a.atime - b.atime); // oldest touched first
  let evicted = 0;
  for (const entry of entries) {
    if (total <= budget) break;
    if (pinned.has(entry.path)) continue;
    try {
      await fsp.unlink(entry.path);
      total -= entry.size;
      evicted += 1;
    } catch { /* in use, or already gone */ }
  }
  return { evicted, total };
}

function pin(filePath) {
  if (filePath) pinned.add(filePath);
}

function unpinAllExcept(keep = []) {
  const keepSet = new Set(keep.filter(Boolean));
  for (const value of [...pinned]) {
    if (!keepSet.has(value)) pinned.delete(value);
  }
}

async function clearCache() {
  const entries = await cacheEntries();
  let removed = 0;
  for (const entry of entries) {
    try { await fsp.unlink(entry.path); removed += 1; } catch { /* ignore */ }
  }
  return { removed };
}

// ---------------------------------------------------------------------------
// conversion
// ---------------------------------------------------------------------------

/**
 * Redirect a finished argument list at the .part file.
 *
 * 🚨 `-f mp4` is not optional here. ffmpeg chooses its muxer from the output
 * file's EXTENSION, and `<hash>.mp4.part` has no extension it recognises — it
 * fails instantly with "Unable to choose an output format" and writes nothing.
 * That is a silent, total failure: every conversion dies, the cache stays
 * empty, and every file needing one gets skipped as unplayable. Stating the
 * format explicitly is what lets the crash-safety rename survive at all.
 *
 * Exported so a test can hold the line on it without spawning ffmpeg.
 */
function partArgsFor(args, outputPath, partPath) {
  return args.flatMap((arg) => (arg === outputPath ? ['-f', 'mp4', partPath] : [arg]));
}

/**
 * Run ffmpeg for one file.
 *
 * Output goes to a .part file that is renamed only on a clean exit. Without
 * that, a crash or a quit mid-convert leaves a truncated MP4 sitting at the
 * cache path, and every future run treats it as a finished conversion — the
 * episode would play halfway and stop, forever, with nothing to indicate why.
 */
// totalMs comes from the plan rather than being measured here: ffmpeg reports
// how far it has got, never how far there is to go.
function runFfmpeg(ffmpeg, args, outputPath, onProgress, totalMs) {
  const partPath = `${outputPath}.part`;
  const finalArgs = partArgsFor(args, outputPath, partPath);

  let child = null;
  let cancelled = false;

  const promise = new Promise((resolve) => {
    child = spawn(ffmpeg, ['-progress', 'pipe:1', ...finalArgs], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    if (onProgress) {
      let buffered = '';
      child.stdout.on('data', (chunk) => {
        buffered += chunk.toString();
        const lines = buffered.split('\n');
        buffered = lines.pop() || '';
        for (const line of lines) {
          const match = /^out_time_ms=(\d+)/.exec(line.trim());
          if (match) onProgress({ outMs: Number(match[1]) / 1000, totalMs });
        }
      });
    }

    child.on('error', (error) => {
      resolve({ ok: false, error: String(error && error.message ? error.message : error) });
    });

    child.on('close', async (code) => {
      if (cancelled) {
        await fsp.unlink(partPath).catch(() => {});
        resolve({ ok: false, cancelled: true });
        return;
      }
      if (code !== 0) {
        await fsp.unlink(partPath).catch(() => {});
        resolve({ ok: false, error: stderr.trim().split('\n').slice(-3).join(' ') || `ffmpeg exited ${code}` });
        return;
      }
      try {
        await fsp.rename(partPath, outputPath);
        resolve({ ok: true, path: outputPath });
      } catch (error) {
        resolve({ ok: false, error: String(error) });
      }
    });
  });

  return {
    promise,
    cancel: () => {
      cancelled = true;
      if (child && !child.killed) child.kill();
    },
  };
}

/**
 * Ensure a playable file exists for `absPath`, converting if necessary.
 *
 * Returns { ok, tier, playablePath, prepared, reason }. `playablePath` is the
 * original when no work was needed, so callers have one field to read.
 *
 * Concurrent calls for the same path share one job — the renderer legitimately
 * asks twice (once to prepare ahead, once when the episode actually starts),
 * and two ffmpeg processes writing the same output would corrupt it.
 */
async function ensurePlayable(absPath, options = {}) {
  let plan = options.plan || await inspect(absPath, { audioIndex: options.audioIndex });

  /**
   * The codec tables are a prediction, and two cases can beat them: a codec id
   * we have never seen, and H.265, whose support depends on the machine rather
   * than the file. Both are planned optimistically, so when playback actually
   * fails the caller escalates by asking for a specific tier — otherwise we
   * would hand back the same unplayable conversion from cache forever.
   */
  if (options.forceTier && options.forceTier !== plan.tier) {
    plan = {
      ...plan,
      tier: options.forceTier,
      needsWork: true,
      copiesVideo: options.forceTier === TIER.REMUX || options.forceTier === TIER.AUDIO,
      reason: `Playback failed; re-preparing as ${options.forceTier}.`,
    };
  }

  if (!plan.needsWork) {
    return { ok: true, tier: plan.tier, playablePath: absPath, prepared: false, plan };
  }

  // The audio track is part of the identity of the output: switching language
  // must produce a DIFFERENT cached file, or the first conversion would be
  // served forever and the audio menu would appear to do nothing.
  const variant = `${plan.tier}:a${Number.isInteger(plan.audioIndex) ? plan.audioIndex : 0}`;
  const key = await cacheKeyFor(absPath, variant);
  const outputPath = cachePathFor(key);
  // Jobs are keyed by variant too, so preparing English and Japanese at once
  // are two jobs rather than one silently returning the other's result.
  const jobKey = `${absPath}|${variant}`;

  try {
    const stat = await fsp.stat(outputPath);
    if (stat.size > 0) {
      // Touch it so LRU eviction sees this as recently used.
      const now = new Date();
      await fsp.utimes(outputPath, now, stat.mtime).catch(() => {});
      return { ok: true, tier: plan.tier, playablePath: outputPath, prepared: false, cached: true, plan };
    }
  } catch { /* not converted yet */ }

  const existing = jobs.get(jobKey);
  if (existing) {
    const result = await existing.promise;
    return result;
  }

  const ffmpeg = findFfmpeg();
  if (!ffmpeg) {
    /**
     * Without ffmpeg nothing can be converted — but refusing outright would be
     * far too pessimistic for the remux tier. Those files hold codecs Chromium
     * definitely supports and only the CONTAINER is in question, and Chromium
     * demuxes a good number of .mkv files anyway. Handing back the original and
     * letting the player try costs nothing: if it fails, the error path skips
     * it, which is exactly where refusing would have left us.
     *
     * The other tiers genuinely cannot work, so those are reported honestly.
     */
    if (plan.tier === TIER.REMUX) {
      return {
        ok: true, tier: plan.tier, playablePath: absPath,
        prepared: false, unconverted: true, plan,
      };
    }
    return {
      ok: false, tier: plan.tier, playablePath: null, plan,
      reason: 'ffmpeg not found', needsFfmpeg: true,
    };
  }

  if (await freeBytes() < MIN_FREE_BYTES) {
    // Try to make room from our own cache before refusing outright.
    await enforceBudget(Math.floor(DEFAULT_CACHE_BUDGET / 2));
    if (await freeBytes() < MIN_FREE_BYTES) {
      return {
        ok: false, tier: plan.tier, playablePath: null, plan,
        reason: 'not enough free disk space to prepare this episode', lowDisk: true,
      };
    }
  }

  await fsp.mkdir(cacheDir, { recursive: true });
  const args = ffmpegArgsFor(plan, absPath, outputPath);

  const job = runFfmpeg(ffmpeg, args, outputPath, options.onProgress, plan.durationMs || null);
  const wrapped = job.promise.then(async (result) => {
    jobs.delete(jobKey);
    if (!result.ok) {
      return {
        ok: false, tier: plan.tier, playablePath: null, plan,
        reason: result.cancelled ? 'cancelled' : result.error,
        cancelled: Boolean(result.cancelled),
      };
    }
    pin(outputPath);
    await enforceBudget(options.budget || DEFAULT_CACHE_BUDGET);
    return { ok: true, tier: plan.tier, playablePath: outputPath, prepared: true, plan };
  });

  jobs.set(jobKey, {
    promise: wrapped, cancel: job.cancel, tier: plan.tier, absPath, startedAt: Date.now(),
  });
  return wrapped;
}

/** Like runCapture, but keeps stderr — where ffmpeg's filters report. */
function runCaptureErr(exe, args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, stderr: '', error: String(error) });
      return;
    }
    let stderr = '';
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } done({ ok: false, stderr }); }, timeoutMs);
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 2 * 1024 * 1024) stderr = stderr.slice(-1024 * 1024);
    });
    child.on('error', (error) => done({ ok: false, stderr, error: String(error) }));
    child.on('close', (code) => done({ ok: code === 0, stderr }));
  });
}

/**
 * Find the real picture inside a frame that has black bars baked into it.
 *
 * Some releases encode 4:3 material inside a 16:9 frame, with the pillarbox
 * burnt into the video. `object-fit` cannot help: those bars are part of the
 * image, so a correctly-fitted frame still shows them, and on a window that is
 * not 16:9 you get black on all four sides at once. The only fix is to find the
 * content and scale it up past the edges.
 *
 * Sampled at several points and UNIONED rather than averaged: a dark scene
 * detects a smaller region than the picture really is, and cropping to that
 * would cut real image off every other scene. Taking the largest box anyone saw
 * is the safe direction to be wrong in.
 *
 * Returns fractions of the frame, so the caller never has to think about
 * anamorphic pixels — 852x480 tagged 16:9 is the exact case this exists for.
 */
async function detectCrop(absPath) {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return null;

  const key = await cacheKeyFor(absPath, 'crop');
  const cacheFile = path.join(cacheDir, `${key}.crop.json`);
  try {
    return JSON.parse(await fsp.readFile(cacheFile, 'utf8'));
  } catch { /* not detected yet */ }

  const probe = await probeWithFfprobe(absPath);
  const video = (probe && probe.tracks || []).find((t) => t.type === 'video');
  if (!video || !video.width || !video.height) return null;

  const duration = Number(video.duration) || 0;
  const points = duration > 60
    ? [0.15, 0.35, 0.55, 0.75].map((f) => Math.floor(duration * f))
    : [1, 3, 5];

  const boxes = [];
  for (const at of points) {
    const result = await runCaptureErr(ffmpeg, [
      '-hide_banner', '-nostdin',
      '-ss', String(at),
      '-i', absPath,
      '-frames:v', '30',
      '-vf', 'cropdetect=24:2:0',
      '-f', 'null', '-',
    ], 45000);
    const found = [...result.stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
    if (!found.length) continue;
    const last = found[found.length - 1];
    boxes.push({ w: +last[1], h: +last[2], x: +last[3], y: +last[4] });
  }
  if (boxes.length === 0) return null;

  const left = Math.min(...boxes.map((b) => b.x));
  const top = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.w));
  const bottom = Math.max(...boxes.map((b) => b.y + b.h));

  const crop = {
    fx: left / video.width,
    fy: top / video.height,
    fw: (right - left) / video.width,
    fh: (bottom - top) / video.height,
    frame: `${video.width}x${video.height}`,
    detected: `${right - left}x${bottom - top}+${left}+${top}`,
    samples: boxes.length,
  };

  // Anything within a couple of percent of the full frame has no bars worth
  // cropping, and acting on it would only risk shaving the picture.
  crop.worthCropping = crop.fw < 0.98 || crop.fh < 0.98;

  try {
    await fsp.mkdir(cacheDir, { recursive: true });
    await fsp.writeFile(cacheFile, JSON.stringify(crop), 'utf8');
  } catch { /* cache is an optimisation, not a requirement */ }
  return crop;
}

/**
 * Pull one subtitle track out to a WebVTT file the <video> element can load.
 *
 * Subtitles are the one thing that CAN be switched live: Chromium has no audio
 * track API, but it renders <track> elements and toggles them instantly. So
 * changing audio costs a conversion and changing subtitles does not.
 *
 * Text-based formats only. PGS and VobSub are bitmap images, and the only way
 * to show those is to burn them into the picture — a full re-encode, and not
 * something to start behind someone's back.
 */
async function extractSubtitle(absPath, index) {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return { ok: false, reason: 'ffmpeg not found', needsFfmpeg: true };

  const key = await cacheKeyFor(absPath, `sub${index}`);
  const outputPath = path.join(cacheDir, `${key}.vtt`);

  try {
    const stat = await fsp.stat(outputPath);
    if (stat.size > 0) return { ok: true, path: outputPath, cached: true };
  } catch { /* not extracted yet */ }

  await fsp.mkdir(cacheDir, { recursive: true });
  const partPath = `${outputPath}.part`;

  /**
   * Long enough for the size of the file, not a flat two minutes.
   *
   * Subtitle packets are interleaved through the whole container, so pulling a
   * track means READING THE WHOLE FILE — there is no index to seek by and no
   * shortcut. A 24GB movie takes about twelve minutes of that. The old flat
   * 120s budget killed it every single time, deleted the part file, and left
   * "could not load those subtitles" as the only trace: a timeout reported as
   * a broken file.
   *
   * Budgeted at a deliberately pessimistic 8 MB/s so a slow or contended disk
   * still finishes, floored so small files are not given a silly window, and
   * capped so a genuinely stuck ffmpeg is still eventually reaped.
   */
  const MIN_SUBTITLE_MS = 120000;
  const MAX_SUBTITLE_MS = 45 * 60 * 1000;
  const ASSUMED_BYTES_PER_MS = 8 * 1024;   // 8 MB/s
  let budget = MIN_SUBTITLE_MS;
  try {
    const { size } = await fsp.stat(absPath);
    budget = Math.min(MAX_SUBTITLE_MS, Math.max(MIN_SUBTITLE_MS, size / ASSUMED_BYTES_PER_MS));
  } catch { /* unreadable size: the floor is a fine guess */ }

  // `-f webvtt` for the same reason the video path needs `-f mp4`: output goes
  // to a .part file, and ffmpeg would otherwise have no extension to infer the
  // format from and would fail having written nothing.
  const result = await runCapture(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-i', absPath,
    '-map', `0:s:${index}`,
    '-f', 'webvtt',
    partPath,
  ], budget);

  if (!result.ok) {
    await fsp.unlink(partPath).catch(() => {});
    return { ok: false, reason: result.error || 'could not extract subtitles' };
  }

  try {
    await fsp.rename(partPath, outputPath);
  } catch (error) {
    return { ok: false, reason: String(error) };
  }
  return { ok: true, path: outputPath, cached: false };
}

/**
 * Stop work on a file we no longer need — the user skipped past it, or quit.
 * Cancels every variant of it, since the caller means "this episode", not
 * "this episode in Japanese".
 */
function cancel(absPath) {
  let cancelled = false;
  for (const [key, job] of [...jobs]) {
    if (job.absPath !== absPath) continue;
    job.cancel();
    jobs.delete(key);
    cancelled = true;
  }
  return cancelled;
}

function cancelAll() {
  for (const [, job] of jobs) job.cancel();
  jobs.clear();
}

function activeJobs() {
  return [...jobs.entries()].map(([absPath, job]) => ({
    absPath, tier: job.tier, startedAt: job.startedAt,
  }));
}

module.exports = {
  TIER,
  setCacheDir,
  findFfmpeg,
  ffmpegCandidates,
  rescanFfmpeg,
  hasFfmpeg,
  readVerdict,
  writeVerdict,
  inspect,
  listTracks,
  detectCrop,
  extractSubtitle,
  findFfprobe,
  partArgsFor,
  ensurePlayable,
  enforceBudget,
  clearCache,
  cacheEntries,
  pin,
  unpinAllExcept,
  cancel,
  cancelAll,
  activeJobs,
  DEFAULT_CACHE_BUDGET,
  MIN_FREE_BYTES,
};
