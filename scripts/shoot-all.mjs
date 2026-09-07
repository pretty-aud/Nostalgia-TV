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
  'settings-subsections',
  'setsub-rhythm',
  'settings-switches',
  'settings-whole',
  'sched-drag',
  'sched-gap',
  'sched-editor',
  'sched-movies',
  'sched-movieblock',
  'library-edges',
  /**
   * Sets its own theme, so it is NOT in the themed map below — running it
   * under another skin would just have it switch to VHS anyway and photograph
   * the same frame twice under two different names.
   */
  'vhs-red',
  'cewr-standby',
  'cewr-card',
  'cewr-signoff',
  'boxoffice-beat',
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
  /**
   * A SHORT window, which is the only size the schedule sheet's locked frame
   * can be wrong at. At 880 tall it fits whatever you do to it; the scrolling
   * she reported only appears when the frame has to shrink. Run at 880 as well
   * (below) so both the roomy and the tight case are covered.
   *
   * Worth knowing: until shoot-state was fixed, every size in this map was
   * 1.5× larger than it said on this machine, so "narrow" above was 1480px and
   * had never once been narrow.
   */
  'sched-movieblock': ['1120', '620'],
};

/**
 * Shots that must run in more than one palette.
 *
 * A component drawn with `appearance: none` is only as portable as the tokens
 * it reads, and the two ways that goes wrong are invisible in the default
 * theme: a skin that overrides the control at higher specificity, and an off
 * state whose contrast collapses on a light ground. So the switch is
 * photographed in a dark theme, a light one, the theme with its own accent
 * rule, and the skin that repaints the control entirely.
 */
const THEMES = {
  // kawaii decorates a hand-written list of headings with a ::before heart.
  // .setsub is not on that list and the sub-heading tick is a ::before, so the
  // two would collide the moment somebody adds it — photographed so that stays
  // a decision rather than a surprise.
  'settings-switches': ['midnight', 'arctic', '01', 'vhs', 'kawaii'],
  // VHS is not optional for these two: the drop-lands-at-the-bottom bug was
  // reported on that skin, because uppercasing every string grows the cards and
  // leaves more empty column beneath them. Testing only the default palette
  // would re-test the case where the dead zones were smallest.
  'sched-drag': ['midnight', 'vhs'],
  'sched-gap': ['midnight', 'vhs'],
  'sched-movies': ['midnight', 'vhs'],
  // Both skins, because the arrow's legibility is solved two different ways:
  // a soft halo everywhere, and four hard one-pixel offsets under the VCR skin,
  // which does not permit a soft edge anywhere.
  'library-edges': ['midnight', 'vhs'],
  'sched-movieblock': ['midnight', 'vhs'],
};

let failed = 0;
for (const name of SHOTS) {
  const size = SIZES[name] || [];
  for (const theme of THEMES[name] || ['']) {
    const suffix = theme ? `-${theme}` : '';
    const result = spawnSync(electron, [
      path.join(root, 'scripts', 'shoot-state.js'), '--',
      url,
      path.join(root, 'shots', `${name}${suffix}.png`),
      path.join(root, 'scripts', 'shots', `${name}.js`),
      ...size,
    ], { cwd: root, encoding: 'utf8', env: { ...process.env, NTV_SHOT_THEME: theme } });

    const ok = result.status === 0;
    if (!ok) failed += 1;
    const at = size.length ? ` @${size.join('x')}` : '';
    const inTheme = theme ? ` [${theme}]` : '';
    console.log(`${ok ? '✓' : '✗'} ${name}${at}${inTheme}${ok ? '' : ` (exit ${result.status}) ${(result.stderr || '').trim()}`}`);
  }
}

process.exit(failed ? 1 : 0);
