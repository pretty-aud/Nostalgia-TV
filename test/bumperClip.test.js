import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  seekFor, clipArgs, clipPathFor, readyClip, clipFor, init,
  FRACTION, FLOOR_SECONDS, CAP_SECONDS,
} from '../electron/bumperClip.js';

/**
 * Where the background is taken from.
 *
 * Driven by RUNTIME rather than by files, because the interesting cases are
 * the ones her library has few of — a forty-second promo, a three-hour film —
 * and a rule checked only against whatever happens to be in a fixture folder
 * is a rule checked against nothing in particular.
 */
describe('choosing where to take the background from', () => {
  const MINUTE = 60;

  it('takes a proportion of the runtime for an ordinary episode', () => {
    // 22 minutes -> about 2m40, comfortably past a title sequence.
    expect(seekFor(22 * MINUTE)).toBeCloseTo(22 * MINUTE * FRACTION, 1);
  });

  it('never takes from the first ninety seconds, however short the file', () => {
    // A three-minute promo at 12% would be sampled at 21s, which is its own
    // title card — the floor is what stops the background being a caption.
    expect(seekFor(6 * MINUTE)).toBe(FLOOR_SECONDS);
    expect(seekFor(3 * MINUTE)).toBe(FLOOR_SECONDS);
  });

  /**
   * THE SPOILER GUARD. Without the cap a two-and-a-half hour film is sampled
   * eighteen minutes in, which is past the setup, and a bumper is not the
   * place to find out what happens.
   */
  it('never takes from more than ten minutes in, however long the file', () => {
    expect(seekFor(150 * MINUTE)).toBe(CAP_SECONDS);
    expect(seekFor(90 * MINUTE)).toBe(CAP_SECONDS);
  });

  it('is the cap that bites for a feature film, not the proportion', () => {
    // 100 minutes at 12% is 12 minutes; the answer must be 10, or the cap is
    // decorative.
    expect(100 * MINUTE * FRACTION).toBeGreaterThan(CAP_SECONDS);
    expect(seekFor(100 * MINUTE)).toBe(CAP_SECONDS);
  });

  describe('and leaving room for the clip itself', () => {
    /**
     * A file can be too short for its own rule. Asking for 90 seconds into a
     * 100-second file leaves ten seconds, and asking for a ten-second clip
     * from there leaves none — ffmpeg returns a fragment, or nothing, and the
     * card gets a <video> pointed at an empty file, which renders as a black
     * rectangle with no error.
     */
    it('does not start a ten-second clip closer than ten seconds to the end', () => {
      for (const duration of [100, 95, 60, 30, 12]) {
        expect(seekFor(duration, 10) + 10).toBeLessThanOrEqual(duration);
      }
    });

    it('gives up the rule and takes the middle of a very short file', () => {
      // 30 seconds cannot honour a 90-second floor. The middle is the best
      // available answer for something that has no "past the credits".
      expect(seekFor(30, 10)).toBe(10);
    });

    it('takes the top of anything shorter than the clip', () => {
      expect(seekFor(8, 10)).toBe(0);
      expect(seekFor(10, 10)).toBe(0);
    });
  });

  describe('and refusing to guess', () => {
    it('takes the top when the runtime is unknown', () => {
      // ffprobe fails on a file often enough that this is a real path, and a
      // NaN reaching ffmpeg as -ss makes it read the whole file.
      for (const bad of [undefined, null, 0, -5, NaN, 'twelve']) {
        expect(seekFor(bad)).toBe(0);
      }
    });
  });
});

/**
 * The ffmpeg call for a backdrop clip.
 *
 * Every switch asserted here was found by cutting a real episode and looking
 * at what came out — none is a precaution — and every one of them fails
 * SILENTLY if it is dropped. The fixture library is H.264 in mp4 with one
 * stream and no chapters, so a clip cut from it comes out fine no matter which
 * of these is missing; only her library, which is HEVC in Matroska with
 * chapters, shows the difference. A test at the argument list is the only
 * place this can be caught without her drive attached.
 */
describe('the ffmpeg call that cuts it', () => {
  const args = clipArgs('S01E01.mkv', 189.08, 10, 'out.mp4');
  const pair = (flag) => args[args.indexOf(flag) + 1];

  it('seeks BEFORE the input, not after', () => {
    // -ss after -i decodes every frame up to the offset. For a film sampled
    // ten minutes in that is ten minutes of decoding for a ten-second clip.
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(pair('-ss')).toBe('189.08');
  });

  it('takes exactly one stream: the first video track', () => {
    expect(pair('-map')).toBe('0:v:0');
    for (const refusal of ['-an', '-sn', '-dn']) expect(args).toContain(refusal);
  });

  /**
   * CHAPTERS, which -dn does not cover and -map does not exclude. Her episodes
   * carry them, and ffmpeg turns a Matroska chapter list into an MP4 chapter
   * track that ffprobe reports as a bin_data stream — measured, on
   * Afro Samurai S01E01, surviving -map 0:v:0 -an -sn -dn.
   */
  it('refuses chapters, which survive every other exclusion', () => {
    expect(pair('-map_chapters')).toBe('-1');
  });

  it('encodes something a browser will actually decode', () => {
    // The whole reason this transcode exists. yuv420p specifically: a 10-bit
    // source passed through unchanged is a file Chromium declines.
    expect(pair('-c:v')).toBe('libx264');
    expect(pair('-pix_fmt')).toBe('yuv420p');
  });

  it('is cut for readiness rather than for looks', () => {
    // It runs for ten seconds behind type, at reduced height. A slower preset
    // buys quality nobody can see, at the risk of missing its own card.
    expect(pair('-preset')).toBe('veryfast');
    expect(pair('-t')).toBe('10');
    expect(pair('-vf')).toMatch(/min\(720,ih\)/);
  });

  it('writes a file a <video> can start before it has all of it', () => {
    expect(pair('-movflags')).toBe('+faststart');
  });
});

/**
 * CUTTING AND LOOKING UP MUST AGREE ABOUT THE FILENAME.
 *
 * They did not, and the way they failed is the reason this test exists rather
 * than a comment. The duration is part of the key, through the seek. The
 * lookup was called without one, computed a seek of zero, and asked for a file
 * that had never been written — and "no file" is a LEGITIMATE answer meaning
 * "not cut yet", so the card fell back to a still on every single card and
 * nothing anywhere reported a fault. It was found by instrumenting the running
 * app, not by any test, and it shipped through a full end-to-end run that
 * reported "backdrop: still frame" as though that were fine.
 *
 * Both sides now derive the path from one function. These check that they
 * still do, and that the arguments cannot quietly swap places.
 */
describe('finding the clip that was cut', () => {
  const dir = path.join(os.tmpdir(), 'ntv-clip-key-test');

  beforeEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    init({ dir, findFfmpeg: () => null });
  });

  /** A stand-in for a source file; only its size and mtime reach the key. */
  const source = () => {
    const file = path.join(dir, 'source.mkv');
    fs.writeFileSync(file, 'x');
    return file;
  };

  it('looks in exactly the place a cut would have written to', async () => {
    const file = source();
    const written = await clipPathFor(file, 1419, 10);
    fs.writeFileSync(written, 'not really an mp4, but it has a size');
    expect(await readyClip(file, 1419, 10)).toBe(written);
  });

  /**
   * THE ACTUAL BUG, as a test. A lookup that forgets the duration must not
   * silently answer "nothing is ready" — which is what made this invisible.
   */
  it('does not find the clip when the duration is left out', async () => {
    const file = source();
    fs.writeFileSync(await clipPathFor(file, 1419, 10), 'x');
    // undefined duration -> seek 0 -> a different key entirely.
    expect(await readyClip(file, undefined, 10)).toBe(null);
    expect(await clipPathFor(file, undefined, 10)).not.toBe(await clipPathFor(file, 1419, 10));
  });

  it('takes its arguments in the same order as the cut does', async () => {
    // Swapping duration and clip length gives a different file, so the two
    // calls cannot drift into different orders without this failing.
    const file = source();
    expect(await clipPathFor(file, 1419, 10)).not.toBe(await clipPathFor(file, 10, 1419));
  });

  it('re-cuts when the source file changes under the same name', async () => {
    const file = source();
    const before = await clipPathFor(file, 1419, 10);
    fs.writeFileSync(file, 'a different recording, same filename');
    expect(await clipPathFor(file, 1419, 10)).not.toBe(before);
  });

  it('answers null rather than throwing when nothing has been cut', async () => {
    expect(await readyClip(source(), 1419, 10)).toBe(null);
  });
});

/**
 * A CLIP ONLY EXISTS WHEN IT IS FINISHED.
 *
 * The readiness check asked whether the file was non-empty. ffmpeg writes an
 * mp4 progressively, so a clip still being cut IS non-empty — the card was
 * handed a truncated file, the <video> refused to decode it, and the still
 * underneath showed through. On the first play of every session, with every
 * report saying success.
 *
 * Measured with the debug preview: card one "clip decoding: NO", card two
 * "yes, 1280x720, reached 7.5s". The only difference was that by the second
 * card the cut had finished.
 *
 * So ffmpeg writes to a .part and the finished file is renamed into place.
 * Existence and completeness become the same fact.
 */
describe('a half-written clip', () => {
  const dir = path.join(os.tmpdir(), 'ntv-clip-partial-test');

  beforeEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    init({ dir, findFfmpeg: () => null });
  });

  const source = () => {
    const file = path.join(dir, 'source.mkv');
    fs.writeFileSync(file, 'x');
    return file;
  };

  it('is not reported as ready', async () => {
    const file = source();
    const target = await clipPathFor(file, 1419, 10);
    // What a cut in progress looks like on disk: bytes under the .part name,
    // nothing yet under the real one.
    fs.writeFileSync(target.replace(/.mp4$/, '.part.mp4'), 'the first two seconds of an mp4');
    expect(await readyClip(file, 1419, 10)).toBe(null);
  });

  it('is reported as ready once it has been renamed into place', async () => {
    const file = source();
    const target = await clipPathFor(file, 1419, 10);
    const partial = target.replace(/.mp4$/, '.part.mp4');
    fs.writeFileSync(partial, 'bytes');
    fs.renameSync(partial, target);
    expect(await readyClip(file, 1419, 10)).toBe(target);
  });

  /**
   * WATCHING THE REAL CALL, not rebuilding it.
   *
   * The first version of this test built the argument list itself and checked
   * that — which passed happily while clipFor wrote straight to the final
   * filename, the exact bug it was written to catch. A test that constructs
   * its own subject is testing its own arithmetic.
   */
  it('asks ffmpeg for a .part, and only renames when the cut succeeds', async () => {
    const asked = [];
    init({
      dir,
      findFfmpeg: () => 'ffmpeg',
      run: (args, outPath) => {
        asked.push(outPath);
        fs.writeFileSync(outPath, 'a finished clip');
        return Promise.resolve(outPath);
      },
    });

    const file = source();
    const target = await clipPathFor(file, 1419, 10);
    await clipFor(file, 1419, 10);

    /**
     * ".part" BEFORE the extension. ffmpeg picks its output format from the
     * extension, so "clip.mp4.part" is a file it cannot guess a format for and
     * it writes nothing at all — which is what appending .part actually did,
     * breaking the clip and the still at once.
     */
    const partial = target.replace(/\.mp4$/, '.part.mp4');
    expect(asked, 'ffmpeg was pointed at the wrong name').toEqual([partial]);
    expect(partial.endsWith('.mp4'), 'the temp name lost its extension').toBe(true);
    expect(fs.existsSync(target), 'the finished clip was never renamed into place').toBe(true);
    expect(fs.existsSync(partial), 'the part file was left behind').toBe(false);
  });

  it('leaves nothing behind when the cut fails', async () => {
    init({
      dir,
      findFfmpeg: () => 'ffmpeg',
      run: (args, outPath) => {
        fs.writeFileSync(outPath, 'half of one');
        return Promise.reject(new Error('ffmpeg died'));
      },
    });

    const file = source();
    const target = await clipPathFor(file, 1419, 10);
    await expect(clipFor(file, 1419, 10)).rejects.toThrow('ffmpeg died');
    // A half-cut file under the real name would be handed out for ever.
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(target.replace(/.mp4$/, '.part.mp4'))).toBe(false);
  });
});
