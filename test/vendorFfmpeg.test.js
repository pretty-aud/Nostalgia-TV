import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { ffmpegCandidates } from '../electron/prepare.js';

/**
 * The installer ships ffmpeg inside the app, and the whole change rests on one
 * thing: the bundled copy has to WIN over whatever the machine already has.
 *
 * This cannot be checked by installing and looking. Every machine that could
 * run the check has ffmpeg on its PATH — the app finds one either way, and the
 * result is identical whether the bundled copy won, lost, or never shipped. Nor
 * can it be checked by planting a fake and calling findFfmpeg, because
 * candidates are proved by RUNNING `-version`, so the fake would have to be a
 * real working binary: either the 160MB payload that is deliberately not in
 * this repo, or a stand-in that has to answer `-version` with exit 0, which
 * node itself does not (it wants `-v`). That was the first attempt, and it
 * failed for that reason rather than for the reason under test — which is
 * exactly the kind of test that gets deleted later for being flaky.
 *
 * So the ORDER is asserted directly, with nothing spawned.
 */

const EXE = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
const RESOURCES = process.resourcesPath;

afterEach(() => {
  if (RESOURCES === undefined) delete process.resourcesPath;
  else process.resourcesPath = RESOURCES;
});

describe('where ffmpeg is looked for', () => {
  it('puts the bundled copy first', () => {
    process.resourcesPath = path.join('C:', 'app', 'resources');

    expect(ffmpegCandidates()[0]).toBe(path.join('C:', 'app', 'resources', 'ffmpeg', EXE));
  });

  it('puts it ahead of every PATH entry', () => {
    process.resourcesPath = path.join('C:', 'app', 'resources');
    const candidates = ffmpegCandidates();

    const bundled = candidates.findIndex((c) => c.startsWith(process.resourcesPath));
    const fromPath = candidates.findIndex((c) => !c.startsWith(process.resourcesPath));

    expect(bundled).toBeLessThan(fromPath);
  });

  it('still offers the system locations after it', () => {
    // The bundled path is the FIRST candidate, not the only one. An install
    // that lost its copy, and a dev run with no resourcesPath at all, both have
    // to keep working.
    process.resourcesPath = path.join('C:', 'app', 'resources');

    expect(ffmpegCandidates().length).toBeGreaterThan(2);
    expect(ffmpegCandidates()).toContain(EXE);
  });

  it('names no bundled path when the app is not packaged', () => {
    delete process.resourcesPath;

    expect(ffmpegCandidates().every((c) => c !== path.join('ffmpeg', EXE))).toBe(true);
    expect(ffmpegCandidates()).toContain(EXE);
  });
});
