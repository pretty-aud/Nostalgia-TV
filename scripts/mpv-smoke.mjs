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
 * Sample the middle of the app's own window, in TRUE physical pixels.
 *
 * Everything else was tried and each version measured the wrong thing:
 *
 *  - `window.screenX` + devicePixelRatio: her desks are MIXED DPI (a 100%
 *    ultrawide beside a 150% monitor), so DIP and physical coordinates
 *    diverge by monitor, and the arithmetic sampled a point on a different
 *    screen entirely — reporting a black player while photographing a
 *    browser, then a Steam window, then this very conversation.
 *  - a DPI-UNAWARE PowerShell: Windows virtualises its coordinates, so it
 *    and Electron disagreed the moment the window sat on the scaled screen.
 *
 * So: make the probe DPI-aware, ask Windows for the window's rectangle, and
 * sample ITS centre. One coordinate space, no conversions, nothing to get
 * subtly wrong. It also prints every top-level window it saw for the pid,
 * because "which window did you actually look at" is the question every
 * failed pixel check has raised.
 */
function windowProbeScript() {
  return [
    'Add-Type -TypeDefinition @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'using System.Text;',
    'public class NtvProbe {',
    '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }',
    '  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
    '  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string t);',
    '  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int procId);',
    '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);',
    '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
    '  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);',
    '}',
    '"@',
    '[NtvProbe]::SetProcessDPIAware() | Out-Null',
    'Add-Type -AssemblyName System.Drawing',
    '$target = [int]$args[0]',
    '$best = [System.IntPtr]::Zero',
    '$bestArea = -1',
    '$h = [System.IntPtr]::Zero',
    'do {',
    '  $h = [NtvProbe]::FindWindowEx([System.IntPtr]::Zero, $h, [NullString]::Value, [NullString]::Value)',
    '  if ($h -ne [System.IntPtr]::Zero) {',
    '    $owner = 0',
    '    [NtvProbe]::GetWindowThreadProcessId($h, [ref]$owner) | Out-Null',
    '    if ($owner -eq $target -and [NtvProbe]::IsWindowVisible($h)) {',
    '      $r = New-Object NtvProbe+RECT',
    '      [NtvProbe]::GetWindowRect($h, [ref]$r) | Out-Null',
    '      $sb = New-Object System.Text.StringBuilder 256',
    '      [NtvProbe]::GetClassName($h, $sb, 256) | Out-Null',
    '      $w = $r.Right - $r.Left',
    '      $ht = $r.Bottom - $r.Top',
    '      Write-Output ("WINDOW {0} class={1} owned={2} rect={3},{4} {5}x{6}" -f $h, $sb.ToString(), ([NtvProbe]::GetWindow($h, 4) -ne [System.IntPtr]::Zero), $r.Left, $r.Top, $w, $ht)',
    '      if ($w * $ht -gt $bestArea) { $bestArea = $w * $ht; $best = $h }',
    '    }',
    '  }',
    '} while ($h -ne [System.IntPtr]::Zero)',
    'if ($best -eq [System.IntPtr]::Zero) { Write-Output "NOWINDOW"; exit }',
    '$r = New-Object NtvProbe+RECT',
    '[NtvProbe]::GetWindowRect($best, [ref]$r) | Out-Null',
    '$cx = [int](($r.Left + $r.Right) / 2)',
    '$cy = [int](($r.Top + $r.Bottom) / 2)',
    '$bmp = New-Object System.Drawing.Bitmap(1, 1)',
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$g.CopyFromScreen($cx, $cy, 0, 0, $bmp.Size)',
    '$p = $bmp.GetPixel(0, 0)',
    'Write-Output ("SAMPLE {0},{1},{2} at {3},{4}" -f $p.R, $p.G, $p.B, $cx, $cy)',
  ].join('\n');
}

let probePath = null;
function sampleAppCentre(pid, { verbose = false } = {}) {
  if (!probePath) {
    probePath = path.join(work, 'probe.ps1');
    fs.writeFileSync(probePath, windowProbeScript(), 'utf8');
  }
  const out = spawnSync('powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', probePath, String(pid)],
    { encoding: 'utf8', windowsHide: true, timeout: 25000 });
  const text = `${out.stdout || ''}${out.stderr || ''}`;
  if (verbose) console.error(text.trim());
  const match = /SAMPLE (\d+),(\d+),(\d+) at (-?\d+),(-?\d+)/.exec(text);
  if (!match) return null;
  return {
    r: +match[1], g: +match[2], b: +match[3], at: `${match[4]},${match[5]}`,
  };
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
      // THE INTERFACE PLANE, specifically. Two pages exist now that the video
      // plane is shown first, and its black placeholder is a page too — an
      // unqualified find attached to it and reported an app with no
      // window.tv and no view, which is true of a plane that holds neither.
      const page = pages.find((p) => p.type === 'page' && p.webSocketDebuggerUrl
        && /index\.html/.test(p.url || ''));
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
      // The app places itself on the secondary screen and stays on top:
      // hunting its windows from outside kept moving the wrong one.
      env: { ...process.env, NTV_PROFILE: profile, NTV_SMOKE_PLACE: 'secondary' },
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
    const isFixtureColour = (p) => Boolean(p)
      && ((p.r > 110 && p.g < 90 && p.b < 90)      // Show Alpha: red
        || (p.b > 110 && p.r < 90 && p.g < 90));   // Show Beta: blue

    let picture = null;
    for (let i = 0; i < 15 && !isFixtureColour(picture); i += 1) {
      await sleep(300);
      picture = sampleAppCentre(child.pid);
    }
    if (!isFixtureColour(picture)) {
      // The verbose pass prints every window the probe saw for this pid —
      // handle, class, owned-or-not, and rectangle — so "which window did
      // it look at?" is answered instead of guessed.
      sampleAppCentre(child.pid, { verbose: true });
    }
    verdict('the PICTURE is on screen, not just decoding',
      isFixtureColour(picture),
      picture ? `centre pixel rgb(${picture.r},${picture.g},${picture.b}) at ${picture.at}` : 'probe found no window');

    // …and it survives a resize, which is when Chromium re-asserts its
    // compositor child over mpv. The one-shot raise passed the old harness
    // and still lost the picture minutes into a real session.
    await evaluate(ws, 'window.tv.toggleMaximizeWindow()');
    let afterResize = null;
    for (let i = 0; i < 15 && !isFixtureColour(afterResize); i += 1) {
      await sleep(400);
      afterResize = sampleAppCentre(child.pid);
    }
    verdict('the picture SURVIVES a maximize (the raise holds)',
      isFixtureColour(afterResize),
      afterResize ? `centre pixel rgb(${afterResize.r},${afterResize.g},${afterResize.b}) at ${afterResize.at}` : 'probe found no window');
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
