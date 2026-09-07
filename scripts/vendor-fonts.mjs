/**
 * Fetch the condensed faces the up-next styles need, once, into the repo.
 *
 * Same shape as vendor-ffmpeg.mjs and vendor-mpv.mjs: a script that pulls a
 * third-party artefact and leaves it committed, rather than a build step that
 * reaches the network every time.
 *
 * ── Why any of this is necessary ─────────────────────────────────────────
 *
 * Both reference styles are built on a condensed bold grotesque and the app
 * cannot make one. Measured by decompressing each bundled woff2 and reading
 * its axis tags: inter.woff2 carries wght+opsz, space-grotesk.woff2 wght,
 * jetbrains-mono.woff2 wght+ital — no `wdth` anywhere. Each @font-face also
 * declares only a weight range, so `font-stretch: condensed` has nothing to
 * map onto and Chromium will not synthesize a condensed width. It is a silent
 * no-op: the type just comes out at normal width and looks wrong.
 *
 * And the CSP (index.html) declares no font-src, so it falls back to
 * `default-src 'self'` — a data:-URI @font-face is blocked outright. The file
 * has to be a real file, in src/renderer/fonts, which is one of the few
 * directories electron-builder actually packages.
 *
 * ── The two faces ────────────────────────────────────────────────────────
 *
 * Roboto Condensed Bold stands in for Helvetica Neue Condensed Bold, which is
 * what [adult swim] switched to in 2003 and is not free. Oswald stands in for
 * Compacta, named in the archive record for HBO's sub-line copy, likewise not
 * free. Both substitutes are SIL Open Font License, so they can ship.
 *
 * Usage: node scripts/vendor-fonts.mjs [--ensure]
 *   --ensure  do nothing when the files are already present
 */

import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FONT_DIR = path.join(ROOT, 'src', 'renderer', 'fonts');
const ENSURE = process.argv.includes('--ensure');

/**
 * A browser UA, and it is load-bearing.
 *
 * The Google Fonts CSS endpoint serves a DIFFERENT stylesheet per user agent —
 * older formats to agents it does not recognise. Asking without one gets TTF
 * URLs back, which are two to three times the size for the same glyphs.
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const FONTS = [
  {
    /**
     * VARIABLE, 400 to 700, not a single static Bold.
     *
     * The real face is Helvetica Neue Condensed Bold — confirmed across
     * several sources, adopted 25 May 2003 and used consistently on the logo,
     * the bumpers and the promos. It is licensed and cannot ship, and Roboto
     * Condensed is the honest stand-in: Roboto is a neo-grotesque in the same
     * line, and it is open.
     *
     * But it is not the SAME weight at the same number. Roboto Condensed 700
     * is optically heavier and tighter than Helvetica Neue Condensed Bold, and
     * set at 700 the card read as too bold. One variable file makes the weight
     * something that can be dialled to match rather than something the choice
     * of file locks in — and it costs less than shipping two statics.
     */
    file: 'roboto-condensed.woff2',
    css: 'https://fonts.googleapis.com/css2?family=Roboto+Condensed:wght@400..700&display=block',
    licence: 'RobotoCondensed-LICENSE.txt',
    licenceUrl: 'https://raw.githubusercontent.com/google/fonts/main/ofl/robotocondensed/OFL.txt',
    what: 'Roboto Condensed 400-700 variable — stands in for Helvetica Neue Condensed Bold',
  },
  {
    file: 'oswald-semibold.woff2',
    css: 'https://fonts.googleapis.com/css2?family=Oswald:wght@600&display=block',
    licence: 'Oswald-LICENSE.txt',
    licenceUrl: 'https://raw.githubusercontent.com/google/fonts/main/ofl/oswald/OFL.txt',
    what: 'Oswald SemiBold — stands in for Compacta',
  },
];

async function get(url, headers = {}) {
  let lastError = null;
  // One retry: a push from this machine has already failed once on a transient
  // connect timeout and succeeded immediately after.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { headers });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      return response;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * The LATIN block, not the first block.
 *
 * The CSS2 endpoint returns one @font-face per subset — cyrillic, greek,
 * vietnamese, latin-ext, latin — and latin is LAST. Taking the first match
 * downloads a Cyrillic subset that renders every Latin letter as a blank box,
 * which looks exactly like the font failing to load.
 */
function latinWoff2(css) {
  const blocks = css.split('@font-face').slice(1);
  for (const block of blocks) {
    const range = /unicode-range:\s*([^;]+);/.exec(block);
    const src = /src:\s*url\((https:[^)]+\.woff2)\)/.exec(block);
    if (!src) continue;
    // U+0041 is 'A'. The latin subset is the one that actually covers it.
    if (range && !/U\+0000-00FF/i.test(range[1])) continue;
    return src[1];
  }
  return null;
}

mkdirSync(FONT_DIR, { recursive: true });

for (const font of FONTS) {
  const target = path.join(FONT_DIR, font.file);
  const licenceTarget = path.join(FONT_DIR, font.licence);
  if (ENSURE && existsSync(target) && existsSync(licenceTarget)) {
    console.log(`have      ${font.file}`);
    continue;
  }

  const css = await (await get(font.css, { 'User-Agent': UA })).text();
  const url = latinWoff2(css);
  if (!url) throw new Error(`no latin woff2 in the stylesheet for ${font.file}`);

  const bytes = Buffer.from(await (await get(url)).arrayBuffer());
  // A woff2 begins with the signature 'wOF2'. Anything else means an error
  // page was saved under a font's name, which fails later as a mystery.
  if (bytes.subarray(0, 4).toString('latin1') !== 'wOF2') {
    throw new Error(`${font.file} is not a woff2 — got ${bytes.subarray(0, 16).toString('latin1')}`);
  }
  writeFileSync(target, bytes);

  const licence = await (await get(font.licenceUrl)).text();
  writeFileSync(licenceTarget, licence);

  console.log(`fetched   ${font.file}  ${(bytes.length / 1024).toFixed(1)}kb  — ${font.what}`);
  console.log(`          ${font.licence}  ${(licence.length / 1024).toFixed(1)}kb`);
  console.log(`          from ${url}`);
}
