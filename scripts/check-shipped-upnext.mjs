/**
 * Does the INSTALLED app carry the up-next work?
 *
 * A green build says the build succeeded. It does not say the shortcut on her
 * desktop runs that code — this project has shipped a build that was never
 * installed — and it says nothing at all about the FILES a feature needs.
 * That second part is the one that bites here: the card is two fonts, an SVG
 * mark and a music analyser, and electron-builder packages only what
 * package.json's build.files lists. A face left out of the asar does not throw;
 * the card just comes out in the wrong type.
 *
 * Usage: node scripts/check-shipped-upnext.mjs
 * Diagnostic tooling only. Not part of the build.
 */

import { extractFile, listPackage } from '@electron/asar';
import path from 'node:path';

const asar = path.join(
  process.env.LOCALAPPDATA,
  'Programs', 'nostalgia-tv', 'resources', 'app.asar',
);

/**
 * PLATFORM SEPARATORS, not forward slashes.
 *
 * extractFile looks entries up with path.sep, so on Windows a nested path
 * written with forward slashes reports "was not found in this archive" — the
 * same message a genuinely missing file gives. Six checks in the first run of
 * this script failed that way against a build that contained every one of
 * them, which is the worst kind of wrong answer: it looks like the deploy
 * dropped the feature.
 *
 * It hides, too. "electron/bumperMusic.js" resolves fine with one separator,
 * so a script that only ever reads top-level-ish paths — as
 * check-shipped-snap.mjs does — passes and gives no hint the form is wrong.
 */
const read = (...parts) => {
  try {
    return extractFile(asar, path.join(...parts)).toString();
  } catch {
    return null;
  }
};

const files = listPackage(asar).map((f) => f.replace(/\\/g, '/'));
const has = (needle) => files.some((f) => f.endsWith(needle));

const bundle = read('src', 'renderer', 'bundle.js');
const css = read('src', 'renderer', 'styles.css');
const styles = read('src', 'shared', 'bumperStyles.js');
const music = read('electron', 'bumperMusic.js');

const checks = [
  ['the style registry ships, with the schedule card in it',
    Boolean(styles) && /id: 'cewr'/.test(styles)],
  ['the music analyser ships',
    Boolean(music) && /ebur128/.test(music) && /MAX_ONSET_BONUS/.test(music)],

  /**
   * The renderer is BUNDLED, so shared modules are inlined rather than
   * present as files. Checking for src/shared/nostalgiaMark.js in the asar
   * would pass while the bundle was stale — what matters is that the drawing
   * is in the code that actually runs.
   */
  ['the vector mark is in the bundle the renderer runs',
    Boolean(bundle) && /markSvg/.test(bundle) && /EAR_KNOB|0.044/.test(bundle)],
  ['the card driver is in that bundle too',
    Boolean(bundle) && /showAdultSwimBumper/.test(bundle) && /asbumpStandby/.test(bundle)],

  /**
   * The two faces, by FILE. This is the check with teeth: build.files decides
   * what reaches the asar, and a missing woff2 is silent — Chromium falls back
   * and the card is simply set in the wrong type.
   */
  ['the condensed face ships as a real file',
    has('fonts/roboto-condensed.woff2')],
  ['the display face ships as a real file',
    has('fonts/oswald-semibold.woff2')],
  ['their licences ship beside them',
    has('fonts/RobotoCondensed-LICENSE.txt') && has('fonts/Oswald-LICENSE.txt')],

  ['the stylesheet asks for the face it ships',
    Boolean(css) && /url\("fonts\/roboto-condensed\.woff2"\)/.test(css)
      && !/roboto-condensed-bold\.woff2/.test(css)],
  ['the card is styled, and set below full bold',
    Boolean(css) && /\.asbump__sched/.test(css) && /font-weight: 600;/.test(css)],

  /**
   * The preview harness's way in must NOT be reachable here. It is fenced on
   * window.__tvCalls, which only the design stub defines — but the fence is a
   * runtime condition, so the only way to know it held is to look at what
   * shipped.
   */
  ['the preview-only entry point is fenced, not exposed',
    Boolean(bundle) && /window\.__tvCalls/.test(bundle)],
];

let failed = 0;
for (const [what, ok] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
}
console.log(failed
  ? `${failed} SHIPPED CHECK(S) FAILED`
  : 'the installed app carries the up-next work');
process.exit(failed ? 1 : 0);
