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
import fs from 'node:fs';
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
/**
 * COMMENTS STRIPPED, for any check that asks whether a rule is ABSENT.
 *
 * The first run of the settings checks below reported the divider exception
 * still using :first-of-type. It was not: the only occurrence left in the file
 * was the comment explaining why that selector had been replaced. A check that
 * reads the argument instead of the rule reports the opposite of the truth,
 * and it does it in the direction that looks like a failed deploy.
 */
const rules = css ? css.replace(/\/\*[\s\S]*?\*\//g, '') : null;
const styles = read('src', 'shared', 'bumperStyles.js');
const music = read('electron', 'bumperMusic.js');
const clipper = read('electron', 'bumperClip.js');
const html = read('src', 'renderer', 'index.html');
const sched = read('src', 'shared', 'scheduler.js');

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

  // ── the box office ────────────────────────────────────────────────────
  ['the box office is in the style registry, at its own length',
    Boolean(styles) && /id: 'boxoffice'/.test(styles) && /seconds: 10/.test(styles)],
  ['the backdrop cutter ships, at the deeper seek',
    Boolean(clipper) && /map_chapters/.test(clipper) && /FRACTION = 0\.22/.test(clipper)],
  ['its card driver is in the bundle',
    Boolean(bundle) && /showBoxOffice/.test(bundle) && /boxofficeLead/.test(bundle)],
  ['Raleway ships as a real file, with its licence',
    has('fonts/raleway.woff2') && has('fonts/Raleway-LICENSE.txt')],
  ['the card is styled, with the band it animates',
    Boolean(css) && /\.boxoffice__opener/.test(css) && /--band-top/.test(css)],

  /**
   * inherits: TRUE — one word, and the difference between a picture that opens
   * and a bar that never does. The element carrying the mask reads the value
   * from the card, and inherits:false leaves it at its initial for ever. It
   * survived three rounds of review because it is invisible to every DOM
   * measurement, so it earns a shipped check of its own.
   */
  ['the band stops inherit, or the mask never opens',
    Boolean(css) && /@property --band-top \{[^}]*inherits: true/.test(css)],

  ['the debug entry point is gated on the environment',
    Boolean(bundle) && /isDebug/.test(bundle)],

  // ── the settings rearrangement ────────────────────────────────────────
  ['the three interstitial sections shipped as one',
    Boolean(html) && /<h4 class="setsub">Up next<\/h4>/.test(html)
      && !/<h3[^>]*>Promos<\/h3>/.test(html)],
  ['schedules got their own section, with the editor in it',
    Boolean(html) && /<h3 class="setgroup__head mono">Schedules<\/h3>/.test(html)
      && (html.match(/id="btnOpenSchedule"/g) || []).length === 1],
  ['the opening-schedule settings ship, and remember by default',
    Boolean(sched) && /rememberLastSchedule: true,/.test(sched)
      && /defaultScheduleId: null,/.test(sched)
      && /function openingScheduleId/.test(sched)],
  /**
   * It has to reach the QUEUE, not just the setting. The first version changed
   * activeScheduleId before the library loaded, where nothing rebuilds the
   * queue — so the channel kept playing the old running order while every
   * control said otherwise.
   */
  ['the opening schedule is applied through applySettings, after the library',
    Boolean(bundle) && /applyOpeningSchedule/.test(bundle)
      && /openingScheduleId/.test(bundle)],

  // ── the settings polish pass ──────────────────────────────────────────
  /**
   * Every one of these guards a rule that some OTHER rule silently outranked
   * at some point in this pass. None of them threw; each showed only as the
   * screen disagreeing with the stylesheet. That is exactly the class of thing
   * a package-contents check is for — the code shipping is not the question,
   * the code winning is.
   */
  ['sub-headings carry a rule, a tick and full ink',
    Boolean(rules) && /\.setsub \{[^}]*border-top: 1px solid var\(--hair-soft\)/.test(rules)
      && /\.setsub \{[^}]*color: var\(--ink\)/.test(rules)
      && /\.setsub::before \{[^}]*background: var\(--signal\)/.test(rules)],

  ['the divider exception is adjacency, not :first-of-type',
    // :first-of-type resolves against the parent, so #promoGroup made Promos
    // look like a section opener; .setgroup > … then missed two more.
    Boolean(rules) && /\.setgroup__head \+ \.setsub \{/.test(rules)
      && !/\.setsub:first-of-type/.test(rules)],

  ['the switch ships, at the radius every other box in the sheet uses',
    Boolean(rules) && /\.check input\[type="checkbox"\] \{[^}]*border-radius: var\(--r-sm\)/.test(rules)
      && /\.check input\[type="checkbox"\] \{[^}]*border: 1px solid var\(--ink-mute\)/.test(rules)],

  ['it transitions the colour, not the background shorthand',
    // `transition: background` animates background-position too, which the VCR
    // skin uses to centre the cross it draws on this very input.
    Boolean(rules) && /transition: background-color var\(--fast\), border-color var\(--fast\)/.test(rules)
      && !/\.check input\[type="checkbox"\] \{[^}]*transition: background var\(/.test(rules)],

  ['a theme can still move the on colour, now that accent-color is inert',
    Boolean(rules) && /background: var\(--switch-on, var\(--signal\)\)/.test(rules)
      && /:root\[data-theme="01"\] \{ --switch-on:/.test(rules)],

  ['the VCR skin keeps its tick box and loses the knob',
    Boolean(rules) && /:root\[data-skin="vcr"\] \.check input\[type="checkbox"\]::after \{ content: none; \}/.test(rules)],

  ['the high-contrast fallback is placed where it can actually win',
    // A media query carries no specificity: beside the component it was (0,2,1)
    // against the skin's (0,3,1), so it was dead in the one skin it was for.
    Boolean(rules)
      && rules.indexOf('@media (forced-colors: active)') > rules.indexOf(':root[data-skin="vcr"] .check input,')
      && /@media \(forced-colors: active\)[\s\S]{0,400}:root\[data-skin="vcr"\] \.check input\[type="checkbox"\]/.test(rules)],

  ['the eight booleans announce as switches',
    Boolean(html) && (html.match(/role="switch"/g) || []).length === 8],

  ['the accent stopped doubling as a text colour for slider readouts',
    Boolean(rules) && /\.field__control output \{[^}]*color: var\(--ink\)/.test(rules)],

  ['the baked cue ships beside the asar, as a real file',
    // resources/audio/box-office.mp3 — extraResources copies INTO resources,
    // which is the directory the asar itself sits in, not its parent.
    fs.existsSync(path.join(path.dirname(asar), 'audio', 'box-office.mp3'))],
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
