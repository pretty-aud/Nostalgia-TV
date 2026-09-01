import { describe, it, expect, vi } from 'vitest';
import { createMpvHost, OBSERVED_PROPS } from '../electron/mpvHost.js';

/**
 * The host's decisions against a fake player: the observer registry, the
 * restart re-registration, and — the one that matters most — the path guard
 * on open. Every path-carrying IPC in this app refuses paths outside the
 * allowed roots, and the player must not be the exception that leaks one.
 */
function fakePlayer() {
  const observed = [];             // [{ name, handler }]
  const events = new Map();        // player-level: restarted/down
  const mpvEvents = [];            // [{ name, handler }]
  const commands = [];
  return {
    observed,
    commands,
    emit: (name, payload) => { for (const fn of events.get(name) || []) fn(payload); },
    pushProp: (name, value) => {
      for (const o of observed) if (o.name === name) o.handler(value);
    },
    observe: async (name, handler) => { observed.push({ name, handler }); return () => {}; },
    onMpvEvent: (name, handler) => { mpvEvents.push({ name, handler }); return () => {}; },
    mpvEvents,
    on: (name, handler) => {
      if (!events.has(name)) events.set(name, new Set());
      events.get(name).add(handler);
      return () => events.get(name).delete(handler);
    },
    command: (...args) => { commands.push(args); return Promise.resolve('ok'); },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('mpv host', () => {
  it('observes every property the facade mirrors and forwards values', async () => {
    const player = fakePlayer();
    const send = vi.fn();
    const host = createMpvHost({ player, send, isInsideAllowedRoot: () => true });
    await host.ready;

    expect(player.observed.map((o) => o.name)).toEqual(OBSERVED_PROPS);
    player.pushProp('time-pos', 12.5);
    expect(send).toHaveBeenCalledWith('mpv:prop', 'time-pos', 12.5);
    // undefined is normalised: structured-clone rejects it in some shapes,
    // and the facade treats null as "between files" already.
    player.pushProp('duration', undefined);
    expect(send).toHaveBeenCalledWith('mpv:prop', 'duration', null);
  });

  it('re-registers everything and tells the renderer after a restart', async () => {
    const player = fakePlayer();
    const send = vi.fn();
    const host = createMpvHost({ player, send, isInsideAllowedRoot: () => true });
    await host.ready;

    const before = player.observed.length;
    player.emit('restarted', {});
    await flush();

    // A fresh registration per property — the old ones died with the process.
    expect(player.observed.length).toBe(before * 2);
    expect(send).toHaveBeenCalledWith('mpv:restarted');
  });

  it('forwards the lifecycle events the facade\'s gate is built on', async () => {
    // start-file is the staleness gate's clock: if this forwarding loop
    // silently vanished, every per-file property would be dropped forever
    // and the player would look permanently frozen — with 464 green tests.
    const player = fakePlayer();
    const send = vi.fn();
    const host = createMpvHost({ player, send, isInsideAllowedRoot: () => true });
    await host.ready;

    expect(player.mpvEvents.map((e) => e.name)).toEqual(['start-file', 'end-file', 'file-loaded']);
    const startFile = player.mpvEvents.find((e) => e.name === 'start-file');
    startFile.handler({ event: 'start-file' });
    expect(send).toHaveBeenCalledWith('mpv:event', { event: 'start-file' });

    // And the registrations die with the process, so a restart re-makes them.
    player.emit('restarted', {});
    await flush();
    expect(player.mpvEvents.filter((e) => e.name === 'start-file').length).toBe(2);
  });

  it('refuses to open a path outside the allowed roots', async () => {
    const player = fakePlayer();
    const host = createMpvHost({
      player,
      send: vi.fn(),
      isInsideAllowedRoot: (p) => p.startsWith('H:\\TVandFilms'),
    });
    await host.ready;

    await expect(host.handlers['mpv:open'](null, 'C:\\Windows\\system32\\config\\SAM'))
      .rejects.toThrow('Forbidden');
    expect(player.commands.some(([cmd]) => cmd === 'loadfile')).toBe(false);

    // The control: an allowed path DOES load — the guard refuses, it does
    // not merely break everything equally.
    await host.handlers['mpv:open'](null, 'H:\\TVandFilms\\show\\ep1.mkv', {});
    expect(player.commands.some(([cmd]) => cmd === 'loadfile')).toBe(true);
  });

  it('carries start and pause IN the load, not as an after-the-fact seek', async () => {
    const player = fakePlayer();
    const host = createMpvHost({ player, send: vi.fn(), isInsideAllowedRoot: () => true });
    await host.ready;

    await host.handlers['mpv:open'](null, 'H:\\x.mkv', { startSeconds: 92.5, paused: true });
    const load = player.commands.find(([cmd]) => cmd === 'loadfile');
    expect(load[1]).toBe('H:\\x.mkv');
    expect(load[2]).toBe('replace');
    // The EXACT string, not substrings: mpv's option list is comma-joined,
    // and a wrong separator would carry both options yet apply neither.
    expect(load[load.length - 1]).toBe('start=92.500,pause=yes');
    // No separate seek command — the glitchy first-frame flash is the point.
    expect(player.commands.some(([cmd]) => cmd === 'seek')).toBe(false);

    // Without a start, no start option — a resume of 0 must not seek at all.
    player.commands.length = 0;
    await host.handlers['mpv:open'](null, 'H:\\y.mkv', { startSeconds: 0, paused: false });
    expect(player.commands.find(([cmd]) => cmd === 'loadfile').at(-1)).toBe('pause=no');
  });

  it('validates the typed setters instead of forwarding garbage', async () => {
    const player = fakePlayer();
    const host = createMpvHost({ player, send: vi.fn(), isInsideAllowedRoot: () => true });
    await host.ready;

    await expect(host.handlers['mpv:seek'](null, NaN)).rejects.toThrow('Bad seek');
    await expect(host.handlers['mpv:setVolume'](null, 'loud')).rejects.toThrow('Bad volume');
    await expect(host.handlers['mpv:setAudioTrack'](null, 1.5)).rejects.toThrow('Bad track');
    await expect(host.handlers['mpv:setSubTrack'](null, {})).rejects.toThrow('Bad track');
    expect(player.commands.length).toBe(0);

    await host.handlers['mpv:setVolume'](null, 250);
    expect(player.commands).toContainEqual(['set_property', 'volume', 100]); // clamped high
    await host.handlers['mpv:setVolume'](null, -40);
    expect(player.commands).toContainEqual(['set_property', 'volume', 0]);   // clamped low
    await host.handlers['mpv:setAudioTrack'](null, 2);
    expect(player.commands).toContainEqual(['set_property', 'aid', 2]);
    await host.handlers['mpv:setSubTrack'](null, 'no');
    expect(player.commands).toContainEqual(['set_property', 'sid', 'no']);
  });

  it('dispose stops the property stream AND the event stream', async () => {
    const player = fakePlayer();
    const send = vi.fn();
    const host = createMpvHost({ player, send, isInsideAllowedRoot: () => true });
    await host.ready;

    host.dispose();
    send.mockClear();
    player.pushProp('time-pos', 99);
    player.mpvEvents.find((e) => e.name === 'end-file').handler({ event: 'end-file' });
    expect(send).not.toHaveBeenCalled();
  });

  it('forwards died immediately and attaches event handlers before any observe await', async () => {
    const player = fakePlayer();
    const send = vi.fn();
    // observe() that never resolves: the events must be attached anyway,
    // because a renderer command can reach the fresh process the moment the
    // player swaps it in — a start-file with no listener jams the gate.
    player.observe = () => new Promise(() => {});
    const host = createMpvHost({ player, send, isInsideAllowedRoot: () => true });
    await Promise.race([host.ready, flush()]);

    expect(player.mpvEvents.map((e) => e.name)).toContain('start-file');

    player.emit('died', { code: 1 });
    expect(send).toHaveBeenCalledWith('mpv:died');
  });

  it('open carries the start threshold correctly at its edges', async () => {
    const player = fakePlayer();
    const host = createMpvHost({ player, send: vi.fn(), isInsideAllowedRoot: () => true });
    await host.ready;

    await host.handlers['mpv:open'](null, 'H:\\a.mkv', { startSeconds: 0.5 });
    expect(player.commands.find(([c]) => c === 'loadfile').at(-1)).toBe('start=0.500,pause=no');

    player.commands.length = 0;
    await host.handlers['mpv:open'](null, 'H:\\b.mkv', { startSeconds: -3 });
    expect(player.commands.find(([c]) => c === 'loadfile').at(-1)).toBe('pause=no');
  });
});
