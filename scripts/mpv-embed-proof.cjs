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
const { spawn, spawnSync } = require('node:child_process');
const { app, BrowserWindow, screen } = require('electron');

const root = path.join(__dirname, '..');
const work = path.join(os.tmpdir(), 'ntv-mpv-proof');
fs.mkdirSync(work, { recursive: true });
app.setPath('userData', path.join(work, 'profile'));

const { connectMpv } = require(path.join(root, 'electron', 'mpvClient.js'));

const MPV = path.join(root, 'vendor', 'mpv', 'mpv.exe');
const FFMPEG = path.join(root, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const PIPE = `\\\\.\\pipe\\ntv-proof-${process.pid}`;
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

/**
 * Raise mpv's child window above Chromium's compositor child.
 *
 * Chromium hosts the page in its own child windows of the BrowserWindow, and
 * they arrive ABOVE the child mpv creates for --wid — so the page's opaque
 * background paints over the video, which mpv itself never notices (it keeps
 * reporting vo-configured and advancing time, rendering underneath). One
 * SetWindowPos to the top of the sibling stack is the whole fix; the video
 * window's DOM is deliberately unused, so nothing of value is covered.
 */
function raiseMpvChild(parentHwnd) {
  const script = [
    `Add-Type -MemberDefinition '${USER32}' -Name U -Namespace W3`,
    `$mpv = [W3.U]::FindWindowEx([System.IntPtr]${parentHwnd}, [System.IntPtr]::Zero, 'mpv', [NullString]::Value)`,
    'if ($mpv -eq [System.IntPtr]::Zero) { Write-Output "NOTFOUND"; exit }',
    // HWND_TOP = 0; SWP_NOMOVE(2) | SWP_NOSIZE(1) | SWP_NOACTIVATE(0x10)
    '[W3.U]::SetWindowPos($mpv, [System.IntPtr]::Zero, 0, 0, 0, 0, 0x13) | Out-Null',
    'Write-Output "RAISED $mpv"',
  ].join('\n');
  const out = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  return (out.stdout || '').trim();
}

async function main() {
  makeClip();

  // --- the video plane -----------------------------------------------------
  const video = new BrowserWindow({
    x: 80, y: 80, useContentSize: true, width: 800, height: 450,
    backgroundColor: '#0000c8', frame: true, show: true,
    // Above her real app if it is running fullscreen — the screenshot must
    // see THESE windows, not whatever is behind them.
    alwaysOnTop: true,
  });
  // BLUE on purpose, unlike anything else on stage: a blue pixel where the
  // clip should be says "Chromium's own surface is covering mpv's window",
  // black says the capture saw neither, red says the planes composite.
  video.loadURL('data:text/html,<body style="background:%230000c8;margin:0"></body>');

  // --- mpv into it ---------------------------------------------------------
  const mpvLog = fs.openSync(path.join(work, 'mpv.log'), 'w');
  const mpv = spawn(MPV, [
    `--wid=${hwndOf(video)}`,
    `--input-ipc-server=${PIPE}`,
    '--no-config', '--no-osc', '--no-input-default-bindings', '--input-vo-keyboard=no',
    '--mute=yes', '--keep-open=yes', '--idle=yes',
    `--log-file=${path.join(work, 'mpv-internal.log')}`, '--msg-level=all=v',
  ], { windowsHide: true, stdio: ['ignore', mpvLog, mpvLog] });
  const mpvExit = new Promise((resolve) => mpv.on('exit', resolve));

  const client = await connectMpv(PIPE, { connectTimeoutMs: 10000 });
  await client.command('loadfile', CLIP);

  // Wait until mpv says it is genuinely rendering and time is moving.
  let time = 0;
  let vo = false;
  for (let i = 0; i < 50; i += 1) {
    await sleep(100);
    time = await client.command('get_property', 'playback-time').catch(() => 0) || 0;
    vo = await client.command('get_property', 'vo-configured').catch(() => false);
    if (vo && time > 0.4) break;
  }
  verdict('mpv renders into the given window', Boolean(vo) && time > 0.4,
    `vo-configured=${vo}, playback-time=${Number(time).toFixed(2)}s`);

  // Diagnostics: prove the HWND we handed mpv is the window we think it is,
  // and ask the OS where mpv's windows actually went.
  video.setTitle('NTV-VIDEO-PLANE');
  const probe = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', [
    `Add-Type -MemberDefinition '${USER32}' -Name U -Namespace W4 -UsingNamespace System.Text`,
    '$find = [W4.U]::FindWindowEx([System.IntPtr]::Zero, [System.IntPtr]::Zero, [NullString]::Value, "NTV-VIDEO-PLANE")',
    'Write-Output ("findwindow=" + $find)',
    `$p = Get-Process -Id ${mpv.pid} -ErrorAction SilentlyContinue`,
    'Write-Output ("mpv-mainwindow=" + $p.MainWindowHandle + " title=" + $p.MainWindowTitle)',
  ].join('\n')], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  console.log(`our hwnd=${hwndOf(video)}`);
  console.log((probe.stdout || '').trim());
  if (probe.stderr && probe.stderr.trim()) console.log(`probe stderr: ${probe.stderr.trim().slice(0, 300)}`);

  console.log('children of the video window, topmost first, BEFORE the raise:');
  for (const line of childWindowsOf(hwndOf(video))) console.log(`  ${line}`);
  console.log(`raise: ${raiseMpvChild(hwndOf(video))}`);
  console.log('children AFTER the raise:');
  for (const line of childWindowsOf(hwndOf(video))) console.log(`  ${line}`);
  await sleep(600);   // let the reordered stack actually present a frame

  // --- the interface plane -------------------------------------------------
  const overlay = new BrowserWindow({
    parent: video, transparent: true, frame: false, resizable: false,
    hasShadow: false, show: true,
  });
  overlay.setBounds(video.getContentBounds());
  overlay.loadURL('data:text/html,' + encodeURIComponent(`
    <body style="background:transparent;margin:0;overflow:hidden">
      <button id="badge" style="position:absolute;top:24px;right:24px;width:150px;height:60px;
        background:#00c800;border:0;color:#000;font:700 14px sans-serif"
        onclick="window.__clicks=(window.__clicks||0)+1">INTERFACE</button>
    </body>`));
  await sleep(1200);   // let both planes actually paint

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

  // --- teardown ------------------------------------------------------------
  client.close();
  mpv.kill();
  await Promise.race([mpvExit, sleep(2000)]);
  fs.closeSync(mpvLog);

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
