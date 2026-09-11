'use strict';

/**
 * The mpv process: spawn it into the video plane, keep it alive, replace it
 * when it dies.
 *
 * This module owns the PROCESS — finding the vendored binary, the argument
 * contract, raising mpv's child window above Chromium's compositor children,
 * reconnecting the IPC client, and the restart policy when mpv exits without
 * being asked. It deliberately knows nothing about episodes, schedules or
 * settings: consumers get `command/observe/on` that always talk to the
 * CURRENT process, plus a 'restarted' event telling them to re-apply
 * whatever state they own (observers do not survive a restart — the bridge
 * re-registers on 'restarted').
 *
 * Two facts proven by scripts/mpv-embed-proof.cjs and honoured here:
 *  - Chromium parks its compositor children ABOVE the child mpv creates for
 *    --wid, painting over the video while mpv happily reports vo-configured.
 *    Every spawn is followed by a SetWindowPos raise of the `mpv` child.
 *  - PowerShell marshals $null into string P/Invoke parameters as an EMPTY
 *    STRING, so FindWindowEx "wildcards" match nothing. [NullString]::Value.
 */

const path = require('node:path');
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');

const { connectMpv } = require('./mpvClient.js');

/** Proven by running, like every binary this project touches. */
function isRunnable(candidate) {
  if (!candidate || !fs.existsSync(candidate)) return false;
  try {
    const result = spawnSync(candidate, ['--version'], {
      windowsHide: true, timeout: 20000, stdio: 'ignore',
    });
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

/**
 * The vendored mpv, and only the vendored mpv.
 *
 * Unlike ffmpeg there is no system-hunt fallback: the player IS the app on
 * this branch, and "some other mpv with some other config" is a support
 * ticket, not a rescue. A missing binary should fail loudly at startup.
 */
function findMpv() {
  const exe = 'mpv.exe';
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'mpv', exe));
  candidates.push(path.join(__dirname, '..', 'vendor', 'mpv', exe));
  return candidates.find(isRunnable) || null;
}

/**
 * The argument contract, split out because it IS the embedding design:
 *
 *  --wid            render into the video plane, never a window of mpv's own
 *  --no-config      the user's ~/mpv.conf must not restyle the channel
 *  --no-osc etc.    mpv contributes DECODING; every control is ours
 *  --force-window   the plane exists (black) before the first file loads
 *  --idle           surviving between files is the normal state
 *  --keep-open      hold the last frame at EOF instead of going black —
 *                   transitions are the app's decision, so the bridge reads
 *                   the `eof-reached` property rather than end-of-file
 *                   tearing the picture down
 */
function mpvArgsFor({ hwnd, pipeName, logFile }) {
  return [
    `--wid=${hwnd}`,
    `--input-ipc-server=${pipeName}`,
    '--no-config',
    '--no-osc',
    '--no-input-default-bindings',
    '--input-vo-keyboard=no',
    '--force-window=yes',
    '--idle=yes',
    '--keep-open=yes',
    ...(logFile ? [`--log-file=${logFile}`, '--msg-level=all=warn'] : []),
  ];
}

/**
 * When may a dead mpv be restarted, and after how long?
 *
 * Pure, so the policy is testable: `recentExits` is the timestamps of every
 * unrequested exit INCLUDING the one being handled (the caller records
 * first, then asks). Escalating delays absorb a transient — a driver reset,
 * a GPU hiccup; a process dying over and over inside the window is not
 * transient, and endlessly relaunching it would peg the machine doing
 * nothing — that returns null, and the caller surfaces a real error.
 */
const RESTART_WINDOW_MS = 2 * 60 * 1000;
const RESTART_DELAYS_MS = [250, 1000, 3000, 8000, 15000];

function nextRestartDelay(recentExits, now) {
  const inWindow = recentExits.filter((at) => now - at < RESTART_WINDOW_MS);
  const rung = Math.max(0, inWindow.length - 1);
  if (rung >= RESTART_DELAYS_MS.length) return null;
  return RESTART_DELAYS_MS[rung];
}

/**
 * Raise mpv's child window above Chromium's compositor children.
 *
 * A hidden one-shot PowerShell call rather than a native module: it runs
 * once per spawn, and this project deliberately has no native build step.
 * Polled, because the child appears a beat after the process does.
 */
/**
 * ONE Add-Type BLOCK, and it has to be one.
 *
 * This was `-MemberDefinition` with the signatures as a string, which is the
 * shorter form and cannot work here: GetClientRect takes a RECT, and a member
 * definition cannot reference a struct declared by a SEPARATE Add-Type — it
 * fails to compile with "Unable to find type [NTV.U]". Caught by running the
 * PowerShell on its own before shipping it, which matters more than usual: if
 * this script throws, the raise never happens and the picture is black. A
 * geometry fix that breaks the video entirely is a far worse bug than the one
 * it fixes.
 */
const USER32_SOURCE = `
namespace NTV {
  using System;
  using System.Runtime.InteropServices;
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public static class U {
    [DllImport("user32.dll", CharSet=CharSet.Auto)]
    public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint flags);
    [DllImport("user32.dll")]
    public static extern bool GetClientRect(IntPtr h, out RECT r);
  }
}`;

/**
 * ASYNCHRONOUS, and that is the whole point of it.
 *
 * This used spawnSync. Each call costs a hidden PowerShell that compiles C#
 * with Add-Type before it can touch user32 — measured at 294-336ms, median
 * 312ms — and spawnSync blocks the Electron MAIN process for every one of
 * those milliseconds. `move` is one of the events wired to the raiser and it
 * fires continuously while a window is being dragged, so with the raiser's
 * 400ms throttle the main process spent roughly three quarters of any drag
 * frozen. The window juddered while every other app on the machine moved
 * cleanly, which is exactly how she described it.
 *
 * The call sites already looked asynchronous — `Promise.resolve().then(...)`
 * with an `inFlight` flag — but a synchronous call inside a microtask still
 * blocks the thread it runs on. It read as non-blocking and was not.
 */
function raiseOnce(parentHwnd) {
  const script = [
    `Add-Type -TypeDefinition @'${USER32_SOURCE}
'@ -ErrorAction SilentlyContinue`,
    `$mpv = [NTV.U]::FindWindowEx([System.IntPtr]${parentHwnd}, [System.IntPtr]::Zero, 'mpv', [NullString]::Value)`,
    'if ($mpv -eq [System.IntPtr]::Zero) { Write-Output "NOTFOUND"; exit }',
    /**
     * SIZE IT, not just raise it.
     *
     * This passed SWP_NOMOVE | SWP_NOSIZE — z-order only — and nothing else in
     * the app ever set the child's geometry. mpv sizes its --wid child once at
     * creation from GetClientRect(parent), and afterwards only from its own
     * parent_evt_hook: a SetWinEventHook(EVENT_OBJECT_LOCATIONCHANGE) that is
     * asynchronous, coalescible and cross-process. Its other route,
     * parent_win_hook, needs the parent inside mpv's own process and never
     * applies here, because mpv.exe is a separate process.
     *
     * So ONE lossy hook was the only thing keeping the picture the size of the
     * plane. Miss an event — the window growing to full screen while mpv is
     * rebuilding a swapchain between files — and the child keeps the old rect,
     * anchored at the parent's origin: a picture in the top of the frame with
     * the plane's own black filling the rest. mpv then reads that stale rect
     * back as its own size and never corrects it, which is why only another
     * real resize fixes it and why she had to rescale the window repeatedly.
     *
     * The app owns the geometry now, on the same PowerShell round trip the
     * raise already cost.
     */
    `$r = New-Object NTV.RECT; [NTV.U]::GetClientRect([System.IntPtr]${parentHwnd}, [ref] $r) | Out-Null`,
    '$w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top',
    'if ($w -gt 0 -and $h -gt 0) {',
    // HWND_TOP, at the parent's origin, filling its client area; SWP_NOACTIVATE.
    '  [NTV.U]::SetWindowPos($mpv, [System.IntPtr]::Zero, 0, 0, $w, $h, 0x10) | Out-Null',
    '} else {',
    // No client rect to read — minimised, or mid-transition. Raise only, rather
    // than resizing the picture to nothing.
    '  [NTV.U]::SetWindowPos($mpv, [System.IntPtr]::Zero, 0, 0, 0, 0, 0x13) | Out-Null',
    '}',
    'Write-Output "RAISED"',
  ].join('\n');
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    let child;
    try {
      child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true });
    } catch { done(false); return; }
    // A raise that hangs must not hold the flag forever; the caller retries.
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } done(false); }, 20000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('error', () => { clearTimeout(timer); done(false); });
    child.on('close', () => { clearTimeout(timer); done(/RAISED/.test(stdout)); });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function raiseMpvChild(parentHwnd, { attempts = 25, intervalMs = 200 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    // AWAITED. raiseOnce returns a promise now, and a promise is always
    // truthy — without this the first attempt would always "succeed" and the
    // spawn-time retry loop, which exists because the child appears a beat
    // after the process does, would never run.
    if (await raiseOnce(parentHwnd)) return true;
    await sleep(intervalMs);
  }
  return false;
}

/**
 * A raise that HOLDS.
 *
 * Raising once at spawn is not enough: Chromium re-creates and re-asserts
 * its compositor child whenever the window is resized, restored, focused or
 * repainted, and each time it lands back above mpv — sound, clock, black
 * rectangle. Probed live on a running build, `Chrome_RenderWidgetHostHWND`
 * sat above `mpv` again minutes after a successful spawn-time raise.
 *
 * So callers re-raise on every event that can trigger that, and this
 * throttles the calls: each one costs a hidden PowerShell (~200ms), a
 * resize drag emits dozens, and they must not queue up behind each other.
 * Trailing-edge, one in flight at a time.
 */
function makeRaiser(parentHwnd, { minIntervalMs = 400 } = {}) {
  let inFlight = false;
  let pendingTimer = null;
  let requestedWhileBusy = false;

  /**
   * ALWAYS TRAILING. A first draft dropped every request that arrived while
   * a raise was in flight, which quietly threw away the only ones that
   * mattered: at boot the events arrive in a burst (window shown, renderer
   * loaded, first file opened), the first raise runs BEFORE Chromium's
   * first paint re-asserts its child, and the later requests — the ones
   * after the paint — were the ones discarded. Result: black picture until
   * something resized the window minutes later.
   */
  const schedule = () => {
    if (pendingTimer) return;
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      run();
    }, minIntervalMs);
  };

  const run = () => {
    if (inFlight) { requestedWhileBusy = true; return; }
    inFlight = true;
    // Deliberately not awaited: the caller is an event handler, and a raise
    // that lands a beat late is invisible where a blocked handler is not.
    Promise.resolve()
      .then(() => raiseOnce(parentHwnd))
      .catch(() => false)
      .finally(() => {
        inFlight = false;
        if (requestedWhileBusy) { requestedWhileBusy = false; schedule(); }
      });
  };

  return schedule;
}

let pipeCounter = 0;

/**
 * Spawn mpv into `hwnd` and keep it there.
 *
 * Returns a player whose command/observe/on always address the CURRENT
 * process. When mpv dies unrequested, the player respawns it under the
 * restart policy and emits 'restarted' — consumers re-apply their state and
 * re-register observers then. When the policy gives up, 'down' fires once
 * and the player stays dead until close().
 */
async function startMpvPlayer({ hwnd, logFile, exePath }) {
  const exe = exePath || findMpv();
  if (!exe) throw new Error('mpv is not vendored; run: node scripts/vendor-mpv.mjs');

  const handlers = new Map(); // event -> Set<fn>, for player-level events
  const emit = (name, payload) => {
    for (const fn of [...(handlers.get(name) || [])]) {
      try { fn(payload); } catch { /* a listener must not kill the player */ }
    }
  };

  const exits = [];
  let closed = false;
  let current = null; // { child, client, pipeName }

  async function spawnOnce() {
    pipeCounter += 1;
    const pipeName = `\\\\.\\pipe\\nostalgia-mpv-${process.pid}-${pipeCounter}`;
    const child = spawn(exe, mpvArgsFor({ hwnd, pipeName, logFile }), {
      windowsHide: true, stdio: 'ignore',
    });
    const client = await connectMpv(pipeName);

    child.on('exit', (code) => {
      if (closed || !current || current.child !== child) return;
      client.close();
      onUnrequestedExit(code);
    });

    // The proven raise. Failure here is loud, not silent: an unraised mpv is
    // the invisible-video bug, and "it says it is playing" is exactly the
    // symptom that costs a day.
    const raised = await raiseMpvChild(hwnd);
    if (!raised) emit('raise-failed', {});

    // A child that died DURING its own spawn no longer matches `current` in
    // the exit handler (deliberately — see the swap below), so it is caught
    // here instead and surfaces as a failed spawn for the restart policy.
    if (client.isClosed()) throw new Error('mpv died during startup');

    /**
     * The swap is LAST, after every await. From the moment `current` points
     * at the new client, commands from the renderer succeed — so nothing may
     * succeed before the 'restarted' consumers have had their synchronous
     * chance to re-attach event handlers. Swapping mid-respawn opened a
     * window where a loadfile went through while its start-file event had
     * no listener, which jammed the renderer's staleness gate for good.
     */
    current = { child, client, pipeName };
    return client;
  }

  function onUnrequestedExit(code) {
    // The renderer's bridge suspends its property mirrors the moment this
    // fires — the fresh process's default-state reports must never read as
    // the viewer's choices.
    emit('died', { code });
    const now = Date.now();
    exits.push(now);
    const delay = nextRestartDelay(exits, now);
    if (delay === null) {
      emit('down', { code, restarts: exits.length });
      return;
    }
    setTimeout(async () => {
      if (closed) return;
      try {
        await spawnOnce();
        armFileRaise();
        emit('restarted', { afterCode: code });
      } catch {
        // Died during its own spawn: the next rung decides, same policy.
        onUnrequestedExit(code);
      }
    }, delay);
  }

  await spawnOnce();

  /**
   * A new file is a new surface: mpv re-creates its swapchain on load, and
   * Chromium takes the opportunity to re-assert. Re-raise on every one.
   */
  const raise = makeRaiser(hwnd);
  const armFileRaise = () => {
    if (current) current.client.on('start-file', raise);
  };
  armFileRaise();

  return {
    raise,
    command: (...args) => {
      if (!current || current.client.isClosed()) return Promise.reject(new Error('mpv is not running'));
      return current.client.command(...args);
    },
    /** Registered against the CURRENT process; re-register on 'restarted'. */
    observe: (property, handler) => current.client.observe(property, handler),
    onMpvEvent: (name, handler) => current.client.on(name, handler),
    on: (name, handler) => {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name).add(handler);
      return () => handlers.get(name).delete(handler);
    },
    close: () => {
      closed = true;
      if (current) {
        current.client.close();
        try { current.child.kill(); } catch { /* already gone */ }
      }
    },
    isAlive: () => Boolean(current) && !current.client.isClosed(),
  };
}

module.exports = {
  startMpvPlayer,
  findMpv,
  // Exported for tests: the argument contract and the restart policy are the
  // decisions; the spawning around them is machinery the proof harness runs.
  mpvArgsFor,
  nextRestartDelay,
};
