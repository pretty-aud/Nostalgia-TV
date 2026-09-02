/**
 * The switchover smoke: boot the REAL app on mpv and watch the channel run.
 *
 *   node scripts/mpv-smoke.mjs
 *
 * Everything the embed harness cannot prove, proven here: the actual
 * main.js boots the two planes, the actual renderer drives the facade, and
 * a generated fixture library plays through episode -> bumper card -> next
 * episode unattended, with the resume save landing in a SCRATCH profile
 * (NTV_PROFILE), her real state untouched and the single-instance lock
 * scoped away from any live copy of the app.
 *
 * Driven over CDP — the technique proven on the installed app: DOM state is
 * read from outside, transitions are awaited with deadlines, and the state
 * file is checked for the writes the renderer claims to have made.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = path.join(root, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const work = path.join(os.tmpdir(), 'ntv-mpv-smoke');
const library = path.join(work, 'library');
const profile = path.join(work, 'profile');
const CDP_PORT = 9223;

const results = [];
function verdict(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Put the test window on the SECOND monitor, on top, WITHOUT taking focus.
 *
 * Two rules, both learned the hard way in one sitting:
 *
 *  - Never touch the primary monitor. This machine is somebody's desk: a
 *    test window that lands in front of a video call is a real cost, and
 *    the first drafts of this check stole focus repeatedly while she was
 *    working. The secondary display is the harness's whole world.
 *  - Never activate. HWND_TOPMOST with SWP_NOACTIVATE raises the window
 *    without moving the keyboard, where SwitchToThisWindow yanks it.
 *
 * Targeted BY PID, never by process name: her own copy of the app runs
 * under the identical name, and a name match focused HER window on another
 * screen while the check sampled whatever sat over the test window —
 * reporting a broken player that was purely the harness looking away.
 *
 * And found by ENUMERATING the process's own top-level windows rather than
 * asking for MainWindowHandle, which came back 0 for this app: the pair is
 * a frameless owner plus an owned transparent child, and .NET's heuristic
 * picks neither.
 *
 * Only the OWNER — the video plane — is moved. Moving the overlay instead
 * left the video plane on the other monitor while the transparent interface
 * sat over a browser window, and the pixel check dutifully sampled the
 * BROWSER through it and called the player black. The plane manager syncs
 * the overlay onto whatever the owner does, so moving the owner moves both;
 * moving the child moves half a window.
 */
function placeOnSecondMonitor(pid) {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    "Add-Type -MemberDefinition '"
      + '[DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Auto)] public static extern System.IntPtr FindWindowEx(System.IntPtr parent, System.IntPtr after, string cls, string title); '
      + '[DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(System.IntPtr h, out int procId); '
      + '[DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h); '
      + '[DllImport("user32.dll")] public static extern System.IntPtr GetWindow(System.IntPtr h, uint cmd); '
      + '[DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr h, System.IntPtr after, int x, int y, int w, int hh, uint flags);'
      + "' -Name F -Namespace NTVF",
    '$other = [System.Windows.Forms.Screen]::AllScreens | Where-Object { -not $_.Primary } | Select-Object -First 1',
    'if (-not $other) { Write-Output "NOSECONDSCREEN"; exit }',
    '$x = $other.Bounds.X + 120',
    '$y = $other.Bounds.Y + 120',
    '$moved = 0',
    '$seen = 0',
    '$h = [System.IntPtr]::Zero',
    'do {',
    "  $h = [NTVF.F]::FindWindowEx([System.IntPtr]::Zero, $h, 'Chrome_WidgetWin_1', [NullString]::Value)",
    '  if ($h -ne [System.IntPtr]::Zero) {',
    '    $owner = 0',
    '    [NTVF.F]::GetWindowThreadProcessId($h, [ref]$owner) | Out-Null',
    `    if ($owner -eq ${pid} -and [NTVF.F]::IsWindowVisible($h)) {`,
    '      $seen = $seen + 1',
    // GW_OWNER = 4. Zero means this is the owner itself: the video plane.
    '      if ([NTVF.F]::GetWindow($h, 4) -eq [System.IntPtr]::Zero) {',
    // HWND_TOPMOST = -1; SWP_NOSIZE(1) | SWP_NOACTIVATE(0x10): moved and
    // raised, never resized (the planes must keep their agreed size) and
    // never focused (this machine is somebody's desk).
    '        [NTVF.F]::SetWindowPos($h, [System.IntPtr](-1), $x, $y, 0, 0, 0x11) | Out-Null',
    '        $moved = $moved + 1',
    '      }',
    '    }',
    '  }',
    '} while ($h -ne [System.IntPtr]::Zero)',
    'if ($moved -eq 0) { Write-Output ("NOWINDOW (saw {0})" -f $seen) } else { Write-Output ("PLACED {0} of {1} at {2},{3}" -f $moved, $seen, $x, $y) }',
  ].join('\n');
  const out = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  const text = `${out.stdout || ''}${out.stderr || ''}`.trim();
  return text.split(/\r?\n/)[0] || 'NO OUTPUT';
}

/**
 * Read one screen pixel, in PHYSICAL coordinates, from OUTSIDE the app.
 *
 * The check this exists for: the app can be perfectly healthy in every way
 * it can report on itself — mpv decoding, clock running, sound playing —
 * while the interface plane paints an opaque background over the picture.
 * Nothing inside the app can see that. Only the screen can.
 */
function screenPixel(x, y) {
  const script = [
    'Add-Type -AssemblyName System.Drawing',
    '$bmp = New-Object System.Drawing.Bitmap(1, 1)',
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    `$g.CopyFromScreen(${Math.round(x)}, ${Math.round(y)}, 0, 0, $bmp.Size)`,
    '$p = $bmp.GetPixel(0, 0)',
    'Write-Output ("{0},{1},{2}" -f $p.R, $p.G, $p.B)',
  ].join('; ');
  const out = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  const match = /(\d+),(\d+),(\d+)/.exec(out.stdout || '');
  if (!match) return null;
  return { r: +match[1], g: +match[2], b: +match[3] };
}

/**
 * Save what a failed pixel check was looking at — THE APP'S WINDOW ONLY.
 *
 * An earlier draft saved the whole virtual desktop, which on this machine
 * meant a 6000px image of somebody's inbox, their video call and their
 * browsing, written to a temp folder to debug a video player. A diagnostic
 * has no business photographing anything but its own subject.
 */
function captureScreen(outPath, box) {
  const x = Math.round(box.x);
  const y = Math.round(box.y);
  const w = Math.max(1, Math.round(box.w));
  const h = Math.max(1, Math.round(box.h));
  const script = [
    'Add-Type -AssemblyName System.Drawing',
    `$bmp = New-Object System.Drawing.Bitmap(${w}, ${h})`,
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    `$g.CopyFromScreen(${x}, ${y}, 0, 0, $bmp.Size)`,
    `$bmp.Save('${outPath.replace(/\\/g, '\\\\')}')`,
    `Write-Output ("SAVED the app window only: ${w}x${h} at ${x},${y}")`,
  ].join('; ');
  const out = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return (out.stdout || '').trim() || (out.stderr || '').trim();
}

/** Two tiny shows, a bumper and a promo — 6-second episodes so transitions
 *  happen while we watch. Colours are distinct so a failure names its file. */
async function makeLibrary() {
  const clip = (out, color, seconds) => {
    if (fs.existsSync(out)) return;
    const made = spawnSync(FFMPEG, [
      '-y',
      '-f', 'lavfi', '-i', `color=c=${color}:s=320x180:d=${seconds}:r=30`,
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
      '-shortest', '-pix_fmt', 'yuv420p', '-c:a', 'aac', out,
    ], { windowsHide: true, timeout: 60000 });
    if (made.error || made.status !== 0) throw new Error(`could not generate ${out}`);
  };

  for (const dir of ['Show Alpha', 'Show Beta', 'BUMPERS', 'PROMOS']) {
    await fsp.mkdir(path.join(library, dir), { recursive: true });
  }
  clip(path.join(library, 'Show Alpha', 'Alpha S01E01.mp4'), 'red', 6);
  clip(path.join(library, 'Show Alpha', 'Alpha S01E02.mp4'), 'darkred', 6);
  clip(path.join(library, 'Show Beta', 'Beta S01E01.mp4'), 'blue', 6);
  clip(path.join(library, 'Show Beta', 'Beta S01E02.mp4'), 'darkblue', 6);
  clip(path.join(library, 'BUMPERS', 'sting.mp4'), 'green', 2);
  clip(path.join(library, 'PROMOS', 'promo.mp4'), 'purple', 3);
}

/** Pre-seed the profile: root chosen, bumper card short, saves verifiable. */
async function seedProfile() {
  await fsp.rm(profile, { recursive: true, force: true });
  await fsp.mkdir(profile, { recursive: true });
  await fsp.writeFile(path.join(profile, 'channel-state.json'), JSON.stringify({
    version: 1,                       // boot() refuses a versionless state
    rootPath: library,
    cursors: {},
    history: [],
    queue: [],
    // MUTED and at zero, always. This runs on somebody's desk: a test that
    // makes noise during a call is a real cost, and it made one.
    settings: { mode: 'deck', bumperSeconds: 2, bumperEnabled: true, muted: true, volume: 0 },
  }));
}

// -- a minimal CDP client over the runtime's own WebSocket -------------------

async function cdpConnect() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
      const page = pages.find((p) => p.type === 'page' && p.webSocketDebuggerUrl);
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          ws.onopen = resolve;
          ws.onerror = reject;
        });
        return ws;
      }
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error('CDP never came up');
}

let cdpSeq = 0;
function evaluate(ws, expression) {
  const id = ++cdpSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CDP timeout: ${expression.slice(0, 60)}`)), 15000);
    const onMessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result && message.result.result && message.result.result.value);
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true },
    }));
  });
}

/** Wait for a page-side condition, with a deadline that names itself. */
async function until(ws, label, expression, timeoutMs = 30000) {
  const startedAt = Date.now();
  for (;;) {
    const value = await evaluate(ws, expression).catch(() => undefined);
    if (value) return value;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await sleep(400);
  }
}

async function main() {
  await makeLibrary();
  await seedProfile();

  // NTV_SMOKE_BINARY runs the smoke against a PACKAGED build (the portable's
  // win-unpacked exe) instead of the dev tree — resourcesPath, the bundled
  // mpv and the asar all differ, and the artifact she tests is the one that
  // must be proven.
  const binary = process.env.NTV_SMOKE_BINARY;
  // electron.exe DIRECTLY, not the .bin/.cmd shim: the shim's pid belongs to
  // cmd.exe, which owns no window — and every screen check needs the real
  // process to focus by pid.
  const devElectron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
  const child = spawn(
    binary || devElectron,
    binary ? [`--remote-debugging-port=${CDP_PORT}`] : ['.', `--remote-debugging-port=${CDP_PORT}`],
    {
      cwd: root,
      env: { ...process.env, NTV_PROFILE: profile },
      stdio: ['ignore', fs.openSync(path.join(work, 'app.out.log'), 'w'), fs.openSync(path.join(work, 'app.err.log'), 'w')],
      windowsHide: true,
      // Never a shell: both are real .exe files, and a shell would split the
      // packaged path at the space in "Nostalgia TV".
      shell: false,
    },
  );
  const childGone = new Promise((resolve) => child.on('exit', resolve));

  let ws;
  try {
    ws = await cdpConnect();

    // Boot lands on the ready screen with the seeded library scanned.
    try {
      await until(ws, 'the ready screen',
        "document.getElementById('app').dataset.view === 'ready'");
    } catch (error) {
      const diag = await evaluate(ws, `JSON.stringify({
        view: document.getElementById('app') && document.getElementById('app').dataset.view,
        tv: typeof window.tv,
        tvKeys: window.tv ? Object.keys(window.tv).length : 0,
        ready: document.readyState,
        body: document.body.className,
      })`).catch(() => 'evaluate failed');
      console.error(`DIAG: ${diag}`);
      console.error('app.err.log tail:', fs.readFileSync(path.join(work, 'app.err.log'), 'utf8').slice(-2000));
      throw error;
    }
    const showRows = await evaluate(ws, "document.querySelectorAll('#showList .show').length");
    verdict('boots to ready with the fixture library scanned', showRows === 2, `${showRows} shows`);

    // Start the channel from the real button.
    await evaluate(ws, "document.querySelector('.welcome__inner button').click()");
    await until(ws, 'playback', "document.getElementById('app').dataset.view === 'playing'");
    const npShow = await evaluate(ws, "document.getElementById('npShow').textContent");
    const firstCode = await evaluate(ws, "document.getElementById('npCode').textContent");
    const chrome = await evaluate(ws, "document.getElementById('app').dataset.chrome");
    verdict('an episode starts, named, with no chrome over it',
      Boolean(npShow) && chrome === 'off', `now playing: ${npShow} ${firstCode}, chrome=${chrome}`);

    /**
     * THE PICTURE IS ACTUALLY ON SCREEN.
     *
     * The check the first switchover shipped without, and the exact failure
     * it let through: sound, a running clock, a black rectangle — because
     * the interface plane's stylesheet painted --paper over the whole
     * window. The fixture episodes are solid RED and BLUE, so one pixel in
     * the middle of the window settles it beyond argument.
     */
    /**
     * The window is asked where it IS on every sample, never once at the
     * start: the first draft computed a centre point, THEN moved the window
     * to the other monitor, and went on sampling the abandoned coordinates —
     * reporting a black picture that was really somebody's wallpaper.
     */
    const readGeometry = async () => JSON.parse(await evaluate(ws, `JSON.stringify({
      x: window.screenX, y: window.screenY,
      w: window.innerWidth, h: window.innerHeight,
      dpr: window.devicePixelRatio,
    })`));
    /**
     * NO devicePixelRatio conversion. Both sides already speak the same
     * units: PowerShell here is DPI-UNAWARE, so Windows virtualises its
     * coordinates into the same DIP space Electron reports — proven by the
     * placement landing at 3560 and the window reporting 3559. Scaling by
     * the 1.5 ratio pushed the sample clean off the 6000px desktop and read
     * whatever the OS returns out of bounds (a confident near-white).
     */
    const sampleCentre = async () => {
      const box = await readGeometry();
      return screenPixel(box.x + box.w / 2, box.y + box.h / 2);
    };
    const isFixtureColour = (p) => Boolean(p)
      && ((p.r > 110 && p.g < 90 && p.b < 90)      // Show Alpha: red
        || (p.b > 110 && p.r < 90 && p.g < 90));   // Show Beta: blue

    // Out of her way FIRST, and only then look at the screen.
    let placement = '';
    for (let i = 0; i < 5 && !placement.startsWith('PLACED'); i += 1) {
      placement = placeOnSecondMonitor(child.pid);
      await sleep(300);
    }

    let picture = null;
    for (let i = 0; i < 15 && !isFixtureColour(picture); i += 1) {
      await sleep(300);
      picture = await sampleCentre();
    }
    if (!isFixtureColour(picture)) {
      const box = await readGeometry();
      console.error(`placement: ${placement} | geometry: ${JSON.stringify(box)}`);
      console.error(`capture: ${captureScreen(path.join(work, 'failure.png'), box)}`);
      console.error(`saved: ${path.join(work, 'failure.png')}`);
    }
    verdict('the PICTURE is on screen, not just decoding',
      isFixtureColour(picture),
      picture ? `centre pixel rgb(${picture.r},${picture.g},${picture.b}) (${placement})` : 'screenshot failed');

    // …and it survives a resize, which is when Chromium re-asserts its
    // compositor child over mpv. The one-shot raise passed the old harness
    // and still lost the picture minutes into a real session.
    //
    // Nothing is re-placed here: a SetWindowPos during the check would fight
    // the very maximize being tested. The geometry is simply re-read.
    await evaluate(ws, 'window.tv.toggleMaximizeWindow()');
    let afterResize = null;
    for (let i = 0; i < 15 && !isFixtureColour(afterResize); i += 1) {
      await sleep(400);
      afterResize = await sampleCentre();
    }
    verdict('the picture SURVIVES a maximize (the raise holds)',
      isFixtureColour(afterResize),
      afterResize ? `centre pixel rgb(${afterResize.r},${afterResize.g},${afterResize.b})` : 'screenshot failed');
    await evaluate(ws, 'window.tv.toggleMaximizeWindow()');
    await sleep(800);

    // The 6-second episode ends on its own: the card appears, then the next
    // programme — the whole transition running on facade events.
    await until(ws, 'the up-next card', "document.getElementById('app').dataset.view === 'bumper'", 40000);
    verdict('the episode ended and the up-next card appeared', true);

    // The view flips to 'playing' the moment an open is ATTEMPTED, so the
    // honest signal of a real advance is the PROGRAMME CHANGING, not the view.
    const advanced = await until(ws, 'a different programme',
      `(document.getElementById('app').dataset.view === 'playing'
        && (document.getElementById('npShow').textContent + '|' + document.getElementById('npCode').textContent)
           !== ${JSON.stringify(`${npShow}|${firstCode}`)})
        ? (document.getElementById('npShow').textContent + ' ' + document.getElementById('npCode').textContent) : ''`,
      30000);
    verdict('the channel advanced to a DIFFERENT programme unattended', Boolean(advanced), advanced);

    // The save path: immediate writes mean the state file in the SCRATCH
    // profile has moved past the seed, with a queue and history.
    const stateRaw = await fsp.readFile(path.join(profile, 'channel-state.json'), 'utf8');
    const stateNow = JSON.parse(stateRaw);
    verdict('the scratch profile is saving (queue committed, history written)',
      Array.isArray(stateNow.queue) && stateNow.queue.length > 0
      && Array.isArray(stateNow.history) && stateNow.history.length > 0,
      `queue=${(stateNow.queue || []).length} history=${(stateNow.history || []).length}`);

    // mpv's own log exists in the scratch profile — the player really ran.
    const mpvLog = await fsp.stat(path.join(profile, 'mpv.log')).catch(() => null);
    verdict('mpv genuinely ran (its log has substance)',
      Boolean(mpvLog && mpvLog.size > 1000), mpvLog ? `${mpvLog.size} bytes` : 'missing');
  } finally {
    try { if (ws) await evaluate(ws, 'window.tv.closeWindow() && true').catch(() => {}); } catch { /* going down */ }
    await Promise.race([childGone, sleep(5000)]);
    try { child.kill(); } catch { /* gone */ }
    spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true, timeout: 10000 });
  }

  const failed = results.filter((r) => !r.pass).length;
  console.log(failed === 0 ? 'SMOKE PASSED' : `${failed} SMOKE CHECK(S) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

setTimeout(() => { console.error('SMOKE TIMEOUT'); process.exit(2); }, 180000);
main().catch((error) => { console.error(String(error && error.stack ? error.stack : error)); process.exit(3); });
