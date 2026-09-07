'use strict';

/**
 * THE NOSTALGIA MARK AS VECTOR — the amber set with rabbit ears, in SVG.
 *
 * The app already has this mark, but only as pixels: scripts/make-icon.js
 * draws it by supersampling a set of hit-tests into a raster, for the .ico and
 * the .png the installer needs. That is the right shape for an icon and the
 * wrong one for an end card, where it is drawn a couple of hundred pixels tall
 * over black and any softness in the edges reads as a low-resolution logo.
 *
 * So this is the same drawing, expressed as shapes instead of samples.
 *
 * ── The geometry is COPIED, and a test holds the copies together ─────────
 *
 * Every constant below is the value from make-icon.js. Two files owning the
 * same numbers is exactly the shape that has already gone wrong in this repo
 * once — the theme menu's two lists — so test/nostalgiaMark.test.js parses the
 * constants back out of make-icon.js and fails if they have drifted apart.
 * Without that, moving a dial in the icon would leave the end card drawing the
 * old set forever, and nothing would say so.
 *
 * ── Why the layers are in this order ─────────────────────────────────────
 *
 * Straight from make-icon's layers(): each dark shape is drawn slightly larger
 * underneath the amber one, so the keyline is what is LEFT SHOWING round the
 * edge rather than a second outline that has to be kept in step with the
 * first. Ears behind the set, feet behind the cabinet, then the screen, dials
 * and grille cut back out over the top.
 */

/* ── geometry, in fractions of the canvas — see make-icon.js ───────────── */
const EAR_BASE = [0.500, 0.470];
const EAR_LEFT = [0.170, 0.095];
const EAR_RIGHT = [0.820, 0.140];
const EAR_WIDTH = 0.017;
const EAR_KNOB = 0.044;

const BODY = [0.075, 0.435, 0.925, 0.880];
const BODY_R = 0.072;
const SCREEN = [0.130, 0.487, 0.735, 0.828];
const SCREEN_R = 0.048;

const DIALS = [[0.833, 0.562, 0.038], [0.833, 0.660, 0.038]];
const GRILLE = [0.788, 0.730, 0.878, 0.812];
const GRILLE_R = 0.018;
const FEET = [[0.185, 0.880, 0.320, 0.938], [0.680, 0.880, 0.815, 0.938]];
const FOOT_R = 0.020;

/** How far the dark keyline sticks out past the amber it surrounds. */
const KEYLINE = 0.016;

const AMBER = '#ffc247';
const DARK = '#0f0d14';

/** Fractions are drawn into a 1000-unit box, so every number reads as itself. */
const BOX = 1000;
const u = (n) => Number((n * BOX).toFixed(2));

/**
 * A rounded rect, optionally grown — the SVG twin of make-icon's inRoundRect.
 *
 * The radius is clamped the same way, to half the shorter side. Without that,
 * growing the feet by the keyline would give a radius larger than the shape
 * and SVG would silently clamp it differently from the hit-test, leaving the
 * vector and the raster with visibly different corners.
 */
function roundRect([x0, y0, x1, y1], r, fill, grow = 0) {
  const a0 = x0 - grow; const b0 = y0 - grow;
  const w = (x1 + grow) - a0; const h = (y1 + grow) - b0;
  const rr = Math.min(r + grow, w / 2, h / 2);
  return `<rect x="${u(a0)}" y="${u(b0)}" width="${u(w)}" height="${u(h)}" `
    + `rx="${u(rr)}" fill="${fill}"/>`;
}

/**
 * A capsule from a to b — make-icon's inRod.
 *
 * A stroked line with round caps IS a capsule: the cap adds a semicircle of
 * exactly the half-width at each end, which is the same set of points the
 * hit-test describes.
 */
function rod(a, b, half, fill, grow = 0) {
  const width = (half + grow) * 2;
  return `<line x1="${u(a[0])}" y1="${u(a[1])}" x2="${u(b[0])}" y2="${u(b[1])}" `
    + `stroke="${fill}" stroke-width="${u(width)}" stroke-linecap="round"/>`;
}

const disc = (cx, cy, r, fill, grow = 0) =>
  `<circle cx="${u(cx)}" cy="${u(cy)}" r="${u(r + grow)}" fill="${fill}"/>`;

/**
 * The mark, as an SVG string.
 *
 * A string rather than DOM so this module stays usable from the main process
 * and from a test, and so it can be dropped into innerHTML in the renderer
 * without a builder. `title` is the accessible name; pass null for decorative
 * use, where a duplicate label would just be read out twice.
 */
function markSvg({ size = 240, title = 'Nostalgia TV', className = '' } = {}) {
  const k = KEYLINE;
  const parts = [
    // Ears, behind the set.
    rod(EAR_BASE, EAR_LEFT, EAR_WIDTH, DARK, k),
    rod(EAR_BASE, EAR_RIGHT, EAR_WIDTH, DARK, k),
    disc(EAR_LEFT[0], EAR_LEFT[1], EAR_KNOB, DARK, k),
    disc(EAR_RIGHT[0], EAR_RIGHT[1], EAR_KNOB, DARK, k),
    rod(EAR_BASE, EAR_LEFT, EAR_WIDTH, AMBER),
    rod(EAR_BASE, EAR_RIGHT, EAR_WIDTH, AMBER),
    disc(EAR_LEFT[0], EAR_LEFT[1], EAR_KNOB, AMBER),
    disc(EAR_RIGHT[0], EAR_RIGHT[1], EAR_KNOB, AMBER),

    // Feet, then the cabinet over their tops.
    ...FEET.map((f) => roundRect(f, FOOT_R, DARK, k)),
    ...FEET.map((f) => roundRect(f, FOOT_R, AMBER)),
    roundRect(BODY, BODY_R, DARK, k),
    roundRect(BODY, BODY_R, AMBER),

    // Screen, dials and grille, cut back out of the cabinet.
    roundRect(SCREEN, SCREEN_R, DARK),
    ...DIALS.map(([cx, cy, r]) => disc(cx, cy, r, DARK)),
    roundRect(GRILLE, GRILLE_R, DARK),
  ];

  const label = title
    ? `role="img" aria-label="${title}"`
    : 'aria-hidden="true" focusable="false"';

  return `<svg viewBox="0 0 ${BOX} ${BOX}" width="${size}" height="${size}" `
    + `class="${className}" ${label} xmlns="http://www.w3.org/2000/svg">`
    + parts.join('')
    + '</svg>';
}

module.exports = {
  markSvg,
  AMBER,
  DARK,
  GEOMETRY: {
    EAR_BASE, EAR_LEFT, EAR_RIGHT, EAR_WIDTH, EAR_KNOB,
    BODY, BODY_R, SCREEN, SCREEN_R,
    DIALS, GRILLE, GRILLE_R, FEET, FOOT_R, KEYLINE,
  },
};
