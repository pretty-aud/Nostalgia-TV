'use strict';

/**
 * Generate build/icon.ico and build/icon.png from scratch — no image library,
 * no binary asset in the repo.
 *
 * The mark is a classic set with rabbit ears, drawn on a TRANSPARENT ground.
 * The version before this was an amber dot on an opaque near-black tile, which
 * meant Windows drew a black square around the icon everywhere the shell does
 * not paint its own background: the taskbar, the Start tile, the desktop.
 *
 * Everything here is hand-built:
 *   PNG — signature, IHDR, IDAT (zlib-deflated RGBA scanlines), IEND.
 *   ICO — one directory entry per size. PNG for the large entries, and an
 *         old-style DIB for 64 and under, because a few corners of the Windows
 *         shell still only look for PNG data at 256.
 *
 * Run: node scripts/make-icon.js
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

/**
 * Drawn once at this size and scaled down to each icon size.
 *
 * Rendering each size directly would cap the number of alpha levels an edge can
 * use at the supersample count — fine at 256, visibly stepped at 16. Drawing
 * once at 512 and area-averaging gives a 32x32 box of samples per pixel at the
 * smallest size, which is what keeps the antennas from turning into stairs.
 */
const MASTER = 512;
const SIZES = [256, 128, 64, 48, 32, 24, 16];
const PNG_AT_LEAST = 128;

const AMBER = [0xff, 0xc2, 0x47];   // --signal
const DARK = [0x0f, 0x0d, 0x14];    // a hair lighter than --paper, so the
                                    // screen still reads as a screen on black

/* ── geometry, in fractions of the canvas ─────────────────────────────────
   Fractions rather than pixels so the master size can change without the
   drawing moving. y runs downward. */

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

function crc32(buf) {
  const table = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/* ── shapes ───────────────────────────────────────────────────────────────
   Each returns "is this sample point inside me", in canvas fractions. The
   supersampling above them turns that into coverage. */

function inRoundRect(px, py, [x0, y0, x1, y1], r, grow = 0) {
  const a0 = x0 - grow; const a1 = x1 + grow;
  const b0 = y0 - grow; const b1 = y1 + grow;
  const rr = Math.min(r + grow, (a1 - a0) / 2, (b1 - b0) / 2);
  if (px < a0 || px > a1 || py < b0 || py > b1) return false;
  const cx = Math.min(Math.max(px, a0 + rr), a1 - rr);
  const cy = Math.min(Math.max(py, b0 + rr), b1 - rr);
  return (px - cx) ** 2 + (py - cy) ** 2 <= rr * rr;
}

function inDisc(px, py, cx, cy, r, grow = 0) {
  const rr = r + grow;
  return (px - cx) ** 2 + (py - cy) ** 2 <= rr * rr;
}

/** A capsule: the set of points within half-width of the segment a→b. */
function inRod(px, py, [ax, ay], [bx, by], half, grow = 0) {
  const dx = bx - ax; const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2));
  const qx = ax + t * dx; const qy = ay + t * dy;
  const w = half + grow;
  return (px - qx) ** 2 + (py - qy) ** 2 <= w * w;
}

/**
 * The whole mark, as an ordered list of {colour, hit} layers.
 *
 * Order is the drawing: each dark keyline goes down before the amber it
 * surrounds, so the outline is what is left showing round the edge rather than
 * a second shape that has to be kept in sync with the first.
 */
function layers() {
  const k = KEYLINE;
  return [
    // Rabbit ears, behind the set.
    [DARK, (x, y) => inRod(x, y, EAR_BASE, EAR_LEFT, EAR_WIDTH, k)
      || inRod(x, y, EAR_BASE, EAR_RIGHT, EAR_WIDTH, k)
      || inDisc(x, y, EAR_LEFT[0], EAR_LEFT[1], EAR_KNOB, k)
      || inDisc(x, y, EAR_RIGHT[0], EAR_RIGHT[1], EAR_KNOB, k)],
    [AMBER, (x, y) => inRod(x, y, EAR_BASE, EAR_LEFT, EAR_WIDTH)
      || inRod(x, y, EAR_BASE, EAR_RIGHT, EAR_WIDTH)
      || inDisc(x, y, EAR_LEFT[0], EAR_LEFT[1], EAR_KNOB)
      || inDisc(x, y, EAR_RIGHT[0], EAR_RIGHT[1], EAR_KNOB)],

    // Feet, then the cabinet over their tops.
    [DARK, (x, y) => FEET.some((f) => inRoundRect(x, y, f, FOOT_R, k))],
    [AMBER, (x, y) => FEET.some((f) => inRoundRect(x, y, f, FOOT_R))],
    [DARK, (x, y) => inRoundRect(x, y, BODY, BODY_R, k)],
    [AMBER, (x, y) => inRoundRect(x, y, BODY, BODY_R)],

    // Screen, dials and speaker grille, cut back out of the cabinet.
    [DARK, (x, y) => inRoundRect(x, y, SCREEN, SCREEN_R)
      || DIALS.some(([cx, cy, r]) => inDisc(x, y, cx, cy, r))
      || inRoundRect(x, y, GRILLE, GRILLE_R)],
  ];
}

/**
 * Render the mark to straight-alpha RGBA at MASTER size.
 *
 * The layers are opaque, so compositing is just "last one to cover this sample
 * wins" — no alpha blending needed, and coverage comes out as the fraction of
 * samples each layer took.
 */
function drawMaster() {
  const shapes = layers();
  const out = new Uint8ClampedArray(MASTER * MASTER * 4);
  const SS = 3;

  for (let y = 0; y < MASTER; y += 1) {
    for (let x = 0; x < MASTER; x += 1) {
      let r = 0; let g = 0; let b = 0; let hits = 0;

      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const px = (x + (sx + 0.5) / SS) / MASTER;
          const py = (y + (sy + 0.5) / SS) / MASTER;
          let colour = null;
          for (const [c, hit] of shapes) if (hit(px, py)) colour = c;
          if (colour) { r += colour[0]; g += colour[1]; b += colour[2]; hits += 1; }
        }
      }

      const i = (y * MASTER + x) * 4;
      if (hits) {
        out[i] = r / hits; out[i + 1] = g / hits; out[i + 2] = b / hits;
        out[i + 3] = Math.round((hits / (SS * SS)) * 255);
      }
    }
  }
  return out;
}

/**
 * Area-average down to `size`.
 *
 * Averaged in PREMULTIPLIED alpha. Averaging straight alpha pulls the colour of
 * fully transparent pixels — which is black here — into every edge, and the
 * result is an icon with a dirty grey fringe that only shows up once it is on
 * the taskbar.
 */
function resample(src, size) {
  const out = new Uint8ClampedArray(size * size * 4);
  const scale = MASTER / size;

  for (let y = 0; y < size; y += 1) {
    const y0 = y * scale; const y1 = (y + 1) * scale;
    for (let x = 0; x < size; x += 1) {
      const x0 = x * scale; const x1 = (x + 1) * scale;
      let r = 0; let g = 0; let b = 0; let a = 0; let w = 0;

      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy += 1) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx += 1) {
          const ww = (Math.min(x1, sx + 1) - Math.max(x0, sx)) * wy;
          const i = (sy * MASTER + sx) * 4;
          const sa = src[i + 3] / 255;
          r += src[i] * sa * ww; g += src[i + 1] * sa * ww; b += src[i + 2] * sa * ww;
          a += sa * ww; w += ww;
        }
      }

      const o = (y * size + x) * 4;
      const alpha = a / w;
      if (alpha > 0) {
        out[o] = r / w / alpha; out[o + 1] = g / w / alpha; out[o + 2] = b / w / alpha;
        out[o + 3] = Math.round(alpha * 255);
      }
    }
  }
  return out;
}

function buildPng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // adaptive filtering
  ihdr[12] = 0;  // no interlace

  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    const at = y * (size * 4 + 1);
    raw[at] = 0;  // filter: None
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, at + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A 32-bit DIB with the vestigial AND mask an ICO entry still has to carry. */
function buildDib(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  // Doubled height: the header describes the colour rows AND the mask rows.
  // Write the true height here and Windows draws the top half of the icon
  // stretched over the whole square.
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);                 // BI_RGB
  header.writeUInt32LE(size * size * 4, 20);

  const colour = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const from = (size - 1 - y) * size * 4;    // DIB rows run bottom-up
    for (let x = 0; x < size; x += 1) {
      const i = from + x * 4; const o = (y * size + x) * 4;
      colour[o] = rgba[i + 2]; colour[o + 1] = rgba[i + 1];
      colour[o + 2] = rgba[i]; colour[o + 3] = rgba[i + 3];
    }
  }

  // Zeroed: with an alpha channel present the mask is ignored, but its bytes
  // still have to be there and still have to be row-padded to 4.
  const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size);
  return Buffer.concat([header, colour, mask]);
}

function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);                  // 1 = icon
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const entries = images.map(({ size, data }) => {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;         // 256 is encoded as 0
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0;                              // palette size (none)
    entry[3] = 0;                              // reserved
    entry.writeUInt16LE(1, 4);                 // colour planes
    entry.writeUInt16LE(32, 6);                // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });

  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

function generate() {
  const master = drawMaster();
  const images = SIZES.map((size) => {
    const rgba = size === MASTER ? master : resample(master, size);
    return {
      size,
      rgba,
      data: size >= PNG_AT_LEAST ? buildPng(rgba, size) : buildDib(rgba, size),
    };
  });
  return { master, images, ico: buildIco(images) };
}

module.exports = { generate, resample, buildPng, drawMaster, MASTER, SIZES };

if (require.main === module) {
  const outDir = path.join(__dirname, '..', 'build');
  fs.mkdirSync(outDir, { recursive: true });

  const { images, ico } = generate();
  const largest = images.find((i) => i.size === 256);
  fs.writeFileSync(path.join(outDir, 'icon.png'), buildPng(largest.rgba, 256));
  fs.writeFileSync(path.join(outDir, 'icon.ico'), ico);

  console.log(`icon.png  ${fs.statSync(path.join(outDir, 'icon.png')).size} bytes  256x256`);
  console.log(`icon.ico  ${ico.length} bytes  ${images.map((i) => i.size).join(', ')}`);
}
