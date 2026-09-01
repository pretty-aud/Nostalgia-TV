'use strict';

/**
 * The main-process side of the bridge: mpv's property stream out to the
 * renderer, a TYPED command surface back in.
 *
 * Deliberately not a raw command pipe. Every path-carrying IPC in this app
 * is guarded by isInsideAllowedRoot, and the player is no exception — a
 * typed surface means each verb validates its own arguments, the same
 * posture as every prepare:* handler. Raw mpv commands stay main-internal.
 *
 * The host owns the OBSERVER REGISTRY. Observers die with the mpv process,
 * so on the player's 'restarted' event the host re-registers every property
 * itself, then tells the renderer — whose bridge re-applies the state IT
 * owns (file, position, pause, sound). Two owners, two restorations, no
 * overlap.
 *
 * Injection-first: the caller hands in `player`, `send` (the overlay's
 * webContents.send) and the path guard, and receives named handlers to
 * register on ipcMain. That keeps every decision here testable against a
 * fake player — the spawning real thing is the proof harness's job.
 */

/** The properties the renderer's facade mirrors. */
const OBSERVED_PROPS = ['time-pos', 'duration', 'pause', 'eof-reached', 'dwidth', 'dheight'];

/**
 * mpv events the facade interprets. `start-file` is load-bearing: exactly
 * one per loadfile, in pipe order — it is the clock of the facade's
 * staleness gate, the thing that separates a replaced file's queued
 * properties from the new file's real ones.
 */
const FORWARDED_EVENTS = ['start-file', 'end-file', 'file-loaded'];

function createMpvHost({ player, send, isInsideAllowedRoot }) {
  let disposed = false;

  async function registerObservers() {
    /**
     * Events FIRST, and synchronously: `start-file` is the staleness gate's
     * clock, and from the instant the player swaps in a live client a
     * renderer command can reach mpv. Attaching events before the first
     * await means no command can slip through while its start-file has no
     * listener — the jam that froze the gate permanently. The observes may
     * then take their round-trips.
     */
    for (const name of FORWARDED_EVENTS) {
      player.onMpvEvent(name, (event) => {
        if (!disposed) send('mpv:event', event);
      });
    }
    for (const name of OBSERVED_PROPS) {
      // Fire-and-forget failures: a property that cannot be observed on this
      // mpv build should not take the other five down with it.
      await player.observe(name, (value) => {
        if (!disposed) send('mpv:prop', name, value === undefined ? null : value);
      }).catch(() => {});
    }
  }

  const offRestarted = player.on('restarted', async () => {
    await registerObservers();
    if (!disposed) send('mpv:restarted');
  });
  const offDied = player.on('died', () => {
    // Forwarded IMMEDIATELY, before any respawn work: the bridge suspends
    // its mirrors on this signal so a fresh process's default-state reports
    // can never overwrite what the viewer had chosen.
    if (!disposed) send('mpv:died');
  });
  const offDown = player.on('down', (info) => {
    if (!disposed) send('mpv:down', info);
  });

  const ready = registerObservers();

  /**
   * loadfile with its start/pause carried IN the load, not seeked after —
   * an after-the-fact seek shows the first frame for a beat before jumping,
   * which reads as a glitch at the start of every resumed episode.
   */
  function open(absPath, options = {}) {
    if (typeof absPath !== 'string' || !isInsideAllowedRoot(absPath)) {
      return Promise.reject(new Error('Forbidden'));
    }
    const parts = [];
    const start = Number(options.startSeconds);
    if (Number.isFinite(start) && start > 0) parts.push(`start=${start.toFixed(3)}`);
    parts.push(`pause=${options.paused ? 'yes' : 'no'}`);
    return player.command('loadfile', absPath, 'replace', 0, parts.join(','));
  }

  const handlers = {
    'mpv:open': (_event, absPath, options) => open(absPath, options || {}),
    'mpv:stop': () => player.command('stop'),
    'mpv:setPause': (_event, value) => player.command('set_property', 'pause', Boolean(value)),
    'mpv:seek': (_event, seconds) => {
      if (!Number.isFinite(seconds) || seconds < 0) return Promise.reject(new Error('Bad seek'));
      return player.command('seek', seconds, 'absolute');
    },
    'mpv:setVolume': (_event, level) => {
      if (!Number.isFinite(level)) return Promise.reject(new Error('Bad volume'));
      return player.command('set_property', 'volume', Math.min(100, Math.max(0, level)));
    },
    'mpv:setMute': (_event, value) => player.command('set_property', 'mute', Boolean(value)),
    /**
     * Track selection, ahead of the features step: an integer id from mpv's
     * own track-list, or the two strings mpv defines. Anything else refused.
     */
    'mpv:setAudioTrack': (_event, aid) => {
      if (!Number.isInteger(aid) && aid !== 'auto' && aid !== 'no') return Promise.reject(new Error('Bad track'));
      return player.command('set_property', 'aid', aid);
    },
    'mpv:setSubTrack': (_event, sid) => {
      if (!Number.isInteger(sid) && sid !== 'auto' && sid !== 'no') return Promise.reject(new Error('Bad track'));
      return player.command('set_property', 'sid', sid);
    },
    'mpv:trackList': () => player.command('get_property', 'track-list'),
  };

  return {
    handlers,
    ready,
    dispose: () => {
      disposed = true;
      offRestarted();
      offDied();
      offDown();
    },
  };
}

module.exports = { createMpvHost, OBSERVED_PROPS };
