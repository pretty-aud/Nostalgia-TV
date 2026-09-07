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
  'upnext-settings',
  'upnext-fonts',
  'cewr-standby',
  'cewr-card',
  'cewr-signoff',
  'browse-rail',
  'rail-autoplay',
  'detail-media',
  'detail-movie',
  'library-transport',
  'browse-search',
  'art-picker',
  'art-picker-drag',
  'genre-table',
  'genre-pop',
  'genre-filter',
  'genre-filtered',
  'genre-checks',
  'key-library',
  'themes-new',
  'theme-menu',
  'theme-dropdowns',
  'schedule-greying',
  'vhs-font-spike',
  'vhs-transport',
  'vhs-face',
  'vhs-rail',
  'vhs-pair-white',
  'vhs-osd',
  'vhs-transport-zoom',
  'vhs-pair-green',
  'vhs-colours',
  'vhs-settings',
  'vhs-library',
  'vhs-sidebar',
  'vhs-glyph-audit',
  'vhs-marks',
  'vhs-transport-narrow',
];

/**
 * Shots that need a window that is NOT the 1280x880 default.
 *
 * Everything above runs at shoot-state's default size, which meant that for a
 * long time no probe had ever seen the app at a width where its layout
 * actually breaks — the transport labels wrapping out of their boxes were
 * reported by a person, at a size no probe was looking at.
 */
const SIZES = {
  'vhs-transport-narrow': ['980', '720'],
};

let failed = 0;
for (const name of SHOTS) {
  const size = SIZES[name] || [];
  const result = spawnSync(electron, [
    path.join(root, 'scripts', 'shoot-state.js'), '--',
    url,
    path.join(root, 'shots', `${name}.png`),
    path.join(root, 'scripts', 'shots', `${name}.js`),
    ...size,
  ], { cwd: root, encoding: 'utf8' });

  const ok = result.status === 0;
  if (!ok) failed += 1;
  const at = size.length ? ` @${size.join('x')}` : '';
  console.log(`${ok ? '✓' : '✗'} ${name}${at}${ok ? '' : ` (exit ${result.status}) ${(result.stderr || '').trim()}`}`);
}

process.exit(failed ? 1 : 0);
