'use strict';

/**
 * WHICH WINDOW STYLES DOES THE PAIR ACTUALLY CARRY?
 *
 * Windows will not Aero Snap a window that has no WS_MAXIMIZEBOX. It is not a
 * preference or a hint: the drag reaches the OS, the OS looks at the style
 * bits, and declines. The Snap Layouts flyout hangs off the same bit.
 *
 * This app is TWO windows and the one under the pointer is the overlay, not
 * the video plane — so reading the video plane's styles would answer the
 * wrong question, which is exactly the mistake that made titleBarStyle look
 * like a fix. Both are read here, and the overlay is the one that decides.
 *
 * Built with the same createPlanes() the app uses, so the styles measured are
 * the styles that ship.
 *
 * Usage: electron scripts/snap-styles.cjs
 * Exits 0 when the overlay can be snapped, 1 when it cannot.
 * Diagnostic tooling only. Not part of the build.
 */

const { app, screen } = require('electron');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { createPlanes } = require(path.join(__dirname, '..', 'electron', 'planeManager.js'));

const GWL_STYLE = -16;
const BITS = {
  WS_MAXIMIZEBOX: 0x00010000,
  WS_MINIMIZEBOX: 0x00020000,
  WS_THICKFRAME: 0x00040000,
  WS_CAPTION: 0x00C00000,
  WS_CHILD: 0x40000000,
};

/**
 * user32 through a hidden PowerShell. Slow (about a third of a second) and
 * completely fine here: this runs twice in a diagnostic, not once per mouse
 * move. It is the same reason mpvPlayer.js can afford it at startup and
 * could not afford it during a drag.
 */
function styleOf(hwnd) {
  const script = [
    'Add-Type -Namespace N -Name U -MemberDefinition \'[DllImport("user32.dll")] public static extern int GetWindowLong(System.IntPtr h, int i);\' | Out-Null',
    `[N.U]::GetWindowLong([System.IntPtr]${hwnd}, ${GWL_STYLE})`,
  ].join('; ');
  const result = spawnSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true });
  const value = Number((result.stdout || '').trim());
  if (!Number.isFinite(value)) {
    throw new Error(`GetWindowLong gave nothing back: ${(result.stderr || '').trim()}`);
  }
  // GetWindowLong returns a signed int; the style bits are unsigned.
  return value >>> 0;
}

const hwndOf = (win) => {
  const handle = win.getNativeWindowHandle();
  return handle.length === 8
    ? Number(handle.readBigUInt64LE(0))
    : handle.readUInt32LE(0);
};

const describe = (style) => Object.entries(BITS)
  .map(([name, bit]) => `${(style & bit) === bit ? '+' : '-'}${name}`)
  .join(' ');

setTimeout(() => { console.error('timed out'); app.exit(2); }, 30000);

app.whenReady().then(async () => {
  // The same shape main.js builds. Only the bits that affect window style
  // matter, so the webPreferences and the loaded page are left off.
  const { video, overlay, showVideo, showOverlay } = createPlanes({
    videoOptions: {
      width: 1280,
      height: 800,
      minWidth: 720,
      minHeight: 480,
      backgroundColor: '#08070c',
      autoHideMenuBar: true,
      title: 'Nostalgia TV',
      frame: false,
    },
  });
  await overlay.loadURL('data:text/html,<body style="background:transparent;margin:0"></body>');

  // Onto the second monitor before anything is shown, same convention as
  // shoot-state.js: a diagnostic must not take over the screen she is using.
  const primary = screen.getPrimaryDisplay();
  const other = screen.getAllDisplays().find((d) => d.id !== primary.id);
  if (other) video.setPosition(other.workArea.x + 60, other.workArea.y + 60);

  showVideo();
  showOverlay();
  await new Promise((r) => setTimeout(r, 600));

  const videoStyle = styleOf(hwndOf(video));
  const overlayStyle = styleOf(hwndOf(overlay));
  console.log(`video   0x${videoStyle.toString(16).padStart(8, '0')}  ${describe(videoStyle)}`);
  console.log(`overlay 0x${overlayStyle.toString(16).padStart(8, '0')}  ${describe(overlayStyle)}`);

  /**
   * The overlay is the verdict. It is the window the pointer is over, so it
   * is the window Windows is asked to snap; the video plane only ever gets
   * dragged along by the reverse glue afterwards.
   */
  const snappable = (overlayStyle & BITS.WS_MAXIMIZEBOX) === BITS.WS_MAXIMIZEBOX;
  console.log(snappable
    ? 'PASS the overlay carries WS_MAXIMIZEBOX — Windows will offer snap'
    : 'FAIL the overlay has no WS_MAXIMIZEBOX — Windows will refuse to snap it');

  /**
   * ...and then actually do it, on real windows.
   *
   * A snap to the top edge IS Windows maximising the window under the
   * pointer, so maximising the overlay from here is the same event the glue
   * has to survive — and it is the only way to find out what the real
   * geometry does, which no fake can be trusted to guess. The fake in
   * test/planeManager.test.js keeps the two planes' maximised content bounds
   * identical, and whether that is true of Windows is precisely the question.
   */
  const rect = (win) => {
    const b = win.getContentBounds();
    return `${b.width}x${b.height}+${b.x}+${b.y}`;
  };
  /**
   * Two pixels of slack, the same slack planeManager's follow allows.
   *
   * The planes do not agree to the pixel and are not meant to — the video
   * window carries WS_THICKFRAME and the overlay does not. Worse, the
   * maximized height settles asynchronously: read at 700ms this printed
   * 2560x1439 on one run and 2560x1440 on the next, from identical code.
   * An exact comparison here does not measure the app, it measures when the
   * probe happened to look, and it duly reported a failure against code that
   * had just passed. What matters is the restore rectangle, which IS exact,
   * and the drift, which is zero.
   */
  const agree = (a, b) => {
    const x = a.getContentBounds();
    const y = b.getContentBounds();
    return ['x', 'y', 'width', 'height'].every((axis) => Math.abs(x[axis] - y[axis]) <= 2);
  };
  const settled = () => new Promise((r) => setTimeout(r, 700));

  /**
   * Trace every window event with the state at the moment it fired.
   *
   * The order of 'maximize' against the 'resize' and 'move' that come with it
   * is the whole question — a guard that reads isMaximized() is worthless if
   * the bounds events arrive while the flag is still false. Registered after
   * createPlanes, so each line shows the state the glue LEFT behind.
   */
  if (process.env.NTV_TRACE) {
    for (const [name, win] of [['video', video], ['overlay', overlay]]) {
      for (const event of ['maximize', 'unmaximize', 'resize', 'move']) {
        win.on(event, () => console.log(
          `    ${name} ${event.padEnd(11)} ${rect(win)} max=${win.isMaximized()}`
            + `  [video ${rect(video)} max=${video.isMaximized()}]`,
        ));
      }
    }
  }

  const problems = [];
  const started = video.getContentBounds();

  /**
   * THREE ROUND TRIPS, not one.
   *
   * A single snap and unsnap cannot tell a harmless rounding difference from
   * a leak. The two planes settle a pixel apart after a restore — the video
   * window carries WS_THICKFRAME and the overlay does not, so their frame
   * arithmetic does not quite agree — and the only question that matters is
   * whether that pixel is paid once or paid again on every snap. Snapping is
   * something she will do dozens of times in an evening.
   */
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    console.log(`-- cycle ${cycle}: maximize --`);
    overlay.maximize();
    await settled();
    const maxed = {
      video: rect(video),
      overlay: rect(overlay),
      videoMax: video.isMaximized(),
      overlayMax: overlay.isMaximized(),
    };
    console.log(`maximized  video ${maxed.video} (max=${maxed.videoMax})`);
    console.log(`           overlay ${maxed.overlay} (max=${maxed.overlayMax})`);
    if (!maxed.videoMax) problems.push(`cycle ${cycle}: the video plane did not follow the overlay into maximized`);
    if (!maxed.overlayMax) problems.push(`cycle ${cycle}: the overlay came straight back out of maximized`);
    if (!agree(video, overlay)) problems.push(`cycle ${cycle}: the planes disagree about the maximized rect (${maxed.video} vs ${maxed.overlay})`);

    console.log(`-- cycle ${cycle}: unmaximize --`);
    overlay.unmaximize();
    await settled();
    console.log(`restored   video ${rect(video)} (max=${video.isMaximized()})`);
    console.log(`           overlay ${rect(overlay)} (max=${overlay.isMaximized()})`);
    if (video.isMaximized() || overlay.isMaximized()) {
      problems.push(`cycle ${cycle}: unmaximizing left a plane maximized`);
    }
  }

  /**
   * DRAGGING STILL KEEPS UP.
   *
   * The follow was deferred to fix snapping, and deferring it is exactly the
   * kind of change that quietly reintroduces the lag she reported when moving
   * the window — the interface sliding along with the mouse and the picture
   * trailing behind it. One tick is imperceptible; a tick that accumulates
   * over a drag is not. Twenty moves in a row, checking the video plane has
   * caught up after each one, tells the difference: real lag would leave the
   * gap growing rather than closing every time.
   */
  // Captured BEFORE the drag: the snap drift and the drag drift are different
  // questions, and measuring them together lets one hide inside the other.
  const afterCycles = video.getContentBounds();

  console.log('-- drag --');
  let worst = 0;
  const origin = overlay.getContentBounds();
  const beforeDrag = video.getContentBounds();
  const STEPS = Number(process.env.NTV_DRAG_STEPS || 20);
  for (let step = 1; step <= STEPS; step += 1) {
    /**
     * setContentBounds with the SIZE HELD, not setPosition.
     *
     * A drag is Windows reporting a new position for the same rectangle, and
     * that is what this has to imitate. setPosition looked like the obvious
     * call and is not: on this transparent frameless window it came back
     * three pixels wider every time, so the probe grew the window by 43px
     * across twenty steps and blamed the app. The window under test has to be
     * poked the way the OS pokes it, or the measurement is of the probe.
     */
    overlay.setContentBounds({
      ...origin, x: origin.x + step * 4, y: origin.y + step * 2,
    });
    await new Promise((r) => setTimeout(r, 0));   // exactly one turn
    const gap = Math.abs(overlay.getContentBounds().x - video.getContentBounds().x);
    worst = Math.max(worst, gap);
  }
  console.log(`worst gap between the planes during the drag: ${worst}px`);
  // The planes are a pixel apart at rest by construction; anything more than
  // a few pixels is the picture trailing the interface.
  if (worst > 4) problems.push(`the video plane fell ${worst}px behind during a drag`);
  overlay.setContentBounds(origin);   // put it back, or it counts as drift
  await settled();
  const afterDrag = video.getContentBounds();
  /**
   * Reported per step, because the only question is whether it scales.
   * A fixed few pixels is the pair settling once; pixels PER MOVE is a window
   * that grows while she drags it, and at 20 steps those look identical.
   * Run with NTV_DRAG_STEPS=40 to tell them apart.
   */
  const grew = afterDrag.width - beforeDrag.width;
  console.log(`drag of ${STEPS} steps grew the window ${grew}px (${(grew / STEPS).toFixed(2)}px per move)`);
  if (Math.abs(grew) > STEPS / 4) {
    problems.push(`the window grew ${grew}px over ${STEPS} drag steps — it scales with the drag`);
  }

  const drift = {
    width: afterCycles.width - started.width,
    height: afterCycles.height - started.height,
    x: afterCycles.x - started.x,
    y: afterCycles.y - started.y,
  };
  console.log(`drift over 3 round trips: ${JSON.stringify(drift)}`);
  /**
   * A couple of pixels once is the planes settling. A couple of pixels PER
   * CYCLE is a leak, and after an evening of snapping the window would have
   * walked off the screen — which is the bug this whole check exists to
   * catch, because it is invisible until it is enormous.
   */
  const LEAK = 3;
  for (const [axis, value] of Object.entries(drift)) {
    if (Math.abs(value) >= LEAK) {
      problems.push(`${axis} drifted ${value}px over 3 round trips — it is accumulating, not settling`);
    }
  }

  for (const problem of problems) console.log(`FAIL ${problem}`);
  if (!problems.length) console.log('PASS the pair snaps and restores together, and does not creep');

  app.exit(snappable && !problems.length ? 0 : 1);
});
