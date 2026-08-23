import { describe, it, expect } from 'vitest';
import { partArgsFor } from '../electron/prepare.js';
import { planPlayback, ffmpegArgsFor } from '../src/shared/playability.js';

/**
 * Regression cover for the bug that made every .mkv appear unplayable.
 *
 * Conversions are written to `<hash>.mp4.part` and renamed on a clean exit, so
 * a crash cannot leave a truncated file that looks finished. But ffmpeg picks
 * its muxer from the output EXTENSION, and `.part` is not one it knows — so it
 * exited immediately with "Unable to choose an output format", wrote nothing,
 * and every file that needed converting was skipped as unplayable. Nothing in
 * the app surfaced it: the cache simply stayed empty.
 */

const OUT = 'C:/cache/abc123.mp4';
const PART = `${OUT}.part`;

describe('partArgsFor', () => {
  it('states the output format explicitly', () => {
    // Without this ffmpeg cannot infer mp4 from ".part" and writes nothing.
    const args = partArgsFor(['-i', 'in.mkv', '-c', 'copy', OUT], OUT, PART);
    expect(args).toContain('-f');
    expect(args[args.indexOf('-f') + 1]).toBe('mp4');
  });

  it('puts the format immediately before the output path', () => {
    // ffmpeg applies -f to the output that follows it; anywhere else it either
    // does nothing or is read as an INPUT format.
    const args = partArgsFor(['-i', 'in.mkv', OUT], OUT, PART);
    const at = args.indexOf('-f');
    expect(args[at + 1]).toBe('mp4');
    expect(args[at + 2]).toBe(PART);
    expect(args.at(-1)).toBe(PART);
  });

  it('writes to the part file, never straight to the final path', () => {
    const args = partArgsFor(['-i', 'in.mkv', OUT], OUT, PART);
    expect(args).toContain(PART);
    expect(args).not.toContain(OUT);
  });

  it('leaves every other argument untouched and in order', () => {
    const original = ['-hide_banner', '-i', 'in.mkv', '-c:v', 'copy', '-c:a', 'aac', OUT];
    const args = partArgsFor(original, OUT, PART);
    expect(args.slice(0, 7)).toEqual(original.slice(0, 7));
  });

  it('does not rewrite an input path that merely resembles the output', () => {
    const args = partArgsFor(['-i', 'C:/cache/abc123.mp4.backup', OUT], OUT, PART);
    expect(args[1]).toBe('C:/cache/abc123.mp4.backup');
  });

  it('holds for every tier that actually runs ffmpeg', () => {
    const probe = (v, a) => ({ ok: true, tracks: [
      { type: 'video', codecId: v }, { type: 'audio', codecId: a },
    ] });
    const cases = [
      planPlayback({ fileName: 'e.mkv', probe: probe('V_MPEG4/ISO/AVC', 'A_AAC') }),  // remux
      planPlayback({ fileName: 'e.mkv', probe: probe('V_MPEG4/ISO/AVC', 'A_AC3') }),  // audio
      planPlayback({ fileName: 'e.avi', probe: probe('V_MPEG4/ISO/ASP', 'A_AC3') }),  // full
    ];
    for (const plan of cases) {
      const args = partArgsFor(ffmpegArgsFor(plan, 'in', OUT), OUT, PART);
      expect(args[args.indexOf('-f') + 1], plan.tier).toBe('mp4');
      expect(args.at(-1), plan.tier).toBe(PART);
    }
  });
});
