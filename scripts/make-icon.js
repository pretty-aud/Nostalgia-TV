'use strict';

/**
 * Generate build/icon.ico from scratch — no image library, no binary asset in
 * the repo.
 *
 * The app has one identity mark already: the amber signal dot next to the
 * wordmark in the sidebar. That is what this draws, because at taskbar size
 * (16px) anything with structure turns to mush, and a single saturated dot on a
 * dark tile stays legible and distinct from every other pinned icon.
 *
 * Two formats are hand-built here:
 *   PNG — signature, IHDR, IDAT (zlib-deflated scanlines), IEND.
 *   ICO — a Vista-era icon that simply EMBEDS a PNG rather than a BMP, which is
 *         why this fits in a page of code instead of a library.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 256;

const PAPER = [0x08, 0x07, 0x0c];   // --paper
const SIGNAL = [0xff, 0xc2, 0x47];  // --signal
const INK = [0xf4, 0xf1, 0xea];     // --ink

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n += 1) {
    c = n;
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

/** Coverage of a pixel by a disc, sampled 3x3 so the edge is not jagged. */
function discCoverage(x, y, cx, cy, radius) {
  let hits = 0;
  for (let sy = 0; sy < 3; sy += 1) {
    for (let sx = 0; sx < 3; sx += 1) {
      const px = x + (sx + 0.5) / 3;
      const py = y + (sy + 0.5) / 3;
      if ((px - cx) ** 2 + (py - cy) ** 2 <= radius ** 2) hits += 1;
    }
  }
  return hits / 9;
}

function mix(under, over, alpha) {
  return [
    Math.round(under[0] + (over[0] - under[0]) * alpha),
    Math.round(under[1] + (over[1] - under[1]) * alpha),
    Math.round(under[2] + (over[2] - under[2]) * alpha),
  ];
}

function drawPixels() {
  const centre = SIZE / 2;
  const rows = [];

  for (let y = 0; y < SIZE; y += 1) {
    // One filter byte per scanline; 0 = None, which keeps this readable.
    const row = [0];
    for (let x = 0; x < SIZE; x += 1) {
      let colour = PAPER;

      // Two thin ink arcs behind the dot: a channel ident, not a logo. They
      // read as texture at small sizes rather than resolving into shapes.
      for (const [radius, weight] of [[104, 0.20], [88, 0.10]]) {
        const ring = discCoverage(x, y, centre, centre, radius)
          - discCoverage(x, y, centre, centre, radius - 3);
        if (ring > 0) colour = mix(colour, INK, ring * weight);
      }

      const dot = discCoverage(x, y, centre, centre, 62);
      if (dot > 0) colour = mix(colour, SIGNAL, dot);

      row.push(colour[0], colour[1], colour[2], 255);
    }
    rows.push(Buffer.from(row));
  }
  return Buffer.concat(rows);
}

function buildPng() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // adaptive filtering
  ihdr[12] = 0;  // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(drawPixels(), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function buildIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);  // reserved
  header.writeUInt16LE(1, 2);  // 1 = icon
  header.writeUInt16LE(1, 4);  // one image

  const entry = Buffer.alloc(16);
  entry[0] = 0;                 // width  256 is encoded as 0
  entry[1] = 0;                 // height 256 is encoded as 0
  entry[2] = 0;                 // palette size (none)
  entry[3] = 0;                 // reserved
  entry.writeUInt16LE(1, 4);    // colour planes
  entry.writeUInt16LE(32, 6);   // bits per pixel
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12);  // offset: 6 header + 16 entry

  return Buffer.concat([header, entry, png]);
}

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });

const png = buildPng();
fs.writeFileSync(path.join(outDir, 'icon.png'), png);
fs.writeFileSync(path.join(outDir, 'icon.ico'), buildIco(png));

console.log(`icon.png  ${png.length} bytes`);
console.log(`icon.ico  ${fs.statSync(path.join(outDir, 'icon.ico')).size} bytes  (${SIZE}x${SIZE})`);
