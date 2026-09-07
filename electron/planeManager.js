'use strict';

/**
 * The two planes: a video window mpv renders into, and a transparent
 * interface window glued exactly over it, carrying the entire renderer.
 *
 * Why two windows at all: mpv's --wid child and Chromium's compositor
 * children are SIBLINGS inside one window, and only one of them can be on
 * top — so one window cannot hold video UNDER interactive DOM. A separate
 * owned window always composites above its owner, transparency included,
 * which is exactly the layering the app needs (proven end to end by
 * scripts/mpv-embed-proof.cjs).
 *
 * The glue is hand-rolled because Electron's `parent` option buys z-order
 * and shared minimize/restore, NOT bounds: nothing else keeps the overlay
 * covering the video plane through moves, resizes, maximise and fullscreen.
 *
 * Input: every click and key lands on the overlay, which is where the
 * renderer lives — a click that hits no control is "clicked the video",
 * exactly the <video>-era semantics. The video window is focus-forwarding
 * only; its own DOM is a black placeholder nothing ever reads.
 */

const { BrowserWindow } = require('electron');

/** Every parent-window change that can move the content area. */
const RESYNC_EVENTS = [
  'move', 'resize', 'maximize', 'unmaximize', 'restore',
  'enter-full-screen', 'leave-full-screen',
];

/**
 * `Window` is injected so this file can be tested at all.
 *
 * It defaults to Electron's BrowserWindow, so every caller in the app passes
 * nothing and reads unchanged. The seam matters because the geometry here —
 * a resize border that sits OUTSIDE the visible window, and two windows that
 * drive each other — is the kind that goes wrong silently and can only be
 * pinned down against a fake pair. mpvHost takes its player the same way.
 */
function createPlanes({ videoOptions = {}, overlayWebPreferences = {}, Window = BrowserWindow } = {}) {
  const video = new Window({
    backgroundColor: '#000000',
    show: false,
    ...videoOptions,
  });
  // The overlay must not be draggable below what the video window can follow.
  const minWidth = videoOptions.minWidth;
  const minHeight = videoOptions.minHeight;
  // A stable black page — never content. The plane exists so mpv has a
  // surface; anything drawn here sits UNDER mpv's raised child forever.
  video.loadURL('data:text/html,<body style="background:%23000;margin:0"></body>');

  const overlay = new Window({
    parent: video,
    transparent: true,
    frame: false,
    hasShadow: false,
    /**
     * thickFrame and resizable are TRUE, and that pair is the only mouse
     * resize this app has.
     *
     * The overlay covers the video window's content area exactly, and on a
     * frameless window the content area IS the whole window — so the overlay
     * sits on top of every pixel Windows would have used as a resize border.
     * Built non-resizable with thickFrame off, the pair could not be resized
     * by dragging any edge at all: the app was stuck at whatever size it
     * launched at, with only the maximise button and fullscreen left. The
     * shipping app was frameless too and never lost this, because it had no
     * second window covering itself.
     *
     * thickFrame is what puts WS_THICKFRAME back, and without it `resizable`
     * alone gives a frameless window no border to grab. hasShadow stays off
     * so the transparent plane draws no frame of its own.
     */
    thickFrame: true,
    resizable: true,
    ...(minWidth ? { minWidth } : {}),
    ...(minHeight ? { minHeight } : {}),
    minimizable: false,
    /**
     * maximizable is TRUE, and that single bit is Windows snapping.
     *
     * It reads like a window-button setting and it is not one — the overlay
     * has no window buttons, and the renderer draws the app's own. What it
     * actually controls is WS_MAXIMIZEBOX, and Windows will not Aero Snap or
     * offer the Snap Layouts flyout on a window that lacks that style. The
     * drag reaches the OS perfectly well; the OS looks at the style bits and
     * declines.
     *
     * Measured on this machine with scripts/snap-styles.cjs, which is kept
     * for exactly this reason:
     *
     *   video   0x14c70000  +MAXIMIZEBOX +MINIMIZEBOX +THICKFRAME +CAPTION
     *   overlay 0x14000000  (visible, clip-siblings, and nothing else)
     *
     * The video plane had every bit it needed the whole time. It was never
     * the window being dragged: the drag strip is in the interface plane, so
     * the pointer is over the OVERLAY, and the overlay was the one Windows
     * was being asked to snap. Setting titleBarStyle on the video plane
     * therefore changed nothing at all, which is what shipping it proved.
     * With this flag the overlay reads 0x14010000 and snapping works.
     *
     * The cost is that Windows can now maximise the overlay by itself, which
     * is what a drag to the top edge IS — hence the maximise glue below.
     */
    maximizable: true,
    skipTaskbar: true,   // one taskbar entry: the pair presents as ONE app
    show: false,
    webPreferences: overlayWebPreferences,
  });

  let syncing = false;

  const boundsEqual = (a, b) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

  /**
   * CONTENT bounds on both sides, never getBounds().
   *
   * The overlay carries WS_THICKFRAME so it can be resized by the mouse, and
   * Windows puts that resize border OUTSIDE the visible area of a frameless
   * window — measured here at 7px left, 6px right and bottom. So the
   * overlay's outer rect is ~13px wider than the picture it covers, and
   * comparing it against the video's content bounds can never be equal.
   *
   * That is not a cosmetic mismatch, it is a feedback loop: the equality test
   * below is the ONLY thing that stops the two windows driving each other.
   * Never converging, every resize would push the video window out to the
   * overlay's outer size, which re-syncs the overlay wider, which pushes
   * again — a window that grows without touching it. Content-to-content, the
   * two agree exactly and the loop terminates on the first pass.
   */
  const sync = () => {
    if (video.isDestroyed() || overlay.isDestroyed()) return;
    if (video.isMinimized()) return;   // owned windows hide with their owner
    const target = video.getContentBounds();
    if (boundsEqual(overlay.getContentBounds(), target)) return;   // already there: no event chatter
    syncing = true;
    overlay.setContentBounds(target);
    syncing = false;
  };

  for (const event of RESYNC_EVENTS) video.on(event, sync);

  /**
   * The REVERSE glue: the drag strip lives in the interface plane's DOM
   * (-webkit-app-region: drag), and dragging it moves the OVERLAY — its own
   * window — not the pair. So an overlay move that we did not cause is the
   * user dragging, and the video plane follows underneath, keeping its
   * frame offset. The `syncing` flag stops the two moves chasing each other.
   */
  /**
   * The follow runs on the NEXT TICK, never straight off the event. This is
   * the difference between snapping working and snapping destroying the
   * window size she had before she snapped.
   *
   * Windows announces a maximise — which is all a drag to the top edge is —
   * as a resize and a move FIRST, with isMaximized() still reporting false,
   * and only afterwards emits 'maximize'. Traced on this machine with
   * scripts/snap-styles.cjs:
   *
   *   overlay resize   2563x1440+3441+0  max=false     <- already full screen
   *   overlay move     2563x1440+3441+0  max=false
   *   overlay maximize 2560x1440+3440+0  max=true      <- only now
   *
   * Run synchronously, the follow copies that first full-screen rectangle
   * onto the video plane while both planes still believe they are restored —
   * which overwrites the restore rectangle Windows was holding for each of
   * them. Snapping then worked exactly once: unsnapping gave back a window
   * the size of the display, and the 1930x1205 she had been using was gone.
   * No isMaximized() check can catch it, because the flag is false at the
   * moment the guard would run.
   *
   * One tick later the state has settled and the guards mean what they say.
   * Coalesced, so a drag that fires fifty moves does one follow per tick
   * instead of fifty — which is strictly less work than before, not more.
   */
  let pending = null;
  const followOverlay = () => {
    pending = null;
    if (syncing || video.isDestroyed() || overlay.isDestroyed()) return;
    /**
     * A maximised overlay was not resized by her, it was resized by Windows,
     * and its rectangle belongs to the OS. The maximise glue below drives the
     * pair by STATE in that case; copying a full-screen rectangle through the
     * bounds path is wrong whatever the timing happens to be.
     *
     * Honest note: neither the fake nor scripts/snap-styles.cjs can currently
     * make this line fire — deferring the follow means the state has always
     * settled by the time it runs. It is kept as the precondition it is, not
     * as a fix for anything observed. The twin guard in sync() was removed
     * for exactly the reason this one is not: sync() is correct in every
     * state, so its version really was doing nothing.
     */
    if (overlay.isMaximized()) return;
    // A maximized or fullscreen window must not be dragged out of that state
    // sideways — the OS would report it still maximized at the new position.
    if (video.isMaximized() || video.isFullScreen()) { sync(); return; }

    const target = overlay.getContentBounds();
    const content = video.getContentBounds();
    /**
     * A resize and a move are one event here, because after coalescing they
     * arrive together and there is no way to tell them apart. Size first:
     * setContentBounds carries the position too, so a resize that also moved
     * — dragging the top-left corner, a half-screen snap — needs one call.
     */
    /**
     * A PIXEL IS NOT A RESIZE, and treating it as one makes the window grow.
     *
     * The two planes never agree exactly about a size: the video window
     * carries WS_THICKFRAME and the overlay does not, so a rectangle handed
     * from one to the other comes back a pixel wider. Compared exactly, the
     * follow reads that pixel as the viewer resizing, writes it to the video
     * plane, the forward sync writes it back a pixel wider again, and every
     * snap-and-unsnap leaves the window one pixel bigger than it was.
     * Measured at exactly +1px per round trip by scripts/snap-styles.cjs,
     * which now runs three cycles for that reason. It is invisible for the
     * first few and then it is not.
     *
     * Two pixels of slack costs nothing — the overlay is transparent and its
     * edge is dark chrome either way — and it is the difference between two
     * windows that settle and two windows that push each other.
     */
    const NEAR = 2;
    if (Math.abs(content.width - target.width) > NEAR
      || Math.abs(content.height - target.height) > NEAR) {
      syncing = true;
      video.setContentBounds(target);
      syncing = false;
      return;
    }
    // Content bounds for the same reason sync() uses them: the overlay's own
    // invisible resize border would otherwise shift the video window by the
    // border width on every single drag.
    const frame = video.getBounds();
    const wantX = target.x - (content.x - frame.x);
    const wantY = target.y - (content.y - frame.y);
    if (wantX === frame.x && wantY === frame.y) return;   // converged
    syncing = true;
    video.setPosition(wantX, wantY);
    syncing = false;
  };
  const scheduleFollow = () => {
    if (syncing || pending) return;
    pending = setTimeout(followOverlay, 0);
  };
  overlay.on('move', scheduleFollow);
  overlay.on('resize', scheduleFollow);

  /**
   * The reverse glue for MAXIMISE — the one a snap to the top edge uses.
   *
   * Dragging to the top of the screen is not a move, it is Windows maximising
   * the window under the pointer, and that window is the overlay. Left there
   * the pair would disagree about its own state: the interface covering the
   * whole screen, the video plane still officially restored, the app's own
   * maximise button showing the wrong icon, and the video plane's restore
   * rectangle quietly overwritten with the size of the display.
   *
   * The video plane is the one that matters — it owns the taskbar entry and
   * everything the renderer is told about window state — so its maximise is
   * driven from the overlay's, and the forward sync then puts the overlay
   * back over it.
   */
  overlay.on('maximize', () => {
    if (syncing || video.isDestroyed() || overlay.isDestroyed()) return;
    if (!video.isMaximized()) video.maximize();
  });
  overlay.on('unmaximize', () => {
    if (syncing || video.isDestroyed() || overlay.isDestroyed()) return;
    if (video.isMaximized()) video.unmaximize();
  });

  // Some of those events fire BEFORE the OS settles the final bounds
  // (fullscreen transitions especially); a trailing pass catches the rest.
  const settle = () => setTimeout(sync, 120);
  video.on('enter-full-screen', settle);
  video.on('leave-full-screen', settle);
  video.on('maximize', settle);
  video.on('unmaximize', settle);

  // The interface is where every keystroke belongs. Focus handed to the
  // video plane (alt-tab, a stray click during startup) is silently passed
  // along, so "the keyboard stopped working" cannot depend on which of two
  // identical-looking windows the OS picked.
  video.on('focus', () => {
    if (!overlay.isDestroyed()) overlay.focus();
  });

  /**
   * The pair closes as ONE, from either side. The video window is the OS
   * window (its X, the taskbar close), but Alt+F4 and friends act on the
   * FOCUSED window — the overlay — and an overlay closed alone would orphan
   * a playing video window with no interface over it, no way to control it
   * and no way to close it short of the task manager.
   *
   * The overlay closes via close(), not destroy(): its renderer holds the
   * beforeunload final-save, and destroy() would skip it.
   */
  video.on('closed', () => {
    if (!overlay.isDestroyed()) overlay.close();
  });
  overlay.on('closed', () => {
    // A follow scheduled a tick ago would run against a destroyed pair.
    if (pending) { clearTimeout(pending); pending = null; }
    if (!video.isDestroyed()) video.close();
  });

  /**
   * The two planes are shown SEPARATELY, and the order matters.
   *
   * The video plane goes up FIRST, before mpv is spawned into it: mpv sizes
   * its rendering surface from the window it is given AT CREATION, so a
   * window that has not been shown yet leaves it painting into nothing.
   * That is a picture that never appears until something resizes the window
   * — which is precisely the boot-time black screen this pair produced, and
   * why maximising "fixed" it. Showing an empty black plane costs nothing
   * visually: it carries no content, only mpv's output.
   *
   * The interface plane goes up LAST, when its renderer has painted, so the
   * app never flashes a half-drawn UI.
   */
  const showVideo = () => {
    /**
     * showInactive(), NOT show(). Two reasons, and the second is measured:
     *
     *  - the video plane must never take focus. The interface plane owns the
     *    keyboard; show() activates, showInactive() does not.
     *  - show() DID NOT MAKE THIS WINDOW VISIBLE. Logged on this machine:
     *    `before=false afterShow=false afterInactive=true`. mpv then
     *    rendered faithfully into a window Windows never displayed, so the
     *    app had sound, a running clock and no picture until something
     *    called maximize() — which shows a hidden window as a side effect,
     *    and was the only reason the picture ever appeared at all.
     */
    video.showInactive();
    sync();
  };
  const showOverlay = () => {
    overlay.show();
    overlay.focus();
  };
  const showBoth = () => { showVideo(); showOverlay(); };

  return {
    video, overlay, sync, showBoth, showVideo, showOverlay,
  };
}

module.exports = { createPlanes, RESYNC_EVENTS };
