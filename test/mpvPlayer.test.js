import { describe, it, expect } from 'vitest';
import { mpvArgsFor, nextRestartDelay } from '../electron/mpvPlayer.js';

/**
 * The argument contract IS the embedding design — each flag below earned its
 * place in the proof harness or a session's finding, and losing one is a
 * regression nothing else would catch until a viewer hit it.
 */
describe('mpvArgsFor', () => {
  const args = mpvArgsFor({ hwnd: '12345', pipeName: '\\\\.\\pipe\\p', logFile: 'C:/log.txt' });

  it('renders into the given window, never one of its own', () => {
    expect(args).toContain('--wid=12345');
  });

  it('serves IPC on the given pipe', () => {
    expect(args).toContain('--input-ipc-server=\\\\.\\pipe\\p');
  });

  it('ignores any mpv.conf on the machine', () => {
    // A user-level config restyling subtitles or forcing a video filter
    // would be indistinguishable from an app bug on exactly one machine.
    expect(args).toContain('--no-config');
  });

  it('contributes decoding only — every control surface is ours', () => {
    expect(args).toContain('--no-osc');
    expect(args).toContain('--no-input-default-bindings');
    expect(args).toContain('--input-vo-keyboard=no');
  });

  it('exists before the first file and survives between files', () => {
    expect(args).toContain('--force-window=yes');
    expect(args).toContain('--idle=yes');
  });

  it('holds the last frame at EOF instead of going black', () => {
    // Transitions are the app's decision; the bridge reads `eof-reached`.
    expect(args).toContain('--keep-open=yes');
  });

  it('logs to the given file, and omits logging when none is given', () => {
    expect(args).toContain('--log-file=C:/log.txt');
    expect(mpvArgsFor({ hwnd: '1', pipeName: 'p' }).join(' ')).not.toContain('--log-file');
  });
});

/**
 * The restart policy: absorb a transient, refuse a crash loop.
 */
describe('nextRestartDelay', () => {
  const MIN = 60 * 1000;

  it('restarts a first death quickly', () => {
    expect(nextRestartDelay([Date.now()], Date.now())).toBe(250);
  });

  it('escalates the delay as deaths accumulate', () => {
    const now = 1_000_000_000;
    const exits = [now - 50000, now - 40000, now - 30000, now - 20000, now];
    expect(nextRestartDelay(exits, now)).toBe(15000);
  });

  it('gives up on a crash loop instead of pegging the machine', () => {
    const now = 1_000_000_000;
    const exits = [now - 50000, now - 40000, now - 30000, now - 20000, now - 10000, now];
    expect(nextRestartDelay(exits, now)).toBeNull();
  });

  it('forgets exits older than the window — an evening with hiccups is not a loop', () => {
    const now = 1_000_000_000;
    // Four old deaths across the evening, all outside the 2-minute window:
    // only the current one counts, so this restarts at the first rung.
    const exits = [now - 90 * MIN, now - 60 * MIN, now - 30 * MIN, now - 5 * MIN, now];
    expect(nextRestartDelay(exits, now)).toBe(250);
  });
});
