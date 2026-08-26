/**
 * Put the language you actually watch first, and drop the ones you never will.
 *
 * WHY THIS EXISTS
 * A <video> element plays the FIRST audio track in a file and cannot switch —
 * Chromium never shipped the API for it. Archival remuxes lead with the
 * original language, so an English speaker gets Japanese. The app can rebuild
 * such a file on the fly, but rebuilding means copying the video too, and in a
 * 58GB remux the audio is 0.6% of the bytes: half an hour of copying to change
 * a third of a gigabyte. Doing it ONCE, here, is the same work spent properly.
 *
 * The default-track flag does not help. That was tested: two files identical
 * but for which track carried the flag played the same audio. Chromium takes
 * what is physically first, so the track has to physically move.
 *
 * WHAT IT WILL NOT DO
 * It never writes over a source file and it never deletes one. Output goes to a
 * new file; --replace moves the original into an _originals folder, which is a
 * move you can undo, not a deletion you cannot. It refuses to start without
 * room on disk, and it verifies the result before it is willing to call a file
 * done.
 *
 * USAGE
 *   node scripts/fix-tracks.mjs "I:/TVandFilms/MOVIES"
 *     Dry run. Says what it would do to every file and what it would save.
 *
 *   node scripts/fix-tracks.mjs "I:/TVandFilms/MOVIES" --apply
 *     Actually does it, writing <name>.fixed.mkv beside each source.
 *
 *   --keep eng,jpn      languages to keep          (default eng,jpn,und)
 *   --prefer eng        language to put first      (default eng)
 *   --out <dir>         write everything here instead of beside the source
 *   --replace           after verifying, move the original to _originals/
 *   --limit N           stop after N files that need work
 *   --min-gb N          ignore files smaller than this
 *
 * Requires MKVToolNix:  winget install MoritzBunkus.MKVToolNix
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

// The app's own audio support table, not a second copy of it: a script that
// disagreed with the player about what is decodable would put an unplayable
// track first and look correct doing it.
import { codecSupport } from '../src/shared/playability.js';

/* ── arguments ──────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at !== -1 && argv[at + 1] ? argv[at + 1] : fallback;
};

const root = argv.find((a) => !a.startsWith('--')
  && argv[argv.indexOf(a) - 1] !== '--keep'
  && argv[argv.indexOf(a) - 1] !== '--prefer'
  && argv[argv.indexOf(a) - 1] !== '--out'
  && argv[argv.indexOf(a) - 1] !== '--limit'
  && argv[argv.indexOf(a) - 1] !== '--min-gb');

const APPLY = flag('apply');
const REPLACE = flag('replace');
const KEEP = value('keep', 'eng,jpn,und').split(',').map((s) => s.trim().toLowerCase());
const PREFER = value('prefer', 'eng').toLowerCase();
const OUT_DIR = value('out', null);
const LIMIT = Number(value('limit', '0')) || Infinity;
const MIN_BYTES = Number(value('min-gb', '0')) * 1073741824;
// Rebuilding purely to shed unwanted tracks has to be asked for — see plan().
const SLIM = flag('slim');

if (!root) {
  console.error('Give it a folder. See the comment at the top of this file for options.');
  process.exit(1);
}

/* ── mkvmerge ───────────────────────────────────────────────────────────── */

/**
 * Located rather than assumed on the PATH: winget installs MKVToolNix into
 * Program Files and does not always add it, and "command not found" for a tool
 * that IS installed is a confusing way to fail.
 */
function findMkvmerge() {
  const candidates = [
    'mkvmerge',
    'C:\\Program Files\\MKVToolNix\\mkvmerge.exe',
    'C:\\Program Files (x86)\\MKVToolNix\\mkvmerge.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'MKVToolNix', 'mkvmerge.exe'),
  ];
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8', windowsHide: true });
    if (!result.error && result.status === 0) return candidate;
  }
  return null;
}

const MKVMERGE = findMkvmerge();
if (!MKVMERGE) {
  console.error('MKVToolNix is not installed. Get it with:\n');
  console.error('  winget install MoritzBunkus.MKVToolNix\n');
  process.exit(1);
}

/**
 * mkvmerge has its OWN track ids, and they are not ffmpeg stream indices.
 * Identifying with the same tool that will do the muxing is the only way the
 * ids in --track-order are guaranteed to mean what we think they mean.
 */
function identify(file) {
  const result = spawnSync(MKVMERGE, ['-J', file], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true,
  });
  if (result.status !== 0 && result.status !== 1) return null;
  try { return JSON.parse(result.stdout); } catch { return null; }
}

/* ── deciding what to do with one file ──────────────────────────────────── */

const TEXT_SUBS = /^S_TEXT/;                 // SRT, ASS, SSA: usable as WebVTT
const isText = (track) => TEXT_SUBS.test(track.properties.codec_id || '');
const langOf = (track) => String(track.properties.language || 'und').toLowerCase();
const nameOf = (track) => track.properties.track_name || '';

/** Commentary is kept if its language is kept, but never allowed to lead. */
const isCommentary = (track) => /commentary/i.test(nameOf(track));

function plan(info) {
  const tracks = info.tracks || [];
  const video = tracks.filter((t) => t.type === 'video');
  const audio = tracks.filter((t) => t.type === 'audio');
  const subs = tracks.filter((t) => t.type === 'subtitles');

  const keepAudio = audio.filter((t) => KEEP.includes(langOf(t)));
  const keepSubs = subs.filter((t) => KEEP.includes(langOf(t)));

  /**
   * Ordering, best first. The track that ends up leading is the one that plays.
   *
   * Language first, then PLAYABILITY, then surround over stereo.
   *
   * The middle term is not a nicety. Ghost in the Shell carries English as FLAC
   * 2.0, TrueHD 7.1 and AC3 5.1, and Chromium decodes none of the last two — so
   * "prefer the most channels" on its own promotes a track with no sound at
   * all, which is a worse outcome than stereo by some distance. Judged with the
   * app's own support table rather than a second copy of it, so the two cannot
   * come to different conclusions about the same file.
   */
  const playable = (t) => codecSupport(t.properties.codec_id || '', 'audio') !== 'no';

  const rankAudio = (t) => (
    (langOf(t) === PREFER ? 0 : 1000)
    + (playable(t) ? 0 : 100)
    + (isCommentary(t) ? 20 : 0)
    // Surround beats stereo, but only ever as a tie-break between tracks that
    // are equal on everything above.
    - Math.min(8, Number(t.properties.audio_channels) || 0)
  );

  /**
   * Subtitles: language, then text over bitmaps. A bitmap subtitle cannot be
   * turned into WebVTT — it is a picture — so leading with one means offering a
   * track that can never be displayed.
   */
  const rankSub = (t) => (
    (langOf(t) === PREFER ? 0 : 1000)
    + (isText(t) ? 0 : 100)
  );

  const audioOrder = [...keepAudio].sort((a, b) => rankAudio(a) - rankAudio(b) || a.id - b.id);
  const subOrder = [...keepSubs].sort((a, b) => rankSub(a) - rankSub(b) || a.id - b.id);

  const dropped = tracks.filter((t) => (
    (t.type === 'audio' && !keepAudio.includes(t))
    || (t.type === 'subtitles' && !keepSubs.includes(t))
  ));

  // Nothing to gain: the right track already leads and nothing would go.
  const leads = audioOrder[0];
  const alreadyFirst = leads && audio[0] && leads.id === audio[0].id
    && (langOf(leads) === PREFER || !audio.some((t) => langOf(t) === PREFER));
  const subsAlreadyFine = !subOrder.length
    || (subs.length && subOrder[0].id === subs[0].id);

  /**
   * Two different reasons to touch a file, and only one of them is worth 44GB.
   *
   * REORDERING is the point: the wrong language plays, and rebuilding is the
   * only cure. SLIMMING is a bonus — free when you are rebuilding anyway, and a
   * terrible trade on its own. Annihilation already leads with English and
   * carries about a gigabyte of subtitles nobody reads; rewriting 44GB to
   * reclaim one is not a favour. So slimming alone needs asking for.
   */
  const needsReorder = !(alreadyFirst && subsAlreadyFine);

  return {
    video,
    audioOrder,
    subOrder,
    dropped,
    leads,
    needsReorder,
    couldSlim: dropped.length > 0,
    needsWork: needsReorder || (SLIM && dropped.length > 0),
    hasPreferred: audio.some((t) => langOf(t) === PREFER),
  };
}

/** Roughly how many bytes the dropped tracks account for. */
function droppedBytes(dropped, durationSeconds) {
  let total = 0;
  for (const track of dropped) {
    const bps = Number(
      (track.properties.tag_bps)
      || (track.properties.bps)
      || 0,
    );
    if (bps && durationSeconds) total += (bps * durationSeconds) / 8;
  }
  return total;
}

/* ── doing it ───────────────────────────────────────────────────────────── */

function buildArgs(file, out, decided) {
  const ids = (list) => list.map((t) => t.id).join(',');
  const args = ['--output', out];

  // Empty means "keep none", which is what we want when every track of a kind
  // was dropped — the flag has to be omitted entirely for "keep all", so an
  // empty list is expressed as the explicit no-tracks switch instead.
  if (decided.audioOrder.length) args.push('--audio-tracks', ids(decided.audioOrder));
  else args.push('--no-audio');

  if (decided.subOrder.length) args.push('--subtitle-tracks', ids(decided.subOrder));
  else args.push('--no-subtitles');

  // The flag Chromium ignores, set anyway: other players do respect it, and
  // leaving a dropped track marked default is untidy in every one of them.
  for (const list of [decided.audioOrder, decided.subOrder]) {
    list.forEach((t, index) => args.push('--default-track-flag', `${t.id}:${index === 0 ? 1 : 0}`));
  }

  args.push(file);

  // 0: is the file id — there is only one input, so it is always zero.
  const order = [...decided.video, ...decided.audioOrder, ...decided.subOrder]
    .map((t) => `0:${t.id}`)
    .join(',');
  args.push('--track-order', order);

  return args;
}

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(MKVMERGE, args, { windowsHide: true });
    let last = '';
    child.stdout.on('data', (chunk) => {
      const text = String(chunk);
      const match = /Progress:\s*(\d+)%/.exec(text);
      if (match && match[1] !== last) {
        last = match[1];
        process.stdout.write(`\r      ${match[1].padStart(3)}%   `);
      }
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    // 1 is mkvmerge's "finished with warnings", which is normal and not failure.
    child.on('close', (code) => resolve({ ok: code === 0 || code === 1, code, stderr }));
  });
}

/**
 * Confirm the new file is actually better before anyone relies on it.
 *
 * Checked against the OUTPUT rather than assumed from the exit code: a mux that
 * reports success and puts the wrong track first is exactly the failure this
 * whole script exists to fix, and it would be invisible until playback.
 */
function verify(out, sourceInfo) {
  const info = identify(out);
  if (!info) return 'the result could not be read back';

  const audio = (info.tracks || []).filter((t) => t.type === 'audio');
  if (!audio.length) return 'the result has no audio at all';

  const first = String(audio[0].properties.language || 'und').toLowerCase();
  const wanted = (sourceInfo.tracks || []).some((t) => t.type === 'audio'
    && String(t.properties.language || '').toLowerCase() === PREFER);
  if (wanted && first !== PREFER) return `the first audio track is ${first}, not ${PREFER}`;

  const a = Number(info.container?.properties?.duration || 0);
  const b = Number(sourceInfo.container?.properties?.duration || 0);
  if (a && b && Math.abs(a - b) / b > 0.02) return 'the running time changed';

  return null;
}

/**
 * Why an existing output cannot be kept, or null if it can.
 *
 * Three ways a file that is sitting there can still be wrong, and only the
 * first is obvious:
 *
 *  - Truncated. Cut off by a crash, a full disk, or a drive dropping out. The
 *    file opens, plays, and simply stops early — the failure is invisible until
 *    somebody reaches the end.
 *  - Unreadable. Written far enough to exist and not far enough to parse.
 *  - Built to an older plan. Correct when it was made, not what is wanted now.
 *    Compared on language, codec AND channels, because "English first" is
 *    satisfied by both the 2.0 and the 5.1 track and they are not the same
 *    answer.
 */
function staleOutput(outPath, sourceInfo, decided) {
  const info = identify(outPath);
  if (!info) return 'unreadable';

  const sourceMs = Number(sourceInfo.container?.properties?.duration || 0);
  const outMs = Number(info.container?.properties?.duration || 0);
  if (sourceMs && (!outMs || Math.abs(outMs - sourceMs) / sourceMs > 0.02)) {
    return outMs
      ? `incomplete (${(outMs / 6e10).toFixed(0)} min of ${(sourceMs / 6e10).toFixed(0)})`
      : 'incomplete';
  }

  const want = decided.audioOrder[0];
  const got = (info.tracks || []).find((t) => t.type === 'audio');
  if (want && !got) return 'missing its audio';
  if (want && got) {
    const same = (a, b) => (
      String(a.properties.language || '') === String(b.properties.language || '')
      && String(a.properties.codec_id || '') === String(b.properties.codec_id || '')
      && Number(a.properties.audio_channels || 0) === Number(b.properties.audio_channels || 0)
    );
    if (!same(want, got)) {
      return `built to an older plan (leads with ${got.properties.audio_channels || '?'}ch`
        + ` ${String(got.properties.language || 'und')}, should be`
        + ` ${want.properties.audio_channels || '?'}ch ${String(want.properties.language || 'und')})`;
    }
  }

  return null;
}

/* ── walking the library ────────────────────────────────────────────────── */

function findMkvs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === '_originals') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findMkvs(full));
    else if (/\.mkv$/i.test(entry.name) && !/\.fixed\.mkv$/i.test(entry.name)) out.push(full);
  }
  return out;
}

const gb = (n) => `${(n / 1073741824).toFixed(2)} GB`;

async function main() {
  const files = findMkvs(root).filter((f) => fs.statSync(f).size >= MIN_BYTES);

  console.log(`${APPLY ? 'Fixing' : 'DRY RUN — nothing will be written'}`);
  console.log(`  folder   ${root}`);
  console.log(`  keeping  ${KEEP.join(', ')}   first: ${PREFER}`);
  console.log(`  files    ${files.length} .mkv\n`);

  let touched = 0;
  let wouldSave = 0;
  let skipped = 0;
  let slimOnly = 0;
  const byFolder = new Map();

  for (const file of files) {
    if (touched >= LIMIT) break;

    const info = identify(file);
    if (!info) { console.log(`  ?? ${path.basename(file)} — could not identify`); continue; }

    const decided = plan(info);
    const size = fs.statSync(file).size;
    const duration = Number(info.container?.properties?.duration || 0) / 1e9;

    if (!decided.needsWork) {
      skipped += 1;
      if (decided.couldSlim) slimOnly += 1;
      continue;
    }

    /**
     * Already done? Then leave it alone.
     *
     * Written after a three-hour run was cut off by the drive dropping out
     * mid-file. Without this, resuming means recopying every file that already
     * finished — hours of work to produce files that already exist — and the
     * one genuinely broken output, a 35GB torso of a 46GB film, looks exactly
     * like the good ones from the outside.
     *
     * "Done" is judged against what the CURRENT plan wants, not merely against
     * "an output exists". A file rebuilt under an older ranking is finished by
     * its own lights and wrong by today's, and skipping it because a file is
     * present would quietly keep the old answer forever.
     */
    const outPath = path.join(OUT_DIR || path.dirname(file), `${path.basename(file, '.mkv')}.fixed.mkv`);
    if (fs.existsSync(outPath)) {
      const stale = staleOutput(outPath, info, decided);
      if (!stale) {
        skipped += 1;
        console.log(`  ${path.relative(root, file).split(path.sep).join('/').slice(0, 74)}`);
        console.log('      already rebuilt and correct — left alone\n');
        continue;
      }
      console.log(`  ${path.relative(root, file).split(path.sep).join('/').slice(0, 74)}`);
      console.log(`      existing output is ${stale} — rebuilding`);
      if (APPLY) await fsp.unlink(outPath).catch(() => {});
    }

    const saving = droppedBytes(decided.dropped, duration);
    wouldSave += saving;
    touched += 1;

    // Tallied per folder because "139 files need work" does not tell you
    // whether that is one series or twenty, and the answer changes what you do.
    const folder = path.relative(root, path.dirname(file)) || '.';
    const tally = byFolder.get(folder) || { n: 0, bytes: 0, saving: 0 };
    tally.n += 1;
    tally.bytes += size;
    tally.saving += saving;
    byFolder.set(folder, tally);

    const lead = decided.leads
      ? `${String(decided.leads.properties.language || 'und')}${nameOf(decided.leads) ? ` · ${nameOf(decided.leads).slice(0, 40)}` : ''}`
      : 'none';

    // Relative path, not just the filename: across a whole library the episode
    // names alone give no hint which show they belong to.
    console.log(`  ${path.relative(root, file).split(path.sep).join('/').slice(0, 74)}`);
    console.log(`      ${gb(size)}  ·  ${decided.needsReorder ? `first audio becomes ${lead}` : 'order already correct — slimming only'}`);
    console.log(`      dropping ${decided.dropped.length} track${decided.dropped.length === 1 ? '' : 's'}`
      + (saving ? `, about ${gb(saving)}` : ''));
    if (!decided.hasPreferred) {
      console.log(`      NOTE: no ${PREFER} audio in this file — order unchanged, tracks still dropped`);
    }

    if (!APPLY) { console.log(''); continue; }

    const outDir = OUT_DIR || path.dirname(file);
    await fsp.mkdir(outDir, { recursive: true });
    const out = path.join(outDir, `${path.basename(file, '.mkv')}.fixed.mkv`);

    // Room for the whole thing, since both files exist at once. Running a disk
    // to zero mid-remux is a much worse outcome than declining to start.
    const free = (() => {
      try { const s = fs.statfsSync(outDir); return s.bavail * s.bsize; } catch { return Infinity; }
    })();
    if (free < size * 1.05) {
      console.log(`      SKIPPED — needs ${gb(size)} free, has ${gb(free)}\n`);
      continue;
    }

    const result = await run(buildArgs(file, out, decided));
    process.stdout.write('\r');

    if (!result.ok) {
      console.log(`      FAILED (${result.code}) ${result.stderr.trim().split('\n')[0] || ''}\n`);
      await fsp.unlink(out).catch(() => {});
      continue;
    }

    const problem = verify(out, info);
    if (problem) {
      console.log(`      NOT ACCEPTED — ${problem}. Left as ${path.basename(out)} for you to look at.\n`);
      continue;
    }

    const after = fs.statSync(out).size;
    console.log(`      done — ${gb(size)} to ${gb(after)}`);

    if (REPLACE) {
      // Moved, never deleted. Undoing a move is dragging a file back; undoing a
      // delete is re-downloading 58GB.
      const keepDir = path.join(path.dirname(file), '_originals');
      await fsp.mkdir(keepDir, { recursive: true });
      await fsp.rename(file, path.join(keepDir, path.basename(file)));
      await fsp.rename(out, file);
      console.log(`      original moved to _originals/`);
    }
    console.log('');
  }

  if (byFolder.size > 1) {
    console.log('\n  by folder');
    const rows = [...byFolder].sort((a, b) => b[1].bytes - a[1].bytes);
    for (const [folder, tally] of rows) {
      console.log(`    ${String(tally.n).padStart(4)} files  ${gb(tally.bytes).padStart(10)} to rebuild`
        + (tally.saving ? `, ${gb(tally.saving)} droppable` : '')
        + `   ${folder}`);
    }
  }

  console.log(`\n  ${touched} file${touched === 1 ? '' : 's'} need work, ${skipped} already fine`);
  if (wouldSave) console.log(`  about ${gb(wouldSave)} of unwanted tracks`);
  if (!APPLY && touched) console.log('\n  Add --apply to do it. Add --replace to swap the originals out afterwards.');
}

main().catch((error) => {
  console.error(`\n${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
