/**
 * Install the freshly packaged build over the local one, then PROVE it took.
 *
 * Why this exists: `npm run dist` writes to dist/, but the desktop, Start Menu
 * and taskbar shortcuts all launch the INSTALLED copy under
 * %LOCALAPPDATA%\Programs. Those are two different applications that happen to
 * share a settings folder. Building without installing therefore leaves the
 * user running older code while the developer verifies the new code — and every
 * fix looks applied from one side and absent from the other.
 *
 * That is not a hypothetical: three separate "fixed" reports were made against
 * dist/ while the installed build silently stayed behind.
 *
 * The verification at the end is the point. A silent installer that fails is
 * exactly as bad as not running one.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const installer = join(root, 'dist', 'Nostalgia TV Setup.exe');
const builtAsar = join(root, 'dist', 'win-unpacked', 'resources', 'app.asar');
const installedAsar = join(
  process.env.LOCALAPPDATA || '',
  'Programs', 'nostalgia-tv', 'resources', 'app.asar',
);

const hash = (file) => (existsSync(file)
  ? createHash('sha1').update(readFileSync(file)).digest('hex').slice(0, 16)
  : null);

if (!existsSync(installer)) {
  console.error(`No installer at ${installer}. Run "npm run dist" first.`);
  process.exit(1);
}

const wanted = hash(builtAsar);
console.log(`built    ${wanted}`);
console.log(`installed ${hash(installedAsar) ?? '(not installed)'} — installing…`);

// /S is NSIS silent mode. The installer returns before it has finished writing,
// so the check below polls rather than assuming.
execFileSync(installer, ['/S'], { stdio: 'inherit' });

const deadline = Date.now() + 90000;
let got = null;
while (Date.now() < deadline) {
  got = hash(installedAsar);
  if (got === wanted) break;
  execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},1500)']); // ~1.5s pause
}

if (got !== wanted) {
  console.error(`\nInstall did NOT take. installed=${got} wanted=${wanted}`);
  console.error('The shortcuts still launch the old build. Do not report this as shipped.');
  process.exit(1);
}

console.log(`\ninstalled ${got} — matches the build. Shortcuts now launch this code.`);

/**
 * Remove the loose, double-clickable copies now that the real one is installed.
 *
 * dist/ leaves behind a Setup.exe, a portable .exe and win-unpacked/. All three
 * are launchable, none of them change when you deploy, and every one of them is
 * a chance to spend an evening watching a build from days ago and reporting
 * bugs that were already fixed. The installed copy under Programs is the only
 * one the shortcuts use, so it is the only one that should outlive a deploy.
 *
 * Never fatal: the install already succeeded, and failing here would report a
 * good deploy as a bad one.
 */
for (const stale of [
  join(root, 'dist', 'Nostalgia TV Setup.exe'),
  join(root, 'dist', 'Nostalgia TV (portable).exe'),
  join(root, 'dist', 'win-unpacked'),
]) {
  try {
    if (existsSync(stale)) {
      rmSync(stale, { recursive: true, force: true });
      console.log(`cleaned   ${stale.split(/[\\/]/).pop()}`);
    }
  } catch { /* tidying is not worth failing a good install over */ }
}
