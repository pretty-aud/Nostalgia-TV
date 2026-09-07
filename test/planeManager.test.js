import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';

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

/** Where a maximized window lands. A second display, as on this machine. */
const WORK_AREA = { x: 3440, y: 0, width: 2560, height: 1440 };

/**
 * The overlay comes back a pixel wider than it was asked for.
 *
 * Measured, not invented: the video window carries WS_THICKFRAME and the
 * overlay does not, so a content rectangle handed from one to the other does
 * not survive the frame arithmetic intact. scripts/snap-styles.cjs recorded
 * the video plane restoring to 1930x1205 while the overlay reported
 * 1931x1206 for the same rectangle. Left out of the fake, the two planes
 * agree perfectly here and the pixel-per-snap growth that produced is
 * invisible to every test.
 */
const OVERLAY_SLACK = 1;

function fakeWindow({ border = { left: 0, top: 0, right: 0, bottom: 0 }, bounds, slack = 0 } = {}) {
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
      /**
       * Windows takes a window OUT of maximized the instant anything sets its
       * bounds, and the rectangle it was given becomes the new restore rect.
       * That is exactly how the reverse glue used to destroy the size she had
       * been using, so a fake that cannot express it cannot catch it.
       */
      if (win.maximized) {
        win.maximized = false;
        win.restoreContent = null;
        win.fire('unmaximize');
      }
      win.content = { ...next, width: next.width + slack, height: next.height + slack };
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
    /**
     * THE ORDER IS THE POINT, and it is the order Windows actually uses.
     *
     * Traced on this machine with scripts/snap-styles.cjs: the window is
     * already at the size of the display and still reporting max=false when
     * the resize and the move arrive, and 'maximize' comes last.
     *
     *   overlay resize   2563x1440+3441+0  max=false
     *   overlay move     2563x1440+3441+0  max=false
     *   overlay maximize 2560x1440+3440+0  max=true
     *
     * A fake that fired 'maximize' first would let glue through that reads
     * isMaximized() and believes it — which is the glue that shipped, and it
     * destroyed the window size she had before she snapped.
     */
    maximize() {
      if (win.maximized) return;
      win.restoreContent = { ...win.content };   // Windows remembers this
      /**
       * The window fills the display BEFORE the flag is set, so anything
       * listening is told isMaximized() === false while looking at a
       * full-screen rectangle. Set the flag first and the fake quietly
       * excuses every guard that reads it — which is how a synchronous
       * follow passed eighteen tests and then destroyed her window size.
       */
      win.content = { ...WORK_AREA };
      win.fire('resize');
      win.fire('move');
      win.maximized = true;
      win.fire('maximize');
    },
    unmaximize() {
      if (!win.maximized) return;
      win.maximized = false;
      if (win.restoreContent) win.content = { ...win.restoreContent };
      win.restoreContent = null;
      win.fire('resize');
      win.fire('move');
      win.fire('unmaximize');
    },
    /** What the window would go back to. While restored, that is where it is. */
    restoreRect: () => ({ ...(win.maximized ? win.restoreContent : win.content) }),

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
      slack: isOverlay ? OVERLAY_SLACK : 0,
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

beforeEach(() => { created = []; vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

/**
 * Let the deferred follow run.
 *
 * The reverse glue is scheduled a tick after the overlay's events rather than
 * running off them, because Windows reports a maximise as a resize and a move
 * with isMaximized() still false and only says 'maximize' afterwards. Firing
 * an event is therefore no longer the same as the video plane having moved,
 * and every test that drives the overlay has to say when the tick happens —
 * which is what lets the ordering be tested at all.
 */
const tick = () => vi.runAllTimers();

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

  it('never takes the taskbar entry or the minimize button from the video plane', () => {
    const { overlayWin } = build();
    expect(overlayWin.options.skipTaskbar).toBe(true);
    expect(overlayWin.options.minimizable).toBe(false);
  });

  /**
   * WINDOWS SNAPPING, and the reason it was broken for so long.
   *
   * maximizable is not a button setting here — the overlay has no window
   * buttons. It is WS_MAXIMIZEBOX, and Windows refuses Aero Snap and the
   * Snap Layouts flyout on a window without it. The drag strip lives in the
   * interface plane, so the overlay is the window the pointer is on and the
   * window the OS is asked to snap; the video plane's own styles never came
   * into it. Measured with scripts/snap-styles.cjs: false gives 0x14000000,
   * true gives 0x14010000.
   */
  it('is maximizable, which is the WS_MAXIMIZEBOX that lets Windows snap it', () => {
    const { overlayWin } = build();
    expect(overlayWin.options.maximizable).toBe(true);
  });
});

describe('a snap to the top edge', () => {
  /** Windows maximises the window under the pointer, and that is the overlay. */
  const snapToTop = (overlayWin) => overlayWin.maximize();

  it('carries the video plane into the maximized state with it', () => {
    const { videoWin, overlayWin } = build();
    expect(videoWin.maximized).toBe(false);
    snapToTop(overlayWin);
    tick();
    // Without the maximize glue the interface fills the screen and the video
    // plane stays officially restored — the app's own maximise button would
    // show the wrong icon and restore would do nothing.
    expect(videoWin.maximized).toBe(true);
  });

  /**
   * THE ONE THAT SHIPPED BROKEN, and the reason the follow is deferred.
   *
   * The video plane must be MAXIMIZED, never resized to the display. A window
   * resized to the display and then maximized has the display as its restore
   * rectangle, so unsnapping gives back a full-screen window and the size she
   * had been using is gone for good. The first version of this did exactly
   * that: snapping worked once, and 1930x1205 came back as 2563x1440.
   */
  it('keeps the size she had before she snapped', () => {
    const { videoWin, overlayWin } = build();
    videoWin.fire('resize');
    tick();
    const hers = videoWin.getContentBounds();

    snapToTop(overlayWin);
    tick();
    expect(videoWin.maximized).toBe(true);
    expect(videoWin.restoreRect()).toEqual(hers);

    overlayWin.unmaximize();
    tick();
    expect(videoWin.getContentBounds()).toEqual(hers);
  });

  it('restores both planes together when it is unsnapped', () => {
    const { videoWin, overlayWin } = build();
    snapToTop(overlayWin);
    tick();
    expect(videoWin.maximized).toBe(true);
    overlayWin.unmaximize();
    tick();
    expect(videoWin.maximized).toBe(false);
  });

  it('settles instead of driving the two planes round in circles', () => {
    const { videoWin, overlayWin } = build();
    // The fake maximises for real, so if the glue re-entered — video.maximize
    // firing a sync that restores the overlay that unmaximizes the video —
    // this would recurse until the stack gave out rather than returning.
    expect(() => { snapToTop(overlayWin); tick(); }).not.toThrow();
    expect(videoWin.maximized).toBe(true);
    expect(overlayWin.maximized).toBe(true);
  });

  /**
   * A pixel per snap is not nothing when snapping is a thing she does dozens
   * of times in an evening. The two planes never agree exactly about a size,
   * and read as an intentional resize that disagreement compounds: the window
   * ends the evening bigger than the screen. Measured at +1px per round trip
   * before the follow was given any slack.
   */
  it('does not grow by a pixel every time it is snapped and unsnapped', () => {
    const { videoWin, overlayWin } = build();
    videoWin.fire('resize');
    tick();
    const before = videoWin.getContentBounds();
    for (let cycle = 0; cycle < 3; cycle += 1) {
      overlayWin.maximize();
      tick();
      overlayWin.unmaximize();
      tick();
    }
    expect(videoWin.getContentBounds()).toEqual(before);
  });

  /**
   * A half-screen snap is NOT a maximise: Windows just moves and resizes the
   * overlay, so it has to keep going through the ordinary reverse glue. The
   * guards added for the maximise case must not swallow it.
   */
  it('still carries a half-screen snap through as a plain move and resize', () => {
    const { videoWin, overlayWin } = build();
    videoWin.fire('resize');
    tick();
    overlayWin.content = { x: 0, y: 0, width: 1280, height: 1400 };
    overlayWin.fire('resize');
    overlayWin.fire('move');
    tick();
    expect(videoWin.getContentBounds()).toEqual({ x: 0, y: 0, width: 1280, height: 1400 });
  });
});

describe('the planes stay glued', () => {
  it('puts the overlay CONTENT over the video content, border and all', () => {
    const { sync, videoWin, overlayWin } = build();
    videoWin.content = { x: 300, y: 220, width: 1600, height: 900 };
    sync();
    // Position lands exactly. Size lands within the pixel the two planes
    // never agree on — see OVERLAY_SLACK; asserting equality here would be
    // asserting something the real windows do not do.
    const over = overlayWin.getContentBounds();
    expect({ x: over.x, y: over.y }).toEqual({ x: 300, y: 220 });
    expect(over.width - 1600).toBeLessThanOrEqual(OVERLAY_SLACK);
    expect(over.height - 900).toBeLessThanOrEqual(OVERLAY_SLACK);
    // And its outer rect is duly larger — the invisible grab border, sitting
    // outside the picture rather than over it.
    expect(overlayWin.getBounds().x).toBe(293);
    expect(overlayWin.getBounds().width - 1613).toBeLessThanOrEqual(OVERLAY_SLACK);
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
      tick();
    }
    expect(videoWin.content).toEqual(settled);
  });

  it('carries a mouse resize of the overlay through to the video plane', () => {
    const { videoWin, overlayWin } = build();
    videoWin.content = { x: 300, y: 220, width: 1600, height: 900 };
    videoWin.fire('resize');
    tick();

    // The viewer drags the bottom-right corner: Windows resizes the overlay.
    overlayWin.content = { x: 300, y: 220, width: 1000, height: 640 };
    overlayWin.fire('resize');
    tick();

    expect(videoWin.getContentBounds()).toEqual({ x: 300, y: 220, width: 1000, height: 640 });
  });

  it('moves the video plane by the drag distance, not the border width', () => {
    const { videoWin, overlayWin } = build();
    videoWin.content = { x: 300, y: 220, width: 1600, height: 900 };
    videoWin.fire('resize');
    tick();

    // Dragging the strip moves the overlay 40px right and 25px down.
    const held = overlayWin.getContentBounds();
    overlayWin.content = { ...held, x: held.x + 40, y: held.y + 25 };
    overlayWin.fire('move');
    tick();

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
    tick();

    // The OS owns a maximized size; dragging must not smuggle it out of that
    // state sideways, which would leave Windows reporting it still maximized
    // somewhere else.
    expect(videoWin.content).toEqual(before);
    expect(overlayWin.getContentBounds().x).toBe(before.x);
    expect(overlayWin.getContentBounds().y).toBe(before.y);
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
