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
const USER32 =
  '[DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Auto)] '
  + 'public static extern System.IntPtr FindWindowEx(System.IntPtr parent, System.IntPtr after, string cls, string title); '
  + '[DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr h, System.IntPtr after, int x, int y, int w, int hh, uint flags);';

function raiseOnce(parentHwnd) {
  const script = [
    `Add-Type -MemberDefinition '${USER32}' -Name U -Namespace NTV`,
    `$mpv = [NTV.U]::FindWindowEx([System.IntPtr]${parentHwnd}, [System.IntPtr]::Zero, 'mpv', [NullString]::Value)`,
    'if ($mpv -eq [System.IntPtr]::Zero) { Write-Output "NOTFOUND"; exit }',
    // HWND_TOP; SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE
    '[NTV.U]::SetWindowPos($mpv, [System.IntPtr]::Zero, 0, 0, 0, 0, 0x13) | Out-Null',
    'Write-Output "RAISED"',
  ].join('\n');
  const out = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  return /RAISED/.test(out.stdout || '');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function raiseMpvChild(parentHwnd, { attempts = 25, intervalMs = 200 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    if (raiseOnce(parentHwnd)) return true;
    await sleep(intervalMs);
  }
  return false;
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
    current = { child, client, pipeName };

    child.on('exit', (code) => {
      if (closed || current.child !== child) return;
      client.close();
      onUnrequestedExit(code);
    });

    // The proven raise. Failure here is loud, not silent: an unraised mpv is
    // the invisible-video bug, and "it says it is playing" is exactly the
    // symptom that costs a day.
    const raised = await raiseMpvChild(hwnd);
    if (!raised) emit('raise-failed', {});
    return client;
  }

  function onUnrequestedExit(code) {
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
        emit('restarted', { afterCode: code });
      } catch (error) {
        emit('down', { code, error: String(error && error.message) });
      }
    }, delay);
  }

  await spawnOnce();

  return {
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
