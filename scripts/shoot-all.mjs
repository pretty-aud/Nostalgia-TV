/**
 * Take the review shots in one go.
 *
 * Spawned with an argv array rather than a shell line: MSYS rewrites a bare
 * http:// argument on the way through Git Bash, and Chromium claims it as a URL
 * of its own unless it comes after `--`.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const url = process.env.PREVIEW_URL || 'http://localhost:4173';

const SHOTS = [
  'footer-movies-on',
  'footer-movies-off',
  'transport-volume-full',
  'transport-volume-mid',
  'transport-volume-muted',
  'sidebar-footer',
  'browse-rail',
  'browse-search',
  'art-picker',
  'art-picker-drag',
  'genre-table',
  'genre-pop',
  'genre-filter',
  'genre-filtered',
];

let failed = 0;
for (const name of SHOTS) {
  const result = spawnSync(electron, [
    path.join(root, 'scripts', 'shoot-state.js'), '--',
    url,
    path.join(root, 'shots', `${name}.png`),
    path.join(root, 'scripts', 'shots', `${name}.js`),
  ], { cwd: root, encoding: 'utf8' });

  const ok = result.status === 0;
  if (!ok) failed += 1;
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` (exit ${result.status}) ${(result.stderr || '').trim()}`}`);
}

process.exit(failed ? 1 : 0);
