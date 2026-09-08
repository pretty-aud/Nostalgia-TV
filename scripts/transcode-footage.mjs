/**
 * Make a folder of footage playable.
 *
 * Chromium decodes H.264, VP8, VP9 and AV1 and nothing else. Stock footage
 * arrives in whatever the shoot delivered — her Adobe folder holds four ProRes,
 * one MJPEG and one MPEG-4 among fifteen files, none of which will render in a
 * <video> element at all. This converts those and leaves the rest alone.
 *
 * THE ORIGINALS ARE NOT TOUCHED. Not moved, not renamed, not deleted. A
 * converted copy is written beside each one and that is all — this project has
 * destroyed her hand-placed artwork once already with a "rebuild" that cleared
 * before it wrote, and a script that reaches into a folder on her external
 * drive is exactly where that lesson applies.
 *
 * Usage:  node scripts/transcode-footage.mjs "E:/Stock Footage/Some Folder"
 *         node scripts/transcode-footage.mjs "<folder>" --dry-run
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const FFMPEG = path.join('vendor', 'ffmpeg', 'ffmpeg.exe');
const FFPROBE = path.join('vendor', 'ffmpeg', 'ffprobe.exe');

/** What a browser can actually decode. Everything else needs converting. */
const PLAYABLE = new Set(['h264', 'vp8', 'vp9', 'av1']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi']);

/**
 * 1920 wide, not 4096.
 *
 * These are backdrops behind small text on a 1080p card; a 4K intermediate
 * costs decode time and disk for detail the card cannot show. The originals
 * keep their full resolution, so nothing is lost — this is a working copy at
 * the size the work needs.
 */
const MAX_WIDTH = 1920;
const CRF = '20';

const dir = process.argv[2];
const dryRun = process.argv.includes('--dry-run');
if (!dir) {
  console.error('Usage: node scripts/transcode-footage.mjs "<folder>" [--dry-run]');
  process.exit(2);
}

const run = (bin, args) => new Promise((resolve) => {
  const child = spawn(bin, args);
  let err = '';
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.on('error', (e) => resolve({ code: -1, out, err: e.message }));
  child.on('close', (code) => resolve({ code, out, err }));
});

const probe = async (file) => {
  const { out } = await run(FFPROBE, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,width,height',
    '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', file,
  ]);
  const parts = out.trim().split(/\r?\n/);
  return { codec: parts[0] || '', width: Number(parts[1]) || 0, duration: Number(parts[parts.length - 1]) || 0 };
};

const files = fs.readdirSync(dir)
  .filter((n) => VIDEO_EXT.has(path.extname(n).toLowerCase()))
  .sort();

console.log(`${files.length} video files in ${dir}\n`);

const work = [];
for (const name of files) {
  const abs = path.join(dir, name);
  const { codec, width, duration } = await probe(abs);
  if (PLAYABLE.has(codec)) {
    console.log(`  keep     ${name.padEnd(32)} ${codec} — already playable`);
    continue;
  }
  const out = path.join(dir, `${path.basename(name, path.extname(name))}.mp4`);
  if (fs.existsSync(out)) {
    console.log(`  done     ${name.padEnd(32)} ${codec} — ${path.basename(out)} exists`);
    continue;
  }
  work.push({ abs, out, name, codec, width, duration });
  console.log(`  CONVERT  ${name.padEnd(32)} ${codec} ${width}px ${duration.toFixed(1)}s`);
}

if (!work.length) { console.log('\nNothing to convert.'); process.exit(0); }
if (dryRun) { console.log(`\n--dry-run: would convert ${work.length}.`); process.exit(0); }

console.log(`\nConverting ${work.length}. Originals are left exactly where they are.\n`);

let ok = 0;
for (const job of work) {
  /**
   * Written aside and renamed only on success. An ffmpeg killed halfway leaves
   * a file that looks complete to every later check — including this script's
   * own "exists" test above, which would then skip it forever.
   */
  const partial = `${job.out.slice(0, -4)}.part.mp4`;
  const started = Date.now();
  const scale = job.width > MAX_WIDTH ? [`scale=${MAX_WIDTH}:-2:flags=bicubic`] : [];

  const { code, err } = await run(FFMPEG, [
    '-y', '-i', job.abs,
    '-map', '0:v:0', '-an', '-sn', '-dn', '-map_chapters', '-1',
    ...(scale.length ? ['-vf', scale.join(',')] : []),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', CRF,
    '-pix_fmt', 'yuv420p',          // 10-bit ProRes would otherwise stay unplayable
    '-movflags', '+faststart',
    partial,
  ]);

  if (code !== 0 || !fs.existsSync(partial)) {
    console.log(`  FAILED   ${job.name} — ${String(err).trim().split('\n').pop()}`);
    try { fs.unlinkSync(partial); } catch { /* nothing to clean */ }
    continue;
  }

  // Verify BEFORE renaming: a file ffmpeg wrote is not the same as a file that
  // plays. If the copy is not H.264 there is no point keeping it.
  const check = await probe(partial);
  if (!PLAYABLE.has(check.codec)) {
    console.log(`  FAILED   ${job.name} — came out as ${check.codec}, not keeping it`);
    try { fs.unlinkSync(partial); } catch { /* nothing to clean */ }
    continue;
  }

  fs.renameSync(partial, job.out);
  const mb = (fs.statSync(job.out).size / 1e6).toFixed(0);
  console.log(`  ok       ${path.basename(job.out).padEnd(32)} ${check.codec} ${check.width}px `
    + `${mb}MB  ${((Date.now() - started) / 1000).toFixed(0)}s`);
  ok += 1;
}

console.log(`\n${ok}/${work.length} converted. Every original is untouched.`);
