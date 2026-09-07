/**
 * Does the INSTALLED app carry the snap fix?
 *
 * A green build says the build succeeded. It does not say the shortcut on her
 * desktop runs that code — this project has shipped a build that was never
 * installed, and the only answer that counts comes out of the asar the
 * shortcut actually loads.
 *
 * Usage: node scripts/check-shipped-snap.mjs
 * Diagnostic tooling only. Not part of the build.
 */

import { extractFile } from '@electron/asar';
import path from 'node:path';

const asar = path.join(
  process.env.LOCALAPPDATA,
  'Programs', 'nostalgia-tv', 'resources', 'app.asar',
);

// path.join, not a forward-slash literal: extractFile looks entries up with
// path.sep, and a nested forward-slash path reports 'not found in this
// archive' — the same message a genuinely missing file gives. This file only
// reads one-level paths, which happen to resolve either way, so it passed and
// gave no hint the form was wrong until check-shipped-upnext.mjs hit it.
const planeManager = extractFile(asar, path.join('electron', 'planeManager.js')).toString();
const main = extractFile(asar, path.join('electron', 'main.js')).toString();

const checks = [
  ['the overlay is maximizable — the WS_MAXIMIZEBOX Windows snaps on',
    /maximizable: true/.test(planeManager)],
  ['the follow is deferred a tick, so a maximise cannot eat the restore rect',
    /pending = setTimeout\(followOverlay, 0\)/.test(planeManager)],
  ['the maximise glue carries the video plane with the overlay',
    /overlay\.on\('maximize'/.test(planeManager) && /overlay\.on\('unmaximize'/.test(planeManager)],
  ['the size comparison allows the pixel the planes disagree by',
    /const NEAR = 2;/.test(planeManager)],
  /**
   * Anchored to the start of a line, because main.js now EXPLAINS in a
   * comment why titleBarStyle was tried and reverted. A bare substring search
   * matched that prose and reported the fix missing from a build that had it
   * — a probe failing on its own text.
   */
  ['the video plane is frameless again — titleBarStyle did nothing and is gone',
    /^\s*frame: false,/m.test(main) && !/^\s*titleBarStyle:/m.test(main)],
];

let failed = 0;
for (const [what, ok] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
}
console.log(failed ? `${failed} SHIPPED CHECK(S) FAILED` : 'the installed app carries the snap fix');
process.exit(failed ? 1 : 0);
