import { describe, it, expect, beforeEach } from 'vitest';

/**
 * The two-window glue, against a fake window pair.
 *
 * planeManager had no test at all, which is startling for the file that
 * decides where both windows are, which one closes the other, and — since
 * the resize border was restored — whether the two can drive each other into
 * a loop. Every bug this branch has shipped to a human lived in this file or
 * one line away from it.
 *
 * The fake reproduces the ONE piece of real geometry that matters: the
 * overlay carries WS_THICKFRAME so it can be grabbed by the mouse, and
 * Windows puts that resize border OUTSIDE the visible area of a frameless
 * window. Measured on this machine: 7px left, 6px right, 6px bottom, 0 top.
 * So the overlay's outer rect is 13px wider than the picture it covers, and
 * any code comparing an outer rect against a content rect can never converge.
 */

const OVERLAY_BORDER = { left: 7, top: 0, right: 6, bottom: 6 };

function fakeWindow({ border = { left: 0, top: 0, right: 0, bottom: 0 }, bounds } = {}) {
  const listeners = new Map();
  const win = {
    // `content` is the truth; the outer rect is derived, exactly as Windows does it.
    content: { ...bounds },
    border,
    destroyed: false,
    minimized: false,
    maximized: false,
    fullScreen: false,
    shown: false,
    activated: null,
    closed: false,
    setBoundsCalls: 0,
    setContentBoundsCalls: 0,

    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
    },
    fire(event) {
      for (const fn of listeners.get(event) || []) fn();
    },
    listenerCount: (event) => (listeners.get(event) || []).length,

    getContentBounds: () => ({ ...win.content }),
    setContentBounds(next) {
      win.setContentBoundsCalls += 1;
      win.content = { ...next };
      win.fire('resize');
      win.fire('move');
    },
    getBounds: () => ({
      x: win.content.x - border.left,
      y: win.content.y - border.top,
      width: win.content.width + border.left + border.right,
      height: win.content.height + border.top + border.bottom,
    }),
    setBounds(next) {
      win.setBoundsCalls += 1;
      win.content = {
        x: next.x + border.left,
        y: next.y + border.top,
        width: next.width - border.left - border.right,
        height: next.height - border.top - border.bottom,
      };
      win.fire('resize');
      win.fire('move');
    },
    setPosition(x, y) {
      win.content = { ...win.content, x: x + border.left, y: y + border.top };
      win.fire('move');
    },

    isDestroyed: () => win.destroyed,
    isMinimized: () => win.minimized,
    isMaximized: () => win.maximized,
    isFullScreen: () => win.fullScreen,
    show() { win.shown = true; win.activated = true; },
    showInactive() { win.shown = true; win.activated = false; },
    focus() {},
    close() { win.closed = true; win.destroyed = true; win.fire('closed'); },
    loadURL() {},
  };
  return win;
}

let created = [];

class FakeBrowserWindow {
  constructor(options) {
    // First construction is the video plane, second is the overlay — the
    // order planeManager creates them in.
    const isOverlay = created.length === 1;
    const win = fakeWindow({
      border: isOverlay ? OVERLAY_BORDER : { left: 0, top: 0, right: 0, bottom: 0 },
      bounds: { x: 100, y: 100, width: options.width || 1280, height: options.height || 800 },
    });
    win.options = options;
    created.push(win);
    return win;
  }
}

const { createPlanes } = await import('../electron/planeManager.js');

function build() {
  created = [];
  const planes = createPlanes({
    videoOptions: { width: 1280, height: 800, minWidth: 720, minHeight: 480, frame: false },
    overlayWebPreferences: {},
    Window: FakeBrowserWindow,
  });
  return { ...planes, videoWin: created[0], overlayWin: created[1] };
}

beforeEach(() => { created = []; });

describe('the overlay can actually be grabbed', () => {
  it('is resizable and carries the thick frame that gives a frameless window a border', () => {
    const { overlayWin } = build();
    // Without BOTH of these the pair cannot be resized by the mouse at all:
    // the overlay covers every pixel Windows would have used as a border on
    // the video window, and `resizable` alone gives a frameless window
    // nothing to grab.
    expect(overlayWin.options.resizable).toBe(true);
    expect(overlayWin.options.thickFrame).toBe(true);
  });

  it('inherits the video plane\'s minimum size, so it cannot be dragged smaller than the pair allows', () => {
    const { overlayWin } = build();
    expect(overlayWin.options.minWidth).toBe(720);
    expect(overlayWin.options.minHeight).toBe(480);
  });

  it('never takes the taskbar entry or the window buttons from the video plane', () => {
    const { overlayWin } = build();
    expect(overlayWin.options.skipTaskbar).toBe(true);
    expect(overlayWin.options.minimizable).toBe(false);
    expect(overlayWin.options.maximizable).toBe(false);
  });
});

describe('the planes stay glued', () => {
  it('puts the overlay CONTENT exactly over the video content, border and all', () => {
    const { sync, videoWin, overlayWin } = build();
    videoWin.content = { x: 300, y: 220, width: 1600, height: 900 };
    sync();
    expect(overlayWin.getContentBounds()).toEqual({ x: 300, y: 220, width: 1600, height: 900 });
    // And its outer rect is duly larger — the invisible grab border, sitting
    // outside the picture rather than over it.
    expect(overlayWin.getBounds()).toEqual({ x: 293, y: 220, width: 1613, height: 906 });
  });

  /**
   * THE LOOP TEST. This is why this file has tests.
   *
   * Compare the overlay's OUTER rect against the video's CONTENT rect and
   * they can never be equal, so the "already there" guard never fires: every
   * resize drives the video out to the overlay's outer size, which re-syncs
   * the overlay wider, which drives again. The window grows on its own.
   * Content-to-content, the two agree and it settles on the first pass.
   */
  it('converges instead of driving the two windows apart', () => {
    const { videoWin, overlayWin } = build();
    videoWin.content = { x: 300, y: 220, width: 1600, height: 900 };
    videoWin.fire('resize');

    const settled = { ...videoWin.content };
    // Let every consequence play out; a diverging pair keeps moving.
    for (let i = 0; i < 20; i += 1) {
      overlayWin.fire('resize');
      overlayWin.fire('move');
      videoWin.fire('resize');
      videoWin.fire('move');
    }
    expect(videoWin.content).toEqual(settled);
    expect(overlayWin.getContentBounds()).toEqual(settled);
  });

  it('carries a mouse resize of the overlay through to the video plane', () => {
    const { videoWin, overlayWin } = build();
    videoWin.content = { x: 300, y: 220, width: 1600, height: 900 };
    videoWin.fire('resize');

    // The viewer drags the bottom-right corner: Windows resizes the overlay.
    overlayWin.content = { x: 300, y: 220, width: 1000, height: 640 };
    overlayWin.fire('resize');

    expect(videoWin.getContentBounds()).toEqual({ x: 300, y: 220, width: 1000, height: 640 });
  });

  it('moves the video plane by the drag distance, not the border width', () => {
    const { videoWin, overlayWin } = build();
    videoWin.content = { x: 300, y: 220, width: 1600, height: 900 };
    videoWin.fire('resize');

    // Dragging the strip moves the overlay 40px right and 25px down.
    overlayWin.content = { x: 340, y: 245, width: 1600, height: 900 };
    overlayWin.fire('move');

    // Exactly 40/25 — an overlay border leaking into this sum would shift the
    // window by 7px on every single drag.
    expect(videoWin.getContentBounds().x).toBe(340);
    expect(videoWin.getContentBounds().y).toBe(245);
  });

  it('leaves a maximized window alone and re-syncs the overlay instead', () => {
    const { videoWin, overlayWin } = build();
    videoWin.content = { x: 0, y: 0, width: 2560, height: 1400 };
    videoWin.maximized = true;
    const before = { ...videoWin.content };

    overlayWin.content = { x: 90, y: 90, width: 900, height: 500 };
    overlayWin.fire('move');
    overlayWin.fire('resize');

    // The OS owns a maximized size; dragging must not smuggle it out of that
    // state sideways, which would leave Windows reporting it still maximized
    // somewhere else.
    expect(videoWin.content).toEqual(before);
    expect(overlayWin.getContentBounds()).toEqual(before);
  });

  it('does not chase a minimized window', () => {
    const { sync, videoWin, overlayWin } = build();
    videoWin.minimized = true;
    const before = overlayWin.getContentBounds();
    sync();
    expect(overlayWin.getContentBounds()).toEqual(before);
  });
});

describe('the pair behaves as one window', () => {
  it('shows the video plane WITHOUT activating it', () => {
    const { showVideo, videoWin } = build();
    showVideo();
    // showInactive, not show: measured on Windows, show() left this window
    // WS_VISIBLE-unset and mpv rendered into something nobody could see.
    // It must also never steal focus from the interface plane.
    expect(videoWin.shown).toBe(true);
    expect(videoWin.activated).toBe(false);
  });

  it('closes both ways round', () => {
    const a = build();
    a.videoWin.close();
    expect(a.overlayWin.closed).toBe(true);

    const b = build();
    b.overlayWin.close();
    // Alt+F4 lands on the FOCUSED window, which is the overlay. Without this
    // cascade it would orphan a playing video window with no interface over
    // it, no way to control it and no way to close it but the task manager.
    expect(b.videoWin.closed).toBe(true);
  });
});
