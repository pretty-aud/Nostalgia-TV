/**
 * Put ffmpeg inside the app, so the installer is the whole stack.
 *
 * Without this the app hunts the target machine for ffmpeg and, finding none,
 * degrades: it plays what Chromium handles natively and labels the rest. That
 * is a good failure mode for a missing optional tool and a bad one for a setup
 * exe that is supposed to leave a working install behind.
 *
 * Nothing here is committed. The payload is ~180MB of binaries, which does not
 * belong in a git repo — GitHub refuses single files over 100MB outright — so
 * the build fetches it instead. `--ensure` is the build's entry point: it is a
 * no-op when a working copy is already vendored, and only reaches the network
 * when there is nothing to use.
 *
 *   node scripts/vendor-ffmpeg.mjs            fetch, replacing whatever is there
 *   node scripts/vendor-ffmpeg.mjs --ensure   fetch only if it is missing or broken
 *
 * Why THIS build:
 *  - shared, not static. The static build every winget install lands on is
 *    212MB for ffmpeg.exe and another 212MB for ffprobe.exe, because each one
 *    links every codec in on its own. Shared splits the codecs into DLLs the
 *    two share, for the same capability at roughly a third of the size.
 *  - GPL, not LGPL. The full-conversion tier encodes with libx264, and LGPL
 *    builds do not carry it. An LGPL build installs perfectly and then fails
 *    only on the files that needed converting, which is the worst possible
 *    place to find out.
 *  - the 9.0 release line rather than master, so the bundled copy matches the
 *    version this project has actually been exercised against.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dest = path.join(root, 'vendor', 'ffmpeg');

const ASSET = 'ffmpeg-n9.0-latest-win64-gpl-shared-9.0.zip';
const URL_ = `https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/${ASSET}`;
const WANTED = ['ffmpeg.exe', 'ffprobe.exe'];

const ensure = process.argv.includes('--ensure');

/**
 * Prove a binary by RUNNING it.
 *
 * The same rule the app itself uses to pick an ffmpeg: a file that exists can
 * still be a dead shim, a half-written download or the wrong architecture, and
 * every one of those looks identical to a good one until an episode needs it.
 */
function version(exe) {
  if (!fs.existsSync(exe)) return null;
  const result = spawnSync(exe, ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  if (result.error || result.status !== 0) return null;
  return (result.stdout || '').split('\n')[0].trim();
}

function vendored() {
  const found = WANTED.map((name) => [name, version(path.join(dest, name))]);
  return found.every(([, v]) => v) ? found : null;
}

function megabytes(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function directorySize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const at = path.join(dir, entry.name);
    total += entry.isDirectory() ? directorySize(at) : fs.statSync(at).size;
  }
  return total;
}

/**
 * Windows ships bsdtar as tar.exe, and it reads zip. Expand-Archive is the
 * fallback because it is markedly slower on a file this size, but it is there
 * on installs where tar is not.
 */
function unzip(archive, into) {
  fs.mkdirSync(into, { recursive: true });
  const tar = spawnSync('tar', ['-xf', archive, '-C', into], { encoding: 'utf8', windowsHide: true });
  if (!tar.error && tar.status === 0) return 'tar';

  const ps = spawnSync('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${into}' -Force`,
  ], { encoding: 'utf8', windowsHide: true });
  if (ps.error || ps.status !== 0) {
    throw new Error(`could not unzip: tar said "${(tar.stderr || tar.error || '').toString().trim()}", powershell said "${(ps.stderr || '').trim()}"`);
  }
  return 'Expand-Archive';
}

/** The bin/ folder inside whatever the archive's top-level folder turned out to be. */
function findBin(under) {
  const stack = [under];
  while (stack.length) {
    const at = stack.pop();
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = path.join(at, entry.name);
      if (entry.name === 'bin' && fs.existsSync(path.join(child, 'ffmpeg.exe'))) return child;
      stack.push(child);
    }
  }
  return null;
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('Not Windows — nothing to vendor. The app will look for ffmpeg on the system.');
    return;
  }

  const already = vendored();
  if (ensure && already) {
    console.log(`vendor/ffmpeg is already good — ${already[0][1]}`);
    return;
  }
  if (already) console.log('replacing the vendored copy…');

  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'ntv-ffmpeg-'));
  const archive = path.join(work, ASSET);

  try {
    console.log(`downloading ${ASSET}`);
    console.log(`  from ${URL_}`);
    const response = await fetch(URL_, { redirect: 'follow' });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    // A truncated download unzips to a plausible-looking tree with a missing
    // DLL at the end of it, so the size is checked before anything is unpacked.
    if (bytes.length < 40 * 1048576) throw new Error(`only ${megabytes(bytes.length)} arrived — that is not the archive`);
    await fsp.writeFile(archive, bytes);
    console.log(`  ${megabytes(bytes.length)}`);

    const how = unzip(archive, work);
    const bin = findBin(work);
    if (!bin) throw new Error(`unpacked with ${how} but found no bin/ffmpeg.exe inside`);

    await fsp.rm(dest, { recursive: true, force: true });
    await fsp.mkdir(dest, { recursive: true });

    // ffmpeg, ffprobe and the DLLs they share. ffplay is another 200MB of
    // window-and-audio-device code for a player this app never opens.
    let copied = 0;
    for (const entry of await fsp.readdir(bin)) {
      const isWanted = WANTED.includes(entry) || entry.toLowerCase().endsWith('.dll');
      if (!isWanted) continue;
      await fsp.copyFile(path.join(bin, entry), path.join(dest, entry));
      copied += 1;
    }

    // Ships beside the binaries: this is a GPL build, and the terms travelling
    // with the thing they cover is the whole point of them.
    for (const name of ['LICENSE.txt', 'LICENSE', 'COPYING.GPLv3']) {
      const at = path.join(path.dirname(bin), name);
      if (fs.existsSync(at)) { await fsp.copyFile(at, path.join(dest, name)); copied += 1; }
    }

    const proof = vendored();
    if (!proof) throw new Error('copied, but the binaries will not run — nothing has been vendored');

    console.log(`\nvendor/ffmpeg  ${copied} files, ${megabytes(directorySize(dest))}`);
    for (const [name, v] of proof) console.log(`  ${name.padEnd(12)} ${v}`);
  } finally {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(`\nffmpeg was NOT vendored: ${error.message}`);
  console.error('The installer would ship without it, so this is a build failure, not a warning.');
  process.exit(1);
});
