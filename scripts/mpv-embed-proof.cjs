'use strict';

/**
 * Prove the two-plane design before anything is built on it.
 *
 *   node_modules/.bin/electron scripts/mpv-embed-proof.cjs
 *
 * Creates the video plane (a BrowserWindow), embeds the VENDORED mpv into it
 * with --wid, plays a GENERATED solid-red clip, floats the transparent
 * interface plane over it with a solid-green badge — then verifies with
 * evidence from OUTSIDE the app:
 *
 *   1. mpv reports vo-configured and an advancing playback time.
 *   2. A desktop screenshot shows RED where the video plane is exposed —
 *      Chromium's own capturePage cannot see mpv's child window, so only a
 *      screen capture can prove the two planes actually composite.
 *   3. The same screenshot shows GREEN at the badge — the DOM paints ABOVE
 *      the native video window, which is the entire design question.
 *   4. A real OS-level click (SendInput via PowerShell, not a synthesized
 *      DOM event) lands on the overlay's button — input routes to the
 *      interface plane even where it is transparent.
 *
 * Each check can fail independently and says so. Exit 0 only when all pass.
 *
 * The harness pins its userData to a scratch profile FIRST: the package name
 * is shuffle-tv, so Electron's default profile dir is the REAL app's — and
 * her copy may be running while this proof runs.
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { app, screen } = require('electron');

const root = path.join(__dirname, '..');
const work = path.join(os.tmpdir(), 'ntv-mpv-proof');
fs.mkdirSync(work, { recursive: true });
app.setPath('userData', path.join(work, 'profile'));

// The PRODUCTION modules, not inline plumbing: this harness is how the
// player and plane manager get exercised against a real desktop, which no
// vitest run can do.
const { startMpvPlayer } = require(path.join(root, 'electron', 'mpvPlayer.js'));
const { createPlanes } = require(path.join(root, 'electron', 'planeManager.js'));

const FFMPEG = path.join(root, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const CLIP = path.join(work, 'solid-red.mp4');

const results = [];
function verdict(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function makeClip() {
  if (fs.existsSync(CLIP) && fs.statSync(CLIP).size > 0) return;
  const made = spawnSync(FFMPEG, [
    '-y', '-f', 'lavfi', '-i', 'color=c=red:s=800x450:d=12:r=30',
    '-pix_fmt', 'yuv420p', CLIP,
  ], { windowsHide: true, timeout: 30000 });
  if (made.error || made.status !== 0) throw new Error('could not generate the red clip');
}

/** HWND of a BrowserWindow, as the decimal string mpv's --wid wants. */
function hwndOf(win) {
  return win.getNativeWindowHandle().readBigUInt64LE(0).toString();
}

/**
 * Read one screen pixel, in PHYSICAL coordinates, from outside the app.
 * PowerShell + System.Drawing because that is a second, independent renderer
 * of the truth — the whole point is not to ask Chromium about itself.
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

/** A real click through the OS input queue — not a DOM event we invented. */
function osClick(x, y) {
  const script = [
    'Add-Type -MemberDefinition \'[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint data, System.UIntPtr extra);\' -Name U -Namespace W',
    `[W.U]::SetCursorPos(${Math.round(x)}, ${Math.round(y)}) | Out-Null`,
    'Start-Sleep -Milliseconds 120',
    '[W.U]::mouse_event(2, 0, 0, 0, [System.UIntPtr]::Zero)',   // left down
    '[W.U]::mouse_event(4, 0, 0, 0, [System.UIntPtr]::Zero)',   // left up
  ].join('; ');
  spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 20000 });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Who actually lives inside the video window, bottom to top.
 *
 * The design's one open question is sibling z-order: Chromium hosts its
 * compositor in child windows of the BrowserWindow, and mpv --wid adds its
 * own child beside them. Whichever sibling is higher paints over the other,
 * and nothing in either process documents the outcome — so enumerate and see.
 */
const USER32 = '[DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Auto)] public static extern System.IntPtr FindWindowEx(System.IntPtr parent, System.IntPtr after, string cls, string title); [DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Auto)] public static extern int GetClassName(System.IntPtr h, System.Text.StringBuilder s, int n); [DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr h, System.IntPtr after, int x, int y, int w, int hh, uint flags);';

function childWindowsOf(hwnd) {
  const script = [
    `Add-Type -MemberDefinition '${USER32}' -Name U -Namespace W2 -UsingNamespace System.Text`,
    // FindWindowEx walks siblings in Z-ORDER, topmost first — which is the
    // question being asked: who paints over whom.
    '$child = [System.IntPtr]::Zero',
    'do {',
    `  $child = [W2.U]::FindWindowEx([System.IntPtr]${hwnd}, $child, [NullString]::Value, [NullString]::Value)`,
    '  if ($child -ne [System.IntPtr]::Zero) {',
    '    $sb = New-Object System.Text.StringBuilder 256',
    '    [W2.U]::GetClassName($child, $sb, 256) | Out-Null',
    '    Write-Output ("$child|" + $sb.ToString())',
    '  }',
    '} while ($child -ne [System.IntPtr]::Zero)',
  ].join('\n');
  const out = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  return (out.stdout || '').trim().split('\n').filter(Boolean);
}

async function main() {
  makeClip();

  // --- both planes, through the production module --------------------------
  const { video, overlay, showBoth } = createPlanes({
    videoOptions: {
      x: 80, y: 80, useContentSize: true, width: 800, height: 450,
      frame: true,
      // Above her real app if it is running fullscreen — the screenshot must
      // see THESE windows, not whatever is behind them.
      alwaysOnTop: true,
    },
  });

  overlay.loadURL('data:text/html,' + encodeURIComponent(`
    <body style="background:transparent;margin:0;overflow:hidden">
      <button id="badge" style="position:absolute;top:24px;right:24px;width:150px;height:60px;
        background:#00c800;border:0;color:#000;font:700 14px sans-serif"
        onclick="window.__clicks=(window.__clicks||0)+1">INTERFACE</button>
    </body>`));
  showBoth();

  // --- mpv, through the production module ----------------------------------
  const player = await startMpvPlayer({
    hwnd: hwndOf(video),
    logFile: path.join(work, 'mpv-internal.log'),
  });
  await player.command('set_property', 'mute', true);
  await player.command('loadfile', CLIP);

  // Wait until mpv says it is genuinely rendering and time is moving.
  let time = 0;
  let vo = false;
  for (let i = 0; i < 50; i += 1) {
    await sleep(100);
    time = await player.command('get_property', 'playback-time').catch(() => 0) || 0;
    vo = await player.command('get_property', 'vo-configured').catch(() => false);
    if (vo && time > 0.4) break;
  }
  verdict('mpv renders into the given window', Boolean(vo) && time > 0.4,
    `vo-configured=${vo}, playback-time=${Number(time).toFixed(2)}s`);

  console.log('children of the video window, topmost first (mpv must lead):');
  for (const line of childWindowsOf(hwndOf(video))) console.log(`  ${line}`);
  await sleep(600);   // let the raised stack actually present a frame

  // --- pixel evidence, in physical coordinates -----------------------------
  const scale = screen.getPrimaryDisplay().scaleFactor;
  const box = video.getContentBounds();
  const at = (fx, fy) => ({ x: (box.x + box.width * fx) * scale, y: (box.y + box.height * fy) * scale });

  const videoPoint = at(0.3, 0.7);            // clear of the badge: must be the CLIP
  const badgePoint = at(1 - 99 / 800, 54 / 450); // centre of the 150x60 badge at top-right

  const red = screenPixel(videoPoint.x, videoPoint.y);
  verdict('video shows through the transparent plane',
    Boolean(red) && red.r > 150 && red.g < 90 && red.b < 90,
    red ? `rgb(${red.r},${red.g},${red.b}) at 30%,70%` : 'screenshot failed');

  const green = screenPixel(badgePoint.x, badgePoint.y);
  verdict('interface paints ABOVE the video',
    Boolean(green) && green.g > 130 && green.r < 90,
    green ? `rgb(${green.r},${green.g},${green.b}) at badge` : 'screenshot failed');

  // --- input evidence ------------------------------------------------------
  osClick(badgePoint.x, badgePoint.y);
  await sleep(400);
  const clicks = await overlay.webContents.executeJavaScript('window.__clicks || 0');
  verdict('a real OS click lands on the interface plane', clicks >= 1, `clicks=${clicks}`);

  // A failing control for the click check: a point with no button under it
  // must NOT increment the counter — otherwise the counter proves nothing.
  osClick(videoPoint.x, videoPoint.y);
  await sleep(400);
  const after = await overlay.webContents.executeJavaScript('window.__clicks || 0');
  verdict('control: a click off the button does not count', after === clicks, `clicks=${after}`);

  // --- crash recovery, through the production module ------------------------
  // Kill mpv from OUTSIDE (as a crash would), and require the player to come
  // back on its own: restarted fires, commands answer again, the raise is
  // re-applied, and the picture is BACK on screen — the pixel is the proof
  // that recovery is real, not just a reconnected pipe.
  const restarted = new Promise((resolve) => player.on('restarted', resolve));
  spawnSync('taskkill', ['/F', '/IM', 'mpv.exe'], { windowsHide: true, timeout: 15000 });
  await Promise.race([restarted, sleep(15000).then(() => { throw new Error('no restart within 15s'); })]);
  await player.command('set_property', 'mute', true);
  await player.command('loadfile', CLIP);
  let back = null;
  for (let i = 0; i < 50; i += 1) {
    await sleep(150);
    back = screenPixel(videoPoint.x, videoPoint.y);
    if (back && back.r > 150 && back.g < 90) break;
  }
  verdict('after a crash, mpv restarts and the picture returns',
    Boolean(back) && back.r > 150 && back.g < 90 && player.isAlive(),
    back ? `rgb(${back.r},${back.g},${back.b}) post-restart` : 'screenshot failed');

  // --- teardown ------------------------------------------------------------
  player.close();

  const failed = results.filter((r) => !r.pass).length;
  console.log(failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED — see ${work}\\mpv.log`);
  app.exit(failed === 0 ? 0 : 1);
}

// A proof that hangs is a proof that failed.
setTimeout(() => { console.error('TIMEOUT'); app.exit(2); }, 90000);

app.whenReady().then(() => main().catch((error) => {
  console.error(`ERROR: ${error && error.stack ? error.stack : error}`);
  app.exit(3);
}));
