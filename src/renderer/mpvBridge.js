/**
 * mpv, wearing the <video> element's face.
 *
 * The renderer was written against a media element: permanent 'ended' and
 * 'timeupdate' listeners wired once at boot, `player.currentTime` read for
 * saves and written for seeks, `paused` consulted by the transport. That
 * architecture is load-bearing — the silent-save incident zone lives
 * downstream of these events — so the player changes and the SHAPE stays.
 *
 * THE STALENESS GATE, which everything else here leans on:
 *
 * The property stream and the command channel are not synchronised — a
 * property emitted for the OLD file can be queued in IPC while open() has
 * already reset the mirrors for the new one. Ungated, a stale eof-reached
 * fires 'ended' for a file that just opened and the queue double-advances
 * (the exact boundary bug the element never had: its load algorithm cancels
 * the old resource's pending events). The element's guarantee is rebuilt
 * from mpv's own ordering: the pipe is FIFO end to end, and every loadfile
 * begins with exactly one `start-file` event — so open() increments
 * `pendingLoads`, `start-file` decrements it, and every per-file message
 * that arrives while a load is pending belongs to a replaced file and is
 * dropped. Two rapid opens leave the middle file's entire stream gated out.
 *
 * Other mapping decisions that are contracts:
 *  - `--keep-open=yes`: EOF holds the last frame, so 'ended' is the
 *    `eof-reached` property's rising edge, once per open — never end-file,
 *    which fires on unload/replace and would double-advance.
 *  - 'timeupdate' is throttled to the media element's ~4 Hz rhythm; every
 *    downstream consumer (labels, the 5-second save gate) was tuned to it.
 *  - play()/pause()/open() update the mirrors OPTIMISTICALLY and emit their
 *    edge synchronously, exactly as the element flips `paused` during the
 *    play() call — togglePlay double-presses depend on it.
 *  - `intended` records what the VIEWER asked for (pause state, sound) and
 *    is written only by user-facing calls, never by observed properties —
 *    it is what a crash restore restores, so a fresh mpv's default
 *    pause=false report can never un-pause a paused viewer.
 *  - After 'mpv:restarted' the bridge restores file/position/pause/sound,
 *    epoch-guarded so a user-initiated open() racing the restore wins.
 */

const TIMEUPDATE_MIN_INTERVAL_MS = 250;

export function createMpvFacade(tv, { now = () => Date.now() } = {}) {
  const listeners = new Map(); // event -> Set<fn>

  const state = {
    absPath: null,
    currentTime: 0,
    duration: NaN,
    paused: true,
    ended: false,
    error: null,
    videoWidth: 0,
    videoHeight: 0,
    codedWidth: 0,
    codedHeight: 0,
  };

  /** What the viewer asked for; observed properties never write this. */
  const intended = { paused: true, volume: 1, muted: false };

  let pendingLoads = 0;
  let openGen = 0;
  let metadataAnnounced = false;
  let lastTimeupdateAt = 0;

  /**
   * True from the moment mpv dies ('mpv:died') until the restart restore
   * has run. Everything the stream says in between is a dead process's
   * stragglers or a fresh process announcing its DEFAULTS — pause=false,
   * volume=100 — and none of it is the viewer's choice. The mirrors hold
   * their last honest values until the restore re-asserts them.
   */
  let suspended = false;

  function emit(name, payload) {
    const set = listeners.get(name);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(payload); } catch (error) { console.error(`mpv facade '${name}' listener:`, error); }
    }
  }

  function setPausedMirror(paused) {
    if (paused === state.paused) return;
    state.paused = paused;
    emit(paused ? 'pause' : 'play');
  }

  /** Are per-file messages currently attributable to the open file? */
  function propsLive() {
    return !suspended && pendingLoads === 0 && state.absPath !== null;
  }

  // -- the property stream --------------------------------------------------

  function onProp(name, value) {
    if (!propsLive()) return;   // a replaced file's stream, still draining

    if (name === 'time-pos') {
      if (typeof value !== 'number') return;   // null between files
      state.currentTime = value;
      const at = now();
      if (at - lastTimeupdateAt >= TIMEUPDATE_MIN_INTERVAL_MS) {
        lastTimeupdateAt = at;
        emit('timeupdate');
      }
      return;
    }
    if (name === 'duration') {
      if (typeof value !== 'number' || !(value > 0)) return;
      state.duration = value;
      if (!metadataAnnounced) {
        metadataAnnounced = true;
        emit('loadedmetadata');
      }
      return;
    }
    if (name === 'pause') {
      setPausedMirror(Boolean(value));
      return;
    }
    if (name === 'eof-reached') {
      // Rising edge only, once per open: keep-open holds the frame, so this
      // property IS the element's 'ended' moment.
      if (value === true && !state.ended) {
        state.ended = true;
        emit('ended');
      }
      return;
    }
    if (name === 'dwidth' && typeof value === 'number') { state.videoWidth = value; return; }
    if (name === 'dheight' && typeof value === 'number') { state.videoHeight = value; return; }
    // The CODED frame, which video-crop's pixel box addresses; the display
    // pair above serves layout, and on anamorphic files the two DIFFER.
    if (name === 'width' && typeof value === 'number') { state.codedWidth = value; return; }
    if (name === 'height' && typeof value === 'number') { state.codedHeight = value; }
  }

  function onMpvEvent(event) {
    if (!event) return;
    if (event.event === 'start-file') {
      // One per loadfile, in pipe order: the gate's clock.
      if (pendingLoads > 0) pendingLoads -= 1;
      return;
    }
    if (event.event === 'end-file' && event.reason === 'error') {
      if (!propsLive()) return;   // a replaced file failing is not our file failing
      // A file mpv cannot open or decode: the element's 'error'. The queue's
      // error path skips the item, exactly as it did for a bad <video> src.
      state.error = { message: event.file_error || 'playback failed' };
      emit('error');
    }
  }

  function doOpen(absPath, { startSeconds = 0, paused = false } = {}) {
    openGen += 1;
    pendingLoads += 1;
    state.absPath = absPath;
    state.ended = false;
    state.error = null;
    state.duration = NaN;
    state.currentTime = startSeconds;
    state.videoWidth = 0;
    state.videoHeight = 0;
    state.codedWidth = 0;
    state.codedHeight = 0;
    metadataAnnounced = false;
    setPausedMirror(Boolean(paused));
    return tv.mpvOpen(absPath, { startSeconds, paused }).catch((error) => {
      /**
       * A refused open never reaches mpv, so its start-file will never come
       * — the increment must be unwound or the gate is jammed for good. The
       * everyday trigger: pressing Next during a restart backoff, when the
       * command channel rejects with "mpv is not running". (A crash with a
       * load genuinely in flight is the restart reset's job, not this one.)
       */
      pendingLoads = Math.max(0, pendingLoads - 1);
      throw error;
    });
  }

  function onDied() {
    suspended = true;
  }

  async function onRestarted() {
    // Restore what the viewer had. Position comes from our own mirror (the
    // dead process cannot be asked; the mirror is at most one throttle
    // interval behind, which the crash already cost). Pause and sound come
    // from `intended` — the fresh process reports its own defaults before
    // this handler runs, and those reports must not become the restoration.
    //
    // The gate resets to zero FIRST: the pipe is FIFO, so everything the
    // dead process ever sent has already arrived by the time mpv:restarted
    // does — a load that was in flight at the crash left an increment whose
    // start-file will never come, and carrying it forward would gate every
    // property forever. The restore's own doOpen re-arms the gate cleanly.
    pendingLoads = 0;
    suspended = false;
    const gen = openGen;
    try {
      await tv.mpvSetVolume(Math.round(intended.volume * 100));
      await tv.mpvSetMute(intended.muted);
      if (gen !== openGen) return;   // the app opened something meanwhile: it wins
      if (state.absPath && !state.ended) {
        await doOpen(state.absPath, {
          startSeconds: state.currentTime > 1 ? state.currentTime : 0,
          paused: intended.paused,
        });
      }
      /**
       * Announce the rebuild, because this restore is deliberately PARTIAL.
       *
       * What lives here is what a <video> element owns: the file, the
       * position, pause, volume, mute. Everything else the app had asked mpv
       * for is a PROCESS property that died with the process — the subtitle
       * style, the crop, the interstitial zoom, the audio and subtitle track
       * — and none of it belongs in a facade whose whole job is to look like
       * an element. Teaching this function about subtitles would put app
       * knowledge inside the shim.
       *
       * So the app is told instead, and re-asserts its own. Without this the
       * picture came back at the right timestamp wearing mpv's defaults: her
       * subtitle size and colour gone for the REST OF THE SESSION (nothing
       * else ever re-applies them), subtitles she had switched off silently
       * back on, and the track menu still showing the pre-crash selection —
       * a menu asserting a track that is not playing.
       */
      emit('restored');
    } catch (error) {
      console.error('mpv restart restore failed:', error);
    }
  }

  function onDown() {
    // The restart policy gave up. Surfacing it as 'error' routes into the
    // renderer's existing skip/report path instead of a silent frozen frame.
    state.error = { message: 'the player stopped and could not be restarted' };
    emit('error');
  }

  const unsubscribers = [
    tv.onMpvProp(onProp),
    tv.onMpvEvent(onMpvEvent),
    tv.onMpvDied(onDied),
    tv.onMpvRestarted(onRestarted),
    tv.onMpvDown(onDown),
  ];

  // -- the element face -----------------------------------------------------

  const facade = {
    /** Replaces the src=/load() pair; resets every per-file mirror. */
    async open(absPath, options = {}) {
      intended.paused = Boolean(options.paused);
      return doOpen(absPath, options);
    },

    async stop() {
      openGen += 1;
      state.absPath = null;   // props with no file to belong to are dropped
      state.ended = false;
      state.error = null;
      return tv.mpvStop();
    },

    play() {
      intended.paused = false;
      setPausedMirror(false);   // the element flips paused DURING play()
      return tv.mpvSetPause(false).catch(() => {});
    },
    pause() {
      intended.paused = true;
      setPausedMirror(true);
      return tv.mpvSetPause(true).catch(() => {});
    },

    addEventListener(name, fn, options = {}) {
      const wrapped = options && options.once
        ? (payload) => { facade.removeEventListener(name, wrapped); fn(payload); }
        : fn;
      wrapped.__original = fn;
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(wrapped);
    },
    removeEventListener(name, fn) {
      const set = listeners.get(name);
      if (!set) return;
      for (const candidate of set) {
        if (candidate === fn || candidate.__original === fn) set.delete(candidate);
      }
    },

    get currentTime() { return state.currentTime; },
    set currentTime(seconds) {
      if (!Number.isFinite(seconds)) return;   // garbage ignored, as the element did
      // CLAMPED, not refused: `currentTime -= 10` four seconds in must land
      // on zero, exactly as the element clamped it — refusing negatives made
      // back-seek silently dead for an episode's first ten seconds.
      const target = Math.max(0, seconds);
      state.currentTime = target;   // reads-after-seek see the target, like the element
      tv.mpvSeek(target).catch(() => {});
    },

    get duration() { return state.duration; },
    get paused() { return state.paused; },
    get ended() { return state.ended; },
    get error() { return state.error; },
    get videoWidth() { return state.videoWidth; },
    get videoHeight() { return state.videoHeight; },
    get codedWidth() { return state.codedWidth; },
    get codedHeight() { return state.codedHeight; },
    /** The element reported its URL; the facade reports its file. */
    get src() { return state.absPath || ''; },

    get volume() { return intended.volume; },
    set volume(level) {
      if (!Number.isFinite(level)) return;
      intended.volume = Math.min(1, Math.max(0, level));
      tv.mpvSetVolume(Math.round(intended.volume * 100)).catch(() => {});
    },
    get muted() { return intended.muted; },
    set muted(value) {
      intended.muted = Boolean(value);
      tv.mpvSetMute(intended.muted).catch(() => {});
    },

    /**
     * The inert element shims are GONE, and their absence is the point.
     *
     * `style: {}`, `querySelectorAll: () => []`, `append: () => {}`,
     * `textTracks: []`, `getBoundingClientRect` and `buffered` were scaffolding
     * for the switchover: while call sites were still being rewired, a
     * leftover `player.style.transform = ...` had to no-op instead of
     * throwing. The rewiring finished, and nothing in the renderer touches
     * any of them now.
     *
     * Kept, they would be worse than dead code. A write to `player.style`
     * SUCCEEDS silently — no throw, no rejection, not even an unhandled
     * promise — so a future call site aimed at the wrong object would go
     * wrong in perfect silence. That is the failure mode this whole branch
     * has now been bitten by twice. Without them the same mistake is an
     * immediate TypeError with a stack.
     */
    dispose() {
      for (const unsub of unsubscribers) { try { unsub(); } catch { /* gone */ } }
      listeners.clear();
    },
  };

  return facade;
}

export { TIMEUPDATE_MIN_INTERVAL_MS };
