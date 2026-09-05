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
    maximizable: false,
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
  overlay.on('move', () => {
    if (syncing || video.isDestroyed() || overlay.isDestroyed()) return;
    // A maximized or fullscreen window must not be dragged out of that state
    // sideways — the OS would report it still maximized at the new position.
    if (video.isMaximized() || video.isFullScreen()) { sync(); return; }
    const content = video.getContentBounds();
    const frame = video.getBounds();
    // Content bounds for the same reason sync() uses them: the overlay's own
    // invisible resize border would otherwise shift the video window by the
    // border width on every single drag.
    const target = overlay.getContentBounds();
    const wantX = target.x - (content.x - frame.x);
    const wantY = target.y - (content.y - frame.y);
    if (wantX === frame.x && wantY === frame.y) return;   // converged
    syncing = true;
    video.setPosition(wantX, wantY);
    syncing = false;
  });
  /**
   * The reverse glue for RESIZE, the twin of the move handler above.
   *
   * Dragging an edge resizes the OVERLAY — it owns the only grabbable border
   * — so the video window has to be driven to match, or mpv would keep
   * rendering at the old size while the interface changed shape around it.
   *
   * Content bounds, not bounds: the overlay is frameless, so what the viewer
   * dragged is a content rectangle, and that is what the video window must
   * end up with. setContentBounds does the frame arithmetic for us, which the
   * move handler has to do by hand because it only knows a position.
   */
  overlay.on('resize', () => {
    if (syncing || video.isDestroyed() || overlay.isDestroyed()) return;
    // Maximised and fullscreen sizes belong to the OS; leave them alone and
    // let the forward sync put the overlay back where it should be.
    if (video.isMaximized() || video.isFullScreen()) { sync(); return; }
    const target = overlay.getContentBounds();
    if (boundsEqual(video.getContentBounds(), target)) return;   // converged
    syncing = true;
    video.setContentBounds(target);
    syncing = false;
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
