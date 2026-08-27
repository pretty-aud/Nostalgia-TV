import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The media:// handler must read the disk in large chunks.
 *
 * Node's default file-stream highWaterMark is 64 KB, and leaving it there is
 * invisible: it is the ABSENCE of an option, so there is nothing in the source
 * to notice and nothing that looks wrong. It only shows up as "4K films stutter"
 * on a slow or degraded drive, where measured cold, 64 KB reads sustained
 * 2 MB/s against the 12 MB/s a 4K remux needs, while 1 MB reads clear it
 * comfortably.
 *
 * serveMedia answers on three branches, so the real risk is a fourth read
 * appearing later that quietly keeps the default and makes only some requests
 * slow. This asserts every read goes through the one helper that sets the size.
 *
 * Source text rather than imports, because main.js cannot load outside Electron.
 */

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const raw = fs.readFileSync(path.join(here, '..', 'electron', 'main.js'), 'utf8');

/**
 * Strip comments LINE-ANCHORED, never character-wise.
 *
 * A character-wise stripper has to find `//`, and this file is full of
 * `media://local/...` — it would cut real code at the scheme separator. Dropping
 * whole lines that OPEN with a comment marker is blunt but cannot misfire, and
 * it is enough: the thing it must remove is the block comment above the helper,
 * which names createReadStream in prose and would otherwise satisfy every check
 * below on its own.
 */
const code = raw
  .split('\n')
  .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
  .join('\n');

const countOf = (text, pattern) => (text.match(pattern) || []).length;

/** Evaluate a `1024 * 1024` style literal without eval. */
function chunkSize(text) {
  const m = /MEDIA_READ_CHUNK\s*=\s*([0-9*\s]+);/.exec(text);
  if (!m) return null;
  return m[1].split('*').reduce((total, part) => total * Number(part.trim()), 1);
}

describe('media:// read size', () => {
  it('the comment stripper is doing something, and is needed', () => {
    // Failing control. If these two are ever equal, the stripper has stopped
    // removing the prose that mentions createReadStream, and every assertion
    // below could be passing on a comment rather than on code.
    expect(countOf(raw, /createReadStream/g)).toBeGreaterThan(
      countOf(code, /createReadStream/g),
    );
    expect(code.length).toBeLessThan(raw.length);
  });

  it('opens the file in exactly one place', () => {
    expect(countOf(code, /createReadStream/g)).toBe(1);
  });

  it('sets an explicit read size on that one place', () => {
    // The bug was an absent option, so the presence of the word is the fix.
    expect(code).toMatch(/highWaterMark/);
    expect(countOf(code, /createReadStream\([^)]*\{[\s\S]*?highWaterMark/g)).toBe(1);
  });

  it('reads far more than the 64 KB default', () => {
    const size = chunkSize(code);
    expect(size).not.toBe(null);
    // Anything at or below the default would leave the original bug in place
    // while looking deliberate.
    expect(size).toBeGreaterThan(64 * 1024);
    // 1 MB is the chosen value; the ceiling guards against someone "fixing"
    // stutter by allocating a buffer per stream that costs more than it saves.
    expect(size).toBeGreaterThanOrEqual(512 * 1024);
    expect(size).toBeLessThanOrEqual(8 * 1024 * 1024);
  });

  it('serves every branch through the helper', () => {
    // 200, the unparseable-Range fallback, and 206. Three responses, one reader.
    expect(countOf(code, /mediaBody\(/g)).toBeGreaterThanOrEqual(4); // 3 calls + the definition
  });
});
