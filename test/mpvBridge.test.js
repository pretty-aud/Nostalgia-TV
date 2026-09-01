import { describe, it, expect, vi } from 'vitest';
import { createMpvFacade, TIMEUPDATE_MIN_INTERVAL_MS } from '../src/renderer/mpvBridge.js';

/**
 * The facade's mapping decisions, exercised through a fake tv surface that
 * records the typed IPC and lets tests push the property stream by hand.
 * These mappings are contracts the whole renderer leans on — a wrong 'ended'
 * double-advances the queue, a missed one strands the channel.
 *
 * The stream helpers mimic mpv's REAL ordering: every load begins with a
 * start-file event, and properties for a file arrive after its start-file.
 * The staleness tests violate that ordering the way IPC latency does —
 * old-file messages delivered after the renderer already opened the next.
 */
function fakeTv() {
  const calls = [];
  let pushProp = null;
  let pushEvent = null;
  let pushRestarted = null;
  let pushDied = null;
  let pushDown = null;
  const record = (name) => (...args) => { calls.push([name, ...args]); return Promise.resolve(); };
  return {
    calls,
    prop: (n, v) => pushProp(n, v),
    event: (e) => pushEvent(e),
    startFile: () => pushEvent({ event: 'start-file' }),
    restarted: () => pushRestarted(),
    died: () => pushDied(),
    down: () => pushDown({}),
    onMpvProp: (fn) => { pushProp = fn; return () => {}; },
    onMpvEvent: (fn) => { pushEvent = fn; return () => {}; },
    onMpvRestarted: (fn) => { pushRestarted = fn; return () => {}; },
    onMpvDied: (fn) => { pushDied = fn; return () => {}; },
    onMpvDown: (fn) => { pushDown = fn; return () => {}; },
    mpvOpen: record('open'),
    mpvStop: record('stop'),
    mpvSetPause: record('setPause'),
    mpvSeek: record('seek'),
    mpvSetVolume: record('setVolume'),
    mpvSetMute: record('setMute'),
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Open and let mpv 'begin' the file, the way a healthy load unfolds. */
async function openStarted(facade, tv, absPath, options) {
  await facade.open(absPath, options);
  tv.startFile();
}

describe('mpv facade', () => {
  it("emits 'ended' on the eof rising edge, once, and never for the next file's start", async () => {
    const tv = fakeTv();
    const facade = createMpvFacade(tv);
    const ended = vi.fn();
    facade.addEventListener('ended', ended);

    await openStarted(facade, tv, 'H:/a.mkv');
    tv.prop('eof-reached', false);
    expect(ended).not.toHaveBeenCalled();
    tv.prop('eof-reached', true);
    tv.prop('eof-reached', true);      // keep-open re-reports; must not re-fire
    expect(ended).toHaveBeenCalledTimes(1);
    expect(facade.ended).toBe(true);

    await openStarted(facade, tv, 'H:/b.mkv');
    expect(facade.ended).toBe(false);
    tv.prop('eof-reached', true);
    expect(ended).toHaveBeenCalledTimes(2);
  });

  it("THE BOUNDARY BUG: a stale eof from the replaced file must not end the new one", async () => {
    // File A reaches EOF at the exact moment the next open() runs: mpv's
    // eof-reached=true is already queued in IPC when the renderer resets the
    // latch. Ungated, that fired 'ended' for B the moment it opened — the
    // queue double-advanced, the bumper was cut, and Resume broke for the
    // whole episode. The start-file gate drops everything queued before the
    // new file actually begins.
    const tv = fakeTv();
    const facade = createMpvFacade(tv);
    const ended = vi.fn();
    facade.addEventListener('ended', ended);

    await openStarted(facade, tv, 'H:/a.mkv');
    await facade.open('H:/b.mkv');      // B dispatched; its start-file not yet arrived
    tv.prop('eof-reached', true);       // A's stale eof, delivered late
    expect(ended).not.toHaveBeenCalled();
    expect(facade.ended).toBe(false);

    tv.startFile();                      // B actually begins
    tv.prop('eof-reached', true);        // B's own eof, much later
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it('a stale duration cannot satisfy the new open\'s loadedmetadata latch', async () => {
    // The once-per-open 'loadedmetadata' is what the resume seek and the
    // clip watchdog wait for; a 22-minute duration attributed to a 15-second
    // bumper bounds a stalled clip with the wrong file's length.
    const tv = fakeTv();
    const facade = createMpvFacade(tv);
    const meta = vi.fn();
    facade.addEventListener('loadedmetadata', meta);

    await openStarted(facade, tv, 'H:/episode.mkv');
    await facade.open('H:/bumper.mp4');
    tv.prop('duration', 1441.5);        // the EPISODE's late refinement
    expect(meta).not.toHaveBeenCalled();
    expect(Number.isNaN(facade.duration)).toBe(true);

    tv.startFile();
    tv.prop('duration', 15.2);          // the bumper's real length
    expect(meta).toHaveBeenCalledTimes(1);
    expect(facade.duration).toBeCloseTo(15.2);
  });

  it('a stale time-pos cannot stamp the new file\'s mirror (the resume poison)', async () => {
    // onTimeUpdate persists currentTime as the episode's resume point every
    // five seconds — the OLD file's final position landing on the NEW mirror
    // would be saved as the new episode's progress.
    const tv = fakeTv();
    const facade = createMpvFacade(tv);

    await openStarted(facade, tv, 'H:/a.mkv');
    await facade.open('H:/b.mkv', { startSeconds: 0 });
    tv.prop('time-pos', 1380.7);        // A's final position, delivered late
    expect(facade.currentTime).toBe(0);

    tv.startFile();
    tv.prop('time-pos', 2.5);
    expect(facade.currentTime).toBe(2.5);
  });

  it('a replaced file failing to load is not OUR file failing', async () => {
    const tv = fakeTv();
    const facade = createMpvFacade(tv);
    const errored = vi.fn();
    facade.addEventListener('error', errored);

    await openStarted(facade, tv, 'H:/a.mkv');
    await facade.open('H:/b.mkv');
    tv.event({ event: 'end-file', reason: 'error', file_error: 'stale failure from A' });
    expect(errored).not.toHaveBeenCalled();

    tv.startFile();
    tv.event({ event: 'end-file', reason: 'error', file_error: 'unrecognized format' });
    expect(errored).toHaveBeenCalledTimes(1);
    expect(facade.error.message).toContain('unrecognized');

    await openStarted(facade, tv, 'H:/fine.mkv');
    expect(facade.error).toBeNull();
    tv.event({ event: 'end-file', reason: 'stop' });   // ordinary unload
    expect(errored).toHaveBeenCalledTimes(1);
  });

  it('two rapid opens gate out the middle file\'s entire stream', async () => {
    const tv = fakeTv();
    const facade = createMpvFacade(tv);
    const meta = vi.fn();
    facade.addEventListener('loadedmetadata', meta);

    await facade.open('H:/b.mkv');
    await facade.open('H:/c.mkv');       // replaces B before it began
    tv.startFile();                      // B's begin
    tv.prop('duration', 99);             // B's stream: still one load pending
    expect(meta).not.toHaveBeenCalled();
    tv.startFile();                      // C's begin
    tv.prop('duration', 42);
    expect(meta).toHaveBeenCalledTimes(1);
    expect(facade.duration).toBe(42);
  });

  it('throttles timeupdate to exactly the media-element rhythm', () => {
    let clock = 0;
    const tv = fakeTv();
    const facade = createMpvFacade(tv, { now: () => clock });
    const ticks = vi.fn();
    facade.addEventListener('timeupdate', ticks);

    facade.open('H:/a.mkv');
    tv.startFile();
    // mpv reports every 33ms for a simulated second; the element's rhythm
    // admits one tick per full throttle interval — exactly three of these.
    for (let i = 1; i <= 30; i += 1) {
      clock = i * 33;
      tv.prop('time-pos', i * 0.033);
    }
    expect(TIMEUPDATE_MIN_INTERVAL_MS).toBe(250);
    expect(ticks).toHaveBeenCalledTimes(3);   // at 264, 528, 792 ms
    expect(facade.currentTime).toBeCloseTo(30 * 0.033);
  });

  it("mirrors pause edges as 'play'/'pause' events", async () => {
    const tv = fakeTv();
    const facade = createMpvFacade(tv);
    const played = vi.fn();
    const paused = vi.fn();
    facade.addEventListener('play', played);
    facade.addEventListener('pause', paused);

    await openStarted(facade, tv, 'H:/a.mkv');   // open(paused:false): play edge
    tv.prop('pause', false);           // confirmation, no edge
    tv.prop('pause', true);
    expect(played).toHaveBeenCalledTimes(1);
    expect(paused).toHaveBeenCalledTimes(1);
    expect(facade.paused).toBe(true);
  });

  it('play() flips paused SYNCHRONOUSLY, like the element — double-press safe', async () => {
    // togglePlay reads player.paused right back; a mirror that waits for the
    // observed confirmation makes the second press re-issue play and the
    // button feel dead.
    const tv = fakeTv();
    const facade = createMpvFacade(tv);
    await openStarted(facade, tv, 'H:/a.mkv', { paused: true });

    expect(facade.paused).toBe(true);
    facade.play();
    expect(facade.paused).toBe(false);   // before any observed property
    facade.pause();
    expect(facade.paused).toBe(true);
    expect(tv.calls.filter(([n]) => n === 'setPause')).toEqual([['setPause', false], ['setPause', true]]);
  });

  it('setting currentTime seeks and reads back the target immediately', () => {
    const tv = fakeTv();
    const facade = createMpvFacade(tv);
    facade.currentTime = 321.5;
    expect(facade.currentTime).toBe(321.5);
    expect(tv.calls).toContainEqual(['seek', 321.5]);
    facade.currentTime = NaN;            // garbage ignored, as the element did
    expect(facade.currentTime).toBe(321.5);
  });

  it('volume converts element scale to mpv percent; mute mirrors', () => {
    const tv = fakeTv();
    const facade = createMpvFacade(tv);
    facade.volume = 0.6;
    facade.muted = true;
    expect(tv.calls).toContainEqual(['setVolume', 60]);
    expect(tv.calls).toContainEqual(['setMute', true]);
    expect(facade.volume).toBe(0.6);
    expect(facade.muted).toBe(true);
  });

  it('honours once-listeners, and removeEventListener detaches even an unfired once', async () => {
    const tv = fakeTv();
    const facade = createMpvFacade(tv);
    const once = vi.fn();
    const unfired = vi.fn();
    const permanent = vi.fn();
    facade.addEventListener('play', once, { once: true });
    facade.addEventListener('play', permanent);
    facade.addEventListener('pause', unfired, { once: true });
    // Detaching by the ORIGINAL function must find the once-wrapper too —
    // playClip tears its listeners down by the function it registered.
    facade.removeEventListener('pause', unfired);

    await openStarted(facade, tv, 'H:/a.mkv');   // play edge
    tv.prop('pause', true);                      // pause edge
    tv.prop('pause', false);                     // play edge again
    expect(once).toHaveBeenCalledTimes(1);
    expect(permanent).toHaveBeenCalledTimes(2);
    expect(unfired).not.toHaveBeenCalled();

    facade.removeEventListener('play', permanent);
    tv.prop('pause', true);
    tv.prop('pause', false);
    expect(permanent).toHaveBeenCalledTimes(2);
  });

  it('after a crash restart, restores file, position, INTENDED pause state and sound', async () => {
    const tv = fakeTv();
    const facade = createMpvFacade(tv);
    await openStarted(facade, tv, 'H:/episode.mkv');
    tv.prop('time-pos', 754.2);
    facade.pause();                      // the viewer paused, then mpv died
    facade.volume = 0.8;

    // The fresh process announces its defaults BEFORE the restore runs —
    // the exact report that used to clobber the mirror and un-pause her.
    tv.prop('pause', false);

    tv.calls.length = 0;
    tv.restarted();
    await flush();

    expect(tv.calls).toContainEqual(['setVolume', 80]);
    expect(tv.calls).toContainEqual(['setMute', false]);
    const reopen = tv.calls.find(([name]) => name === 'open');
    expect(reopen[1]).toBe('H:/episode.mkv');
    expect(reopen[2].startSeconds).toBeCloseTo(754.2);
    expect(reopen[2].paused).toBe(true);   // intended, not the fresh default
  });

  it('does not resurrect a FINISHED file after a restart', async () => {
    const tv = fakeTv();
    const facade = createMpvFacade(tv);
    await openStarted(facade, tv, 'H:/episode.mkv');
    tv.prop('eof-reached', true);

    tv.calls.length = 0;
    tv.restarted();
    await flush();
    expect(tv.calls.some(([name]) => name === 'open')).toBe(false);
  });

  it('a user open racing the crash restore wins — no duplicate loadfile', async () => {
    const tv = fakeTv();
    // Make the restore's volume call slow enough for the user to act inside it.
    let releaseVolume;
    tv.mpvSetVolume = () => new Promise((resolve) => { releaseVolume = resolve; });
    const facade = createMpvFacade(tv);
    await openStarted(facade, tv, 'H:/old.mkv');
    tv.prop('time-pos', 300);

    tv.restarted();               // restore begins, parked on setVolume
    await facade.open('H:/new.mkv');
    tv.calls.length = 0;
    releaseVolume();
    await flush();
    // The restore noticed the world moved on and did not reopen the old file.
    expect(tv.calls.some(([name]) => name === 'open')).toBe(false);
  });

  it('a crash with a load IN FLIGHT cannot jam the gate: restart resets it', async () => {
    // open() ran, mpv died before its start-file was ever delivered. The
    // orphaned increment would gate every property forever — no timeupdate,
    // no ended, a channel that looks alive and saves nothing. The restart
    // resets the gate (FIFO: the dead process's stragglers all arrived
    // before mpv:restarted), and the restore's own load re-arms it cleanly.
    const tv = fakeTv();
    const facade = createMpvFacade(tv);
    await facade.open('H:/ep.mkv');       // in flight: no start-file yet
    tv.died();
    tv.restarted();
    await flush();

    tv.startFile();                        // the RESTORE's load beginning
    tv.prop('duration', 1300);
    tv.prop('time-pos', 3.2);
    expect(facade.duration).toBe(1300);
    expect(facade.currentTime).toBe(3.2);
  });

  it('an open the command channel REFUSES unwinds its increment', async () => {
    // Pressing Next during a restart backoff: "mpv is not running". The
    // refused load will never emit start-file, so its increment must not
    // outlive the rejection — one keypress must not freeze the player.
    const tv = fakeTv();
    let refuse = true;
    tv.mpvOpen = () => (refuse
      ? Promise.reject(new Error('mpv is not running'))
      : Promise.resolve());
    const facade = createMpvFacade(tv);

    await expect(facade.open('H:/a.mkv')).rejects.toThrow('not running');

    refuse = false;
    await facade.open('H:/b.mkv');
    tv.startFile();                        // exactly one pending: B's own
    tv.prop('duration', 90);
    expect(facade.duration).toBe(90);
  });

  it('suspends the mirrors between death and restore — fresh defaults are not choices', async () => {
    const tv = fakeTv();
    const facade = createMpvFacade(tv);
    const played = vi.fn();
    facade.addEventListener('play', played);
    await openStarted(facade, tv, 'H:/ep.mkv', { paused: true });

    tv.died();
    tv.prop('pause', false);               // the fresh process's DEFAULT
    expect(facade.paused).toBe(true);      // the viewer paused; that stands
    expect(played).not.toHaveBeenCalled();

    tv.restarted();
    await flush();
    const reopen = tv.calls.find(([name]) => name === 'open');
    expect(reopen[2].paused).toBe(true);
  });

  it('open(paused:true) alone sets the INTENDED pause a crash restore uses', async () => {
    // No explicit pause() ever ran — the open carried the intention, and
    // the restore must honour it rather than the default.
    const tv = fakeTv();
    const facade = createMpvFacade(tv);
    await openStarted(facade, tv, 'H:/ep.mkv', { paused: true });
    tv.prop('time-pos', 42);

    tv.died();
    tv.restarted();
    await flush();
    expect(tv.calls.find(([name]) => name === 'open')[2].paused).toBe(true);
  });

  it('stop() closes the file context: later props belong to nothing', async () => {
    const tv = fakeTv();
    const facade = createMpvFacade(tv);
    const ended = vi.fn();
    facade.addEventListener('ended', ended);
    await openStarted(facade, tv, 'H:/ep.mkv');

    await facade.stop();
    tv.prop('eof-reached', true);          // the stopping file's last gasp
    expect(ended).not.toHaveBeenCalled();
    expect(facade.src).toBe('');

    await openStarted(facade, tv, 'H:/next.mkv');
    tv.prop('duration', 60);
    expect(facade.duration).toBe(60);      // a fresh open fully re-arms
  });

  it('a spurious start-file cannot push the gate negative', async () => {
    const tv = fakeTv();
    const facade = createMpvFacade(tv);
    tv.startFile();                        // nothing pending: must clamp, not go to -1
    await facade.open('H:/a.mkv');
    tv.prop('duration', 50);               // still pending: must be gated
    expect(Number.isNaN(facade.duration)).toBe(true);
    tv.startFile();
    tv.prop('duration', 50);
    expect(facade.duration).toBe(50);
  });

  it("surfaces the restart policy giving up as 'error', not a frozen frame", async () => {
    const tv = fakeTv();
    const facade = createMpvFacade(tv);
    const errored = vi.fn();
    facade.addEventListener('error', errored);
    await openStarted(facade, tv, 'H:/a.mkv');

    tv.down();
    expect(errored).toHaveBeenCalledTimes(1);
    expect(facade.error.message).toContain('could not be restarted');
  });

  it('exposes src and the inert element shims the un-rewired call sites touch', async () => {
    const tv = fakeTv();
    const facade = createMpvFacade(tv);
    expect(facade.src).toBe('');
    await openStarted(facade, tv, 'H:/a.mkv');
    expect(facade.src).toBe('H:/a.mkv');

    // Inert, not faked: these exist so applyPicture/clearSubtitles degrade
    // to no-ops until the features step rewires them, instead of throwing.
    facade.style.transform = 'scale(2)';
    expect(facade.getBoundingClientRect().width).toBe(0);
    expect(facade.querySelectorAll('track')).toEqual([]);
    expect(() => facade.append()).not.toThrow();
    expect(facade.textTracks).toEqual([]);
    expect(facade.buffered.length).toBe(0);
  });
});
