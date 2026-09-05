/**
 * Put mpv inside the app, the same way ffmpeg is put inside the app.
 *
 * The mpv-player branch replaces the Chromium <video> element with mpv, which
 * is what removes the conversion pipeline: mpv decodes everything the library
 * holds, switches audio tracks instantly, and renders image subtitles. None of
 * that works if the binary is not there, so — like ffmpeg — the build vendors
 * a copy and the installer ships the whole stack.
 *
 * Nothing here is committed (vendor/ is gitignored; binaries do not belong in
 * git). `--ensure` is the build's entry point: a no-op when a working copy is
 * already vendored.
 *
 *   node scripts/vendor-mpv.mjs            fetch, replacing whatever is there
 *   node scripts/vendor-mpv.mjs --ensure   fetch only if missing or broken
 *
 * Why THIS build:
 *  - shinchiro/mpv-winbuild-cmake is the Windows build mpv.io itself points
 *    at — the closest thing Windows has to an official mpv release.
 *  - plain x86_64, NOT the -v3 variant: v3 requires AVX2 and buys a few
 *    percent; a build that hard-crashes on an older machine is not worth it.
 *  - the player archive, NOT mpv-dev: we embed the PLAYER via --wid and drive
 *    it over IPC. mpv-dev is libmpv for native embedding, a different road.
 *
 * The asset name carries a date and commit hash, so unlike ffmpeg's fixed
 * "latest" filename this script asks the release API which file to fetch and
 * pins the PATTERN instead: mpv-x86_64-<date>-git-<hash>.7z, exactly.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dest = path.join(root, 'vendor', 'mpv');

const RELEASE_API = 'https://api.github.com/repos/shinchiro/mpv-winbuild-cmake/releases/latest';
const ASSET_PATTERN = /^mpv-x86_64-\d{8}-git-[0-9a-f]+\.7z$/;

const ensure = process.argv.includes('--ensure');

/**
 * Prove the binary by RUNNING it — the same rule the whole project uses.
 * A file that exists can still be half-downloaded or the wrong architecture,
 * and both look identical to a good copy until an episode needs it.
 */
function version(exe) {
  if (!fs.existsSync(exe)) return null;
  const result = spawnSync(exe, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  if (result.error || result.status !== 0) return null;
  return (result.stdout || '').split('\n')[0].trim();
}

function vendored() {
  return version(path.join(dest, 'mpv.exe'));
}

function megabytes(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/**
 * The 7z archive needs libarchive's bsdtar — which Windows ships in System32.
 * A Git Bash or MSYS environment puts GNU tar first on the PATH, and GNU tar
 * cannot read 7z at all, so the SYSTEM copy is named explicitly rather than
 * trusting whatever "tar" resolves to.
 */
function extract(archive, into) {
  fs.mkdirSync(into, { recursive: true });
  const bsdtar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  const result = spawnSync(bsdtar, ['-xf', archive, '-C', into], { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new Error(`could not extract ${path.basename(archive)}: ${(result.stderr || result.error || '').toString().trim()}`);
  }
}

/** Wherever mpv.exe landed in the extracted tree. */
function findMpv(under) {
  const stack = [under];
  while (stack.length) {
    const at = stack.pop();
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const child = path.join(at, entry.name);
      if (entry.isDirectory()) stack.push(child);
      else if (entry.name.toLowerCase() === 'mpv.exe') return at;
    }
  }
  return null;
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('Not Windows — nothing to vendor.');
    return;
  }

  const already = vendored();
  if (ensure && already) {
    console.log(`mpv already vendored and runnable: ${already}`);
    return;
  }

  console.log('Asking the release API which build is current…');
  const release = await (await fetch(RELEASE_API, {
    headers: { 'user-agent': 'nostalgia-tv-vendor-script' },
  })).json();
  const asset = (release.assets || []).find((a) => ASSET_PATTERN.test(a.name));
  if (!asset) {
    throw new Error(`no asset matching ${ASSET_PATTERN} in release ${release.tag_name}`);
  }

  console.log(`Fetching ${asset.name} (${megabytes(asset.size)}) from release ${release.tag_name}…`);
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'ntv-mpv-'));
  const archive = path.join(work, asset.name);
  const body = await fetch(asset.browser_download_url);
  if (!body.ok) throw new Error(`download failed: HTTP ${body.status}`);
  await fsp.writeFile(archive, Buffer.from(await body.arrayBuffer()));

  const got = fs.statSync(archive).size;
  if (got !== asset.size) {
    throw new Error(`short download: got ${got} bytes, the release says ${asset.size}`);
  }

  console.log('Extracting…');
  const extracted = path.join(work, 'extracted');
  extract(archive, extracted);
  const binDir = findMpv(extracted);
  if (!binDir) throw new Error('archive held no mpv.exe');

  // Everything that sits beside mpv.exe comes along (any DLLs, the licence);
  // docs and the updater script it ships do not.
  await fsp.rm(dest, { recursive: true, force: true });
  await fsp.mkdir(dest, { recursive: true });
  for (const entry of fs.readdirSync(binDir, { withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    if (/\.(ps1|bat)$/i.test(entry.name)) continue;
    await fsp.copyFile(path.join(binDir, entry.name), path.join(dest, entry.name));
  }

  const proof = vendored();
  if (!proof) throw new Error('vendored mpv.exe does not run — not keeping it');

  // The provenance stamp: which release this copy came from, so "which mpv is
  // she actually running" is a file read rather than an investigation.
  await fsp.writeFile(path.join(dest, 'VENDORED.txt'),
    `${asset.name}\nfrom ${RELEASE_API}\nrelease ${release.tag_name}\n${proof}\n`);

  await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  console.log(`Vendored: ${proof}`);
  console.log(`Into: ${dest}`);
}

main().catch((error) => {
  console.error(String(error && error.message ? error.message : error));
  process.exitCode = 1;
});
