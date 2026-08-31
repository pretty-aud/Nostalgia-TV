import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  partArgsFor, createStampMemo, setCacheDir, cleanupCache, cacheEntries,
  pin, unpinAllExcept, detectCrop, findFfmpeg, findFfprobe,
  probeWithFfprobe, probeMemoSize,
} from '../electron/prepare.js';
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

/**
 * The cache's launch-time hygiene, exercised against a real temp directory.
 *
 * These are the rules the app now RELIES on at every boot: main.js calls
 * cleanupCache() in whenReady, so a regression here is 70 GB of invisible
 * fragments again — the .part files that once accumulated because nothing but
 * a Settings button ever swept them.
 */
describe('cleanupCache', () => {
  let dir = null;

  const makeCache = async (files) => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ntv-prepare-'));
    setCacheDir(dir);
    for (const [name, spec] of Object.entries(files)) {
      const full = path.join(dir, name);
      await fsp.writeFile(full, Buffer.alloc(spec.size || 4));
      if (spec.atime) await fsp.utimes(full, new Date(spec.atime), new Date(spec.atime));
    }
    return dir;
  };

  afterEach(async () => {
    unpinAllExcept([]);
    if (dir) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    dir = null;
  });

  it('sweeps orphaned .part fragments and leaves finished conversions alone', async () => {
    await makeCache({
      'abandoned.mp4.part': { size: 64 },
      'finished.mp4': { size: 64 },
    });

    const result = await cleanupCache(1024 * 1024);

    expect(result.removedParts).toBe(1);
    expect(result.reclaimedBytes).toBe(64);
    const left = await fsp.readdir(dir);
    expect(left).toContain('finished.mp4');
    expect(left).not.toContain('abandoned.mp4.part');
  });

  it('enforces the budget oldest-first and never evicts a pinned file', async () => {
    const day = 24 * 60 * 60 * 1000;
    const now = Date.now();
    await makeCache({
      'oldest.mp4': { size: 100, atime: now - 3 * day },
      'pinned.mp4': { size: 100, atime: now - 2 * day },
      'newest.mp4': { size: 100, atime: now - 1 * day },
    });
    pin(path.join(dir, 'pinned.mp4'));

    const result = await cleanupCache(150);

    // Oldest goes first; the pinned one is skipped even though it is older
    // than the survivor's budget would otherwise demand.
    const left = await fsp.readdir(dir);
    expect(left).toContain('pinned.mp4');
    expect(left).not.toContain('oldest.mp4');
    expect(result.totalBytes).toBeLessThanOrEqual(150);
  });

  it('reports the surviving total so the settings screen can show it', async () => {
    await makeCache({ 'a.mp4': { size: 40 }, 'b.mp4': { size: 40 } });
    const result = await cleanupCache(1024);
    expect(result.totalBytes).toBe(80);
    expect(result.evicted).toBe(0);
    expect((await cacheEntries()).length).toBe(2);
  });

  it('minAgeMs protects the last session\'s working set at boot', async () => {
    // The boot pass has NO pins — they died with the previous process — and
    // the resume episode's conversion holds the OLDEST atime of the working
    // set (touched at its play's start, before the ahead-conversions were
    // written). A floorless pass evicts exactly the file the Resume button is
    // about to ask for. The floor keeps everything recently used, even when
    // that leaves the cache over budget for the mid-session passes to settle.
    const hour = 60 * 60 * 1000;
    const now = Date.now();
    await makeCache({
      'stale-weeks-old.mp4': { size: 100, atime: now - 400 * hour },
      'resume-episode.mp4': { size: 100, atime: now - 20 * hour },
      'ahead-conversion.mp4': { size: 100, atime: now - 19 * hour },
    });

    const result = await cleanupCache(150, { minAgeMs: 48 * hour });

    const left = await fsp.readdir(dir);
    expect(left).not.toContain('stale-weeks-old.mp4');
    expect(left).toContain('resume-episode.mp4');
    expect(left).toContain('ahead-conversion.mp4');
    // Still over budget, and honestly reported as such.
    expect(result.totalBytes).toBe(200);
  });

  it('without a floor the same cache would lose the resume episode first', async () => {
    // The failing control for the test above: this is the exact behavior the
    // floor exists to prevent, so it had better still be what a floorless
    // call does — otherwise the floor test is passing for the wrong reason.
    const hour = 60 * 60 * 1000;
    const now = Date.now();
    await makeCache({
      'stale-weeks-old.mp4': { size: 100, atime: now - 400 * hour },
      'resume-episode.mp4': { size: 100, atime: now - 20 * hour },
      'ahead-conversion.mp4': { size: 100, atime: now - 19 * hour },
    });

    await cleanupCache(150);

    const left = await fsp.readdir(dir);
    expect(left).not.toContain('stale-weeks-old.mp4');
    expect(left).not.toContain('resume-episode.mp4');
    expect(left).toContain('ahead-conversion.mp4');
  });
});

/**
 * The probe memo's validation and eviction rules.
 *
 * ffprobe used to spawn fresh for every question — three to five times per
 * first play of the same unchanged file. The memo makes that one spawn, but
 * only under two safety rules that these tests hold: a changed stamp (the file
 * was swapped in place) must MISS, and the memo must stay bounded.
 */
describe('createStampMemo', () => {
  it('returns a remembered value only while the stamp still matches', () => {
    const memo = createStampMemo(4);
    memo.set('a', '100:1', { tracks: 1 });
    expect(memo.get('a', '100:1')).toEqual({ tracks: 1 });
    // Same key, different stamp: the file changed under us. Serving the old
    // answer here is the swapped-in-place bug the conversion cache key exists
    // to prevent — the memo lives by the same rule.
    expect(memo.get('a', '200:2')).toBeUndefined();
  });

  it('misses on a key it has never seen', () => {
    const memo = createStampMemo(4);
    expect(memo.get('never', '1:1')).toBeUndefined();
  });

  it('stays bounded, dropping the least recently used entry', () => {
    const memo = createStampMemo(2);
    memo.set('a', 's', 1);
    memo.set('b', 's', 2);
    memo.get('a', 's');       // touch a, so b is now the stale one
    memo.set('c', 's', 3);    // over the limit: b goes, not a
    expect(memo.size()).toBe(2);
    expect(memo.get('a', 's')).toBe(1);
    expect(memo.get('b', 's')).toBeUndefined();
    expect(memo.get('c', 's')).toBe(3);
  });

  it('overwrites in place rather than growing on re-set', () => {
    const memo = createStampMemo(2);
    memo.set('a', '1', 'old');
    memo.set('a', '2', 'new');
    expect(memo.size()).toBe(1);
    expect(memo.get('a', '1')).toBeUndefined();
    expect(memo.get('a', '2')).toBe('new');
  });
});

/**
 * detectCrop's cachedOnly contract: a remembered crop comes straight back, an
 * unmeasured file answers null without any detection starting. The renderer
 * leans on this to apply known crops instantly while deferring fresh ffmpeg
 * work past an episode's startup window.
 */
describe('detectCrop cachedOnly', () => {
  let dir = null;
  let mediaDir = null;

  afterEach(async () => {
    for (const d of [dir, mediaDir]) {
      if (d) await fsp.rm(d, { recursive: true, force: true }).catch(() => {});
    }
    dir = null;
    mediaDir = null;
  });

  const setup = async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ntv-crop-cache-'));
    mediaDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ntv-crop-media-'));
    setCacheDir(dir);
    const mediaPath = path.join(mediaDir, 'episode.mkv');
    await fsp.writeFile(mediaPath, Buffer.alloc(32));
    return mediaPath;
  };

  // Mirrors cacheKeyFor: absPath|size:mtime|tier, sha1-hexed. Duplicated on
  // purpose — if the key format changes, this test failing loudly is the
  // reminder that every existing crop cache entry just became unreachable.
  const cropKeyFor = async (absPath) => {
    const stat = await fsp.stat(absPath);
    const stamp = `${stat.size}:${Math.floor(stat.mtimeMs)}`;
    return crypto.createHash('sha1').update(`${absPath}|${stamp}|crop`).digest('hex');
  };

  it('answers null for an unmeasured file without detecting anything', async () => {
    const mediaPath = await setup();
    expect(await detectCrop(mediaPath, { cachedOnly: true })).toBeNull();
    // And it must not have created a cache entry as a side effect.
    expect((await fsp.readdir(dir)).filter((n) => n.endsWith('.crop.json'))).toEqual([]);
  });

  it('returns the remembered crop straight from the cache', async () => {
    const mediaPath = await setup();
    const crop = { fx: 0.125, fy: 0, fw: 0.75, fh: 1, worthCropping: true };
    const key = await cropKeyFor(mediaPath);
    await fsp.writeFile(path.join(dir, `${key}.crop.json`), JSON.stringify(crop), 'utf8');

    expect(await detectCrop(mediaPath, { cachedOnly: true })).toEqual(crop);
    // The full call serves the same cache hit — the reorder that made
    // cachedOnly possible must not have cost the normal path its cache.
    expect(await detectCrop(mediaPath)).toEqual(crop);
  });
});

/**
 * The pieces that only a REAL video can prove — generated on the spot with
 * ffmpeg's lavfi color source, so no fixture is checked in. Skipped cleanly
 * on a machine without ffmpeg; on this project's machines it is bundled.
 *
 * This is the deterministic pin the cachedOnly early-return was missing: on a
 * garbage file, deleting the guard still returns null (the probe fails), so
 * only a file detection genuinely SUCCEEDS on can tell the two apart — via
 * the .crop.json side effect detection writes and cachedOnly must not.
 */
describe('against a real generated video', () => {
  const ffmpeg = findFfmpeg();
  // Gated separately: a machine can hold a lone ffmpeg.exe and no ffprobe at
  // all (prepare.js models exactly that — findFfprobe has its own null path).
  // The tests that PROBE must skip there, not fail red.
  const ffprobe = findFfprobe();
  let dir = null;
  let mediaDir = null;

  afterEach(async () => {
    for (const d of [dir, mediaDir]) {
      if (d) await fsp.rm(d, { recursive: true, force: true }).catch(() => {});
    }
    dir = null;
    mediaDir = null;
  });

  const setup = async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ntv-real-cache-'));
    mediaDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ntv-real-media-'));
    setCacheDir(dir);
    const video = path.join(mediaDir, 'white.mp4');
    // Six seconds so the sample points (1s, 3s, 5s) all land inside the file;
    // solid white so cropdetect finds no bars and the answer is knowable.
    const made = spawnSync(ffmpeg, [
      '-y', '-f', 'lavfi', '-i', 'color=c=white:s=64x48:d=6:r=10',
      '-pix_fmt', 'yuv420p', video,
    ], { windowsHide: true, timeout: 30000 });
    if (made.error || made.status !== 0) throw new Error('fixture generation failed');
    return video;
  };

  it.skipIf(!ffmpeg)('cachedOnly answers null without starting a detection', async () => {
    const video = await setup();
    expect(await detectCrop(video, { cachedOnly: true })).toBeNull();
    // THE pin: a real detection on this file would have written its
    // .crop.json (the test below proves that). cachedOnly must not have.
    expect((await fsp.readdir(dir)).filter((n) => n.endsWith('.crop.json'))).toEqual([]);
  }, 60000);

  it.skipIf(!ffmpeg || !ffprobe)('full detection measures a bar-less frame and caches the answer', async () => {
    const video = await setup();
    const crop = await detectCrop(video);
    expect(crop).not.toBeNull();
    expect(crop.worthCropping).toBe(false);   // solid white: nothing to crop
    expect(crop.fw).toBeGreaterThan(0.95);
    expect(crop.fh).toBeGreaterThan(0.95);
    expect((await fsp.readdir(dir)).filter((n) => n.endsWith('.crop.json'))).toHaveLength(1);
  }, 60000);

  it.skipIf(!ffmpeg || !ffprobe)('the probe memo hands back the identical object for an unchanged file', async () => {
    const video = await setup();
    const first = await probeWithFfprobe(video);
    expect(first && first.ok).toBe(true);
    // Identity, not equality: the memo answered, no second spawn happened.
    expect(await probeWithFfprobe(video)).toBe(first);
  }, 60000);

  it.skipIf(!ffmpeg || !ffprobe)('a file swapped in place misses the memo and is probed afresh', async () => {
    // The memo's whole safety case — and it was the one property no test held
    // THROUGH probeWithFfprobe: a mutant serving a constant stamp passed every
    // other test here, while a file replaced in place would have served its
    // old track list, language and duration for the rest of the session.
    const video = await setup();
    const first = await probeWithFfprobe(video);
    expect(first && first.ok).toBe(true);

    // An in-place swap changes the mtime (and usually the size); an explicit
    // ten-second offset keeps the new stamp unambiguously different.
    const swapped = new Date(Date.now() - 10000);
    await fsp.utimes(video, swapped, swapped);

    const second = await probeWithFfprobe(video);
    expect(second && second.ok).toBe(true);
    expect(second).not.toBe(first);   // fresh probe, not the remembered object
  }, 60000);

  it('a failed probe is never remembered', async () => {
    // Runs with or without ffmpeg: either way the probe fails, and either way
    // remembering the failure would pin a transient error — a drive dropping
    // off mid-scan — for the rest of the session.
    mediaDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ntv-real-media-'));
    const garbage = path.join(mediaDir, 'garbage.mkv');
    await fsp.writeFile(garbage, Buffer.alloc(64));

    const before = probeMemoSize();
    // The pin is a size DELTA, and a delta is blind at capacity: a memo
    // already holding its 64-entry limit would evict one entry while the
    // mutant inserts the failure, leaving the size unchanged over the exact
    // mutation this exists to kill. Guard the precondition explicitly.
    expect(before).toBeLessThan(32);
    expect(await probeWithFfprobe(garbage)).toBeNull();
    expect(probeMemoSize()).toBe(before);
  }, 60000);
});
