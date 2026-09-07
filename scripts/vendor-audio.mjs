/**
 * Put the baked-in bumper audio where the build can ship it.
 *
 * Same shape as vendor-ffmpeg.mjs and vendor-mpv.mjs, and here for the same
 * two reasons those exist.
 *
 * ── Why vendor/ and not a tracked folder ─────────────────────────────────
 *
 * github.com/pretty-aud/Nostalgia-TV is PUBLIC. The box office cue is HBO's
 * music, and committing it would publish a copyrighted clip under her name.
 * vendor/ is gitignored precisely so third-party payload rides along in her
 * builds without living in the repo — which is already how ffmpeg and mpv get
 * here. Nothing about the app changes: there is no setting and no picker, the
 * sound is simply there, which is what "bake it in" asked for.
 *
 * ── Why not inside the asar ──────────────────────────────────────────────
 *
 * mpv is a SEPARATE PROCESS. It cannot read anything inside app.asar, because
 * an asar is an archive rather than a directory — a bundled asset would look
 * present in every check and fail to play with no error worth reading. So it
 * goes through extraResources to resources/audio, a real path on disk, found
 * at runtime the way findFfmpeg finds ffmpeg.
 *
 * Usage: node scripts/vendor-audio.mjs [--ensure] [source.mp3]
 *   --ensure  do nothing when the file is already there
 */

import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'vendor', 'audio');

/**
 * One entry per baked-in cue. `id` is what the app asks for; the filename is
 * deliberately plain, because the source is a YouTube rip whose name carries
 * a video id and a bitrate and tells a reader nothing.
 */
const CUES = [
  {
    id: 'box-office',
    file: 'box-office.mp3',
    source: 'C:/Users/Audrey/Desktop/bumper music/Home Box/'
      + 'YTDown.com_YouTube_HBO-Next-Bumper-2_Media_Jyf6fx1-7C0_006_128k.mp3',
    what: 'the HBO next-bumper cue, for "the box office"',
  },
];

const args = process.argv.slice(2);
const ensure = args.includes('--ensure');
const override = args.find((a) => !a.startsWith('--'));

mkdirSync(OUT_DIR, { recursive: true });

let missing = 0;
for (const cue of CUES) {
  const target = path.join(OUT_DIR, cue.file);
  if (ensure && existsSync(target)) {
    console.log(`have      ${cue.file}`);
    continue;
  }

  const source = override || cue.source;
  if (!existsSync(source)) {
    missing += 1;
    // Loud, and not fatal on its own: a fresh clone has no vendor/ at all, and
    // the app has to say why the style is silent rather than crash.
    console.error(`MISSING   ${cue.file} — no source at ${source}`);
    continue;
  }

  copyFileSync(source, target);
  console.log(`vendored  ${cue.file}  ${(statSync(target).size / 1024).toFixed(1)}kb  — ${cue.what}`);
}

process.exit(missing ? 1 : 0);
