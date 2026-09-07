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

/**
 * The children of the app's video plane, front of the z-order first.
 *
 * This is the only thing that separates the two causes of a black sample:
 * mpv's --wid child and Chromium's "Intermediate D3D Window" are siblings
 * inside that window, and whichever is first is the one on screen. If mpv is
 * first and sized to the window, nothing is covering it — a black sample then
 * means the SCREEN CAPTURE could not read mpv's swapchain, not that the
 * picture is gone.
 */
function childZOrder(pid) {
  const script = [
    'Add-Type -TypeDefinition @"',
    'using System; using System.Runtime.InteropServices; using System.Text;',
    'public class NtvZ {',
    '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }',
    '  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
    '  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string t);',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint procId);',
    '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
    '  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);',
    '  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);',
    '}',
    '"@',
    '[NtvZ]::SetProcessDPIAware() | Out-Null',
    '$target = [int]$args[0]',
    '$best = [System.IntPtr]::Zero; $bestArea = -1',
    '$h = [System.IntPtr]::Zero',
    'do {',
    '  $h = [NtvZ]::FindWindowEx([System.IntPtr]::Zero, $h, [NullString]::Value, [NullString]::Value)',
    '  if ($h -ne [System.IntPtr]::Zero) {',
    '    $o = 0; [NtvZ]::GetWindowThreadProcessId($h, [ref]$o) | Out-Null',
    '    if ($o -eq $target -and [NtvZ]::IsWindowVisible($h) -and ([NtvZ]::GetWindow($h, 4) -eq [System.IntPtr]::Zero)) {',
    '      $r = New-Object NtvZ+RECT; [NtvZ]::GetWindowRect($h, [ref]$r) | Out-Null',
    '      $a = ($r.Right - $r.Left) * ($r.Bottom - $r.Top)',
    '      if ($a -gt $bestArea) { $bestArea = $a; $best = $h }',
    '    }',
    '  }',
    '} while ($h -ne [System.IntPtr]::Zero)',
    'if ($best -eq [System.IntPtr]::Zero) { Write-Output "  no video plane found"; exit }',
    '$c = [System.IntPtr]::Zero',
    'do {',
    '  $c = [NtvZ]::FindWindowEx($best, $c, [NullString]::Value, [NullString]::Value)',
    '  if ($c -ne [System.IntPtr]::Zero) {',
    '    $sb = New-Object System.Text.StringBuilder 256',
    '    [NtvZ]::GetClassName($c, $sb, 256) | Out-Null',
    '    $r = New-Object NtvZ+RECT; [NtvZ]::GetWindowRect($c, [ref]$r) | Out-Null',
    '    Write-Output ("  child class={0} visible={1} {2}x{3}" -f $sb.ToString(), [NtvZ]::IsWindowVisible($c), ($r.Right - $r.Left), ($r.Bottom - $r.Top))',
    '  }',
    '} while ($c -ne [System.IntPtr]::Zero)',
  ].join('\n');
  const zPath = path.join(work, 'zorder.ps1');
  fs.writeFileSync(zPath, script, 'utf8');
  const out = spawnSync('powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', zPath, String(pid)],
    { encoding: 'utf8', windowsHide: true, timeout: 25000 });
  console.error(`${out.stdout || ''}${out.stderr || ''}`.trimEnd());
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

/**
 * Two tiny shows, a bumper and a promo — 6-second episodes so transitions
 * happen while we watch, distinct colours so a failure names its file.
 *
 * The EPISODES carry two audio tracks (English + Japanese) and an English
 * subtitle track, because single-language fixtures cannot tell a working
 * track menu from an empty one — and an empty track menu is exactly what
 * shipped past this harness to a viewer whose anime is all dual-audio.
 *
 * Rebuilt every run: a cached library from an older shape would quietly
 * keep testing yesterday's fixtures.
 */
async function makeLibrary() {
  await fsp.rm(library, { recursive: true, force: true });
  for (const dir of ['Show Alpha', 'Show Beta', 'BUMPERS', 'PROMOS']) {
    await fsp.mkdir(path.join(library, dir), { recursive: true });
  }

  const srt = path.join(work, 'subs.srt');
  fs.writeFileSync(srt, '1\n00:00:00,000 --> 00:00:30,000\nFIXTURE SUBTITLE\n');

  const run = (args, what) => {
    const made = spawnSync(FFMPEG, args, { windowsHide: true, timeout: 90000 });
    if (made.error || made.status !== 0) {
      throw new Error(`could not generate ${what}: ${(made.stderr || '').toString().slice(-300)}`);
    }
  };

  /** An episode: solid colour, eng + jpn audio, one English subtitle track. */
  const episode = (out, color, seconds) => run([
    '-y',
    '-f', 'lavfi', '-i', `color=c=${color}:s=320x180:d=${seconds}:r=30`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=880:duration=${seconds}`,
    '-i', srt,
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=jpn',
    '-metadata:s:s:0', 'language=eng',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-c:s', 'srt',
    out,
  ], out);

  /** An interstitial: one track, nothing to choose. */
  const clip = (out, color, seconds) => run([
    '-y',
    '-f', 'lavfi', '-i', `color=c=${color}:s=320x180:d=${seconds}:r=30`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-shortest', '-pix_fmt', 'yuv420p', '-c:a', 'aac', out,
  ], out);

  episode(path.join(library, 'Show Alpha', 'Alpha S01E01.mkv'), 'red', 6);
  episode(path.join(library, 'Show Alpha', 'Alpha S01E02.mkv'), 'darkred', 6);
  episode(path.join(library, 'Show Beta', 'Beta S01E01.mkv'), 'blue', 6);
  episode(path.join(library, 'Show Beta', 'Beta S01E02.mkv'), 'darkblue', 6);
  clip(path.join(library, 'BUMPERS', 'sting.mp4'), 'green', 2);
  clip(path.join(library, 'PROMOS', 'promo.mp4'), 'purple', 3);
}

/** Pre-seed the profile: root chosen, bumper card short, saves verifiable. */
/**
 * Where the fixture music lives. Made before boot — see makeMusic.
 *
 * NTV_SMOKE_MUSIC points it at a real folder instead. The synthetic tone is
 * what makes the assertions arithmetic, so pointing this elsewhere gives up
 * the "did it choose the loud part" check — it is for LISTENING, paired with
 * NTV_SMOKE_AUDIBLE, when the question is how a real bumper sounds rather
 * than whether the machinery works.
 */
const realMusic = process.env.NTV_SMOKE_MUSIC || '';
const musicDir = realMusic || path.join(work, 'music');
const tonePath = path.join(musicDir, 'loud-in-the-middle.mp3');

/**
 * SILENT BY DEFAULT, and that is deliberate — see the note in seedProfile.
 * NTV_SMOKE_AUDIBLE=1 turns the sound on for a run where somebody is sitting
 * there on purpose to hear it, which is the only way to prove the last inch:
 * everything else here proves mpv decoded the file and landed on the right
 * second, and none of it proves sound reached a speaker.
 */
const audible = process.env.NTV_SMOKE_AUDIBLE === '1';

/**
 * A track with a KNOWN shape: sixty seconds, quiet except from 20s to 40s.
 *
 * Synthetic on purpose. Against a real song the only assertion available is
 * "some number came back"; against this one the right answer is arithmetic —
 * the clip is fifteen seconds, so the only window fitting entirely inside the
 * loud stretch starts between 20 and 25.
 */
async function makeMusic() {
  // A real folder is HERS. Never delete it, never write a tone into it.
  if (realMusic) return;
  await fsp.rm(musicDir, { recursive: true, force: true });
  await fsp.mkdir(musicDir, { recursive: true });
  spawnSync(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi',
    '-i', "aevalsrc='0.5*sin(2*PI*440*t)*(0.05+0.95*between(t,20,40))':d=60",
    '-b:a', '96k', tonePath,
  ], { windowsHide: true, timeout: 60000 });
}

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
    settings: {
      mode: 'deck',
      bumperSeconds: 2,
      bumperEnabled: true,
      muted: !audible,
      volume: audible ? 70 : 0,
      /**
       * WRITTEN INTO THE SAVED FILE, not handed over IPC later — because that
       * is the only route besides the folder dialog, and the dialog cannot be
       * opened from a script. So this exercises the boot restore, which is
       * the path a restart takes and the one whose absence would leave the
       * music working for exactly one session.
       *
       * Found by doing it the other way first: creating the folder after boot
       * and passing the path in returned null from every deal, which is the
       * allowedRoots gate behaving exactly as designed.
       */
      bumperMusicDir: musicDir,
    },
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
  // Before seedProfile, because the profile has to name a folder that exists.
  await makeMusic();
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
    if (!isFixtureColour(afterResize)) {
      /**
       * A BLACK SAMPLE HERE HAS TWO CAUSES AND THEY LOOK IDENTICAL. Read this
       * before spending an hour on it, because one session already did.
       *
       *  1. The picture really is covered — Chromium's compositor child got
       *     back on top of mpv. The bug this check exists for.
       *  2. THE MEASUREMENT LIED. CopyFromScreen is a BitBlt, and a GPU
       *     swapchain is not always readable that way. Maximising can flip
       *     mpv's presentation into a mode BitBlt reads as pure black while
       *     the picture is perfectly fine on screen.
       *
       * Observed: five consecutive failures, then three consecutive passes,
       * with no code change between them. During the failures mpv's own log
       * had zero errors and reported video=playing throughout.
       *
       * THE DISCRIMINATOR is z-order and size, printed below. If mpv's child
       * is FIRST in the list and sized to the window, nothing is covering it
       * and cause 2 is your answer — re-run before believing this check. If
       * mpv is behind "Intermediate D3D Window", or sized to the OLD window,
       * it is cause 1 and it is real.
       */
      console.error('  the sample was black — printing every window and mpv child z-order.');
      console.error('  mpv FIRST and full-size => the capture lied, re-run. mpv behind => real.');
      sampleAppCentre(child.pid, { verbose: true });
      childZOrder(child.pid);
    }
    verdict('the picture SURVIVES a maximize (the raise holds)',
      isFixtureColour(afterResize),
      afterResize ? `centre pixel rgb(${afterResize.r},${afterResize.g},${afterResize.b}) at ${afterResize.at}` : 'probe found no window');
    await evaluate(ws, 'window.tv.toggleMaximizeWindow()');
    await sleep(800);

    /**
     * THE TRACK MENUS LIST WHAT THE FILE HAS.
     *
     * Invisible to every earlier check because the fixtures had one audio
     * track and no subtitles — nothing to choose, so an empty menu and a
     * correct menu looked identical. Her library is dual-audio anime; she
     * opened the menu and found nothing to pick.
     */
    const menus = JSON.parse(await evaluate(ws, `JSON.stringify({
      audio: Array.from(document.querySelectorAll('#audioTrackList button')).map((b) => b.textContent),
      subs: Array.from(document.querySelectorAll('#subTrackList button')).map((b) => b.textContent),
    })`));
    if (menus.audio.length === 0) {
      // Ask mpv directly, from the page, so the answer separates "the IPC
      // is broken" from "nothing ever asked".
      await evaluate(ws, `window.__TL = 'pending';
        window.tv.mpvTrackList().then(
          (l) => { window.__TL = JSON.stringify((l || []).map((t) => t.type + ':' + (t.lang || '?'))); },
          (e) => { window.__TL = 'ERR ' + e.message; });
        true`);
      await sleep(700);
      console.error(`mpv track-list from the page: ${await evaluate(ws, 'window.__TL')}`);
    }
    const audioText = menus.audio.join(' | ');
    const subText = menus.subs.join(' | ');
    verdict("the audio menu lists the file's languages",
      menus.audio.length >= 2 && /English/.test(audioText) && /Japanese/.test(audioText),
      `audio: [${audioText}]`);
    verdict("the subtitle menu lists the file's subtitle track",
      menus.subs.length >= 2 && /English/.test(subText),
      `subs: [${subText}]`);

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

    /**
     * ── THE CARD ITSELF, driven by the channel ────────────────────────────
     *
     * Everything below this in the music block tests the four links in
     * isolation, by calling mpvOpen directly. That is not the same as the
     * card doing it: it proves the plumbing works when something pulls it,
     * and says nothing about whether the bumper actually pulls it.
     *
     * So the style is changed THROUGH THE SETTINGS UI, the way she would,
     * and then the next episode is allowed to end on its own. What follows
     * has to be the whole thing — card up, music running from the chosen
     * point, three beats in order, and the channel carrying on afterwards.
     */
    await evaluate(ws, `document.getElementById('btnSettings').click();
      const sel = document.getElementById('bumperStyleSelect');
      sel.value = 'cewr';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('btnCloseSettings').click();
      true`);
    const styleSet = await evaluate(ws,
      "JSON.parse(document.getElementById('app').dataset.bumperStyle || 'null') , "
      + "document.getElementById('bumperStyleSelect').value");
    verdict('the style can be changed to it from the settings panel',
      styleSet === 'cewr', `select reads "${styleSet}"`);

    // Watch mpv AND the beats from the moment the style changes, so nothing
    // has to be timed from outside.
    await evaluate(ws, `window.__CEWR = { pos: [], beats: [] };
      window.tv.onMpvProp((name, value) => {
        if (name === 'time-pos' && typeof value === 'number') window.__CEWR.pos.push(value);
      });
      window.__CEWR.timer = setInterval(() => {
        const at = (id) => !document.getElementById(id).hidden;
        const shape = [at('asbumpStandby'), at('asbumpSched'), at('asbumpSign')].join(',');
        const seen = window.__CEWR.beats;
        if (seen[seen.length - 1] !== shape) seen.push(shape);
      }, 120);
      true`);

    // The 6-second episode runs out and the card takes over.
    const cardUp = await until(ws, 'the schedule card',
      "(!document.getElementById('asbump').hidden) ? 'up' : ''", 40000);
    verdict('the channel raised the schedule card by itself', cardUp === 'up');

    verdict('the still card is not showing underneath it',
      await evaluate(ws, "document.getElementById('bumper').getBoundingClientRect().height === 0"));

    /**
     * The music the CARD started, not the one this script started. The tone
     * is loud only from 20s to 40s and the picker chooses inside that, so any
     * position below 18 means the card opened the file at the top — or opened
     * something else entirely.
     *
     * THE BUFFER IS CLEARED FIRST, and that is not tidiness. Sampling the
     * tail of everything collected since the style changed reported 2.80s and
     * called the card broken — those were the OUTGOING EPISODE's positions,
     * still arriving as the card came up, and a six-second fixture episode
     * reaching 2.8s looks exactly like an mp3 that ignored its start offset.
     * Clearing on the card's appearance is what makes the next reading
     * unambiguously the music's.
     */
    await evaluate(ws, 'window.__CEWR.pos.length = 0, true');
    await sleep(1500);
    const duringCard = JSON.parse(await evaluate(ws,
      'JSON.stringify(window.__CEWR.pos.slice(-12))'));
    const lowest = duringCard.length ? Math.min(...duringCard) : null;
    if (!realMusic) verdict('the card is playing music from the chosen point',
      lowest !== null && lowest >= 18,
      lowest === null ? 'mpv reported no position during the card'
        : `time-pos ${lowest.toFixed(2)}s (the loud stretch is 20s to 40s)`);

    // Let it run to the mark, then off.
    const signUp = await until(ws, 'the sign-off',
      "(!document.getElementById('asbumpSign').hidden) ? 'up' : ''", 20000);
    verdict('it reaches the sign-off mark', signUp === 'up');

    const beats = JSON.parse(await evaluate(ws,
      'clearInterval(window.__CEWR.timer), JSON.stringify(window.__CEWR.beats)'));
    /**
     * Each beat alone, in order, with nothing doubled up. "true,true,false"
     * anywhere means two beats were on screen at once, which is the failure
     * that looks like the card being broken rather than being late.
     */
    const wanted = ['true,false,false', 'false,true,false', 'false,false,true'];
    const ordered = wanted.every((shape, i) => beats.indexOf(shape) > -1
      && (i === 0 || beats.indexOf(shape) > beats.indexOf(wanted[i - 1])));
    const doubled = beats.some((shape) => shape.split(',').filter((v) => v === 'true').length > 1);
    verdict('the three beats ran in order, one at a time',
      ordered && !doubled, beats.join(' → '));

    const afterCard = await until(ws, 'the channel carrying on',
      `(document.getElementById('app').dataset.view === 'playing'
        && document.getElementById('asbump').hidden)
        ? document.getElementById('npShow').textContent : ''`, 25000);
    verdict('the channel carries on into the next programme afterwards',
      Boolean(afterCard), afterCard || 'the card never handed back');

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

    /**
     * ── BUMPER MUSIC: does a track actually PLAY, at the chosen point? ─────
     *
     * Everything up to here about the music had been proven on paper. The
     * hook picker was measured against real songs, and the card was proven to
     * call mpvOpen with a finite offset — but by a probe that had REPLACED
     * mpvOpen with a recorder, so no audio ever left the machine and the
     * chain from that call to a sound had never run once.
     *
     * Four links, each of which can fail silently:
     *   1. the analysis returns an offset for a file it has never seen
     *   2. allowedRoots lets an mp3 outside the library through at all
     *   3. mpv accepts start= and lands there rather than at zero
     *   4. it decodes audio rather than opening a file with nothing in it
     *
     * The fixture is a SYNTHETIC track with a known shape — sixty seconds,
     * quiet except for a loud stretch from 20s to 40s — so the expected
     * answer is arithmetic rather than taste. Against a real song the only
     * available assertion is "some number came back".
     *
     * Muted throughout, like the rest of this file. Muting does not stop mpv
     * decoding, advancing time-pos, or reporting its tracks, so every link
     * above is still proven; what is not proven is that sound reaches the
     * speakers, and that is hers to confirm.
     */
    const madeTone = realMusic ? true : fs.existsSync(tonePath);
    if (realMusic) {
      console.log(`      her own folder, so the known-shape checks are skipped: ${realMusic}`);
    } else {
      verdict('a fixture track with a known loud section was made', madeTone,
        madeTone ? `${Math.round(fs.statSync(tonePath).size / 1024)}kb` : 'ffmpeg produced nothing');
    }

    if (madeTone) {
      const dirJson = JSON.stringify(musicDir);
      await evaluate(ws, `window.__M = 'pending';
        window.tv.nextBumperMusic(${dirJson}, null).then(
          (m) => { window.__M = m ? JSON.stringify(m) : 'null'; },
          (e) => { window.__M = 'ERR ' + e.message; });
        true`);
      await until(ws, 'the music pick', "window.__M !== 'pending' ? window.__M : ''", 30000);
      const pickRaw = await evaluate(ws, 'window.__M');
      let pick = null;
      try { pick = JSON.parse(pickRaw); } catch { /* left null: reported below */ }

      verdict('a track is dealt from the folder with a start offset',
        Boolean(pick && pick.absPath && Number.isFinite(pick.startSeconds)),
        pick ? `${path.basename(pick.absPath)} @ ${pick.startSeconds}s` : pickRaw);

      // The loud stretch runs 20s to 40s and the clip is 15s, so the only
      // window that fits entirely inside it starts between 20 and 25.
      if (!realMusic) verdict('the hook lands in the loud part of the track, not the intro',
        Boolean(pick && pick.startSeconds >= 18 && pick.startSeconds <= 26),
        pick ? `chose ${pick.startSeconds}s (loud from 20s to 40s)` : 'no pick');

      if (pick && pick.absPath) {
        /**
         * time-pos through onMpvProp — a verb the renderer already uses, so
         * this needs no test-only surface. It is also the only way to see
         * WHERE mpv started: a file that opened at zero and one that opened
         * at the chosen offset are identical from every other angle.
         */
        await evaluate(ws, `window.__POS = [];
          window.tv.onMpvProp((name, value) => {
            if (name === 'time-pos' && typeof value === 'number') window.__POS.push(value);
          });
          window.tv.mpvOpen(${JSON.stringify(pick.absPath)}, { startSeconds: ${pick.startSeconds} })
            .then(() => { window.__OPEN = 'ok'; }, (e) => { window.__OPEN = 'ERR ' + e.message; });
          true`);
        await until(ws, 'the open to settle', "window.__OPEN || ''", 20000);
        const opened = await evaluate(ws, 'window.__OPEN');

        // 'Forbidden' here means allowedRoots refused it — the failure a
        // restart would have caused if the boot restore were missing.
        verdict('mpv accepted the track (allowedRoots let it through)',
          opened === 'ok', opened);

        await sleep(3000);
        const positions = JSON.parse(await evaluate(ws, 'JSON.stringify(window.__POS.slice(0, 40))'));
        const first = positions.length ? Math.min(...positions) : null;
        verdict('playback STARTED at the chosen point, not at the beginning',
          first !== null && Math.abs(first - pick.startSeconds) < 3,
          first === null ? 'mpv reported no time-pos at all'
            : `first time-pos ${first.toFixed(2)}s vs chosen ${pick.startSeconds}s`);

        const last = positions.length ? Math.max(...positions) : null;
        verdict('the music is RUNNING, not parked on one frame',
          first !== null && last - first > 0.5,
          first === null ? 'no time-pos' : `advanced ${(last - first).toFixed(2)}s in 3s`);

        await evaluate(ws, `window.__AT = 'pending';
          window.tv.mpvTrackList().then(
            (l) => { window.__AT = JSON.stringify((l || []).map((t) => t.type)); },
            (e) => { window.__AT = 'ERR ' + e.message; });
          true`);
        await until(ws, 'the track list', "window.__AT !== 'pending' ? window.__AT : ''", 20000);
        const kinds = await evaluate(ws, 'window.__AT');
        // An audio track and no video: an mp3 with cover art would report a
        // video stream too, which is the thing that would put a still image
        // on screen under the card instead of black.
        verdict('it is decoding AUDIO, with no video stream to show',
          /"audio"/.test(kinds) && !/"video"/.test(kinds), `tracks: ${kinds}`);

        await evaluate(ws, 'window.tv.mpvStop() && true').catch(() => {});
      }
    }
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
