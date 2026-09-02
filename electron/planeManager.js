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

function createPlanes({ videoOptions = {}, overlayWebPreferences = {} } = {}) {
  const video = new BrowserWindow({
    backgroundColor: '#000000',
    show: false,
    ...videoOptions,
  });
  // A stable black page — never content. The plane exists so mpv has a
  // surface; anything drawn here sits UNDER mpv's raised child forever.
  video.loadURL('data:text/html,<body style="background:%23000;margin:0"></body>');

  const overlay = new BrowserWindow({
    parent: video,
    transparent: true,
    frame: false,
    hasShadow: false,
    thickFrame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,   // one taskbar entry: the pair presents as ONE app
    show: false,
    webPreferences: overlayWebPreferences,
  });

  let syncing = false;

  const boundsEqual = (a, b) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

  const sync = () => {
    if (video.isDestroyed() || overlay.isDestroyed()) return;
    if (video.isMinimized()) return;   // owned windows hide with their owner
    const target = video.getContentBounds();
    if (boundsEqual(overlay.getBounds(), target)) return;   // already there: no event chatter
    syncing = true;
    overlay.setBounds(target);
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
    const target = overlay.getBounds();
    const wantX = target.x - (content.x - frame.x);
    const wantY = target.y - (content.y - frame.y);
    if (wantX === frame.x && wantY === frame.y) return;   // converged
    syncing = true;
    video.setPosition(wantX, wantY);
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

  const showBoth = () => {
    video.show();
    sync();
    overlay.show();
    overlay.focus();
  };

  return { video, overlay, sync, showBoth };
}

module.exports = { createPlanes, RESYNC_EVENTS };
