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
    settings: { mode: 'deck', bumperSeconds: 2, bumperEnabled: true },
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

  const child = spawn(
    path.join(root, 'node_modules', '.bin', 'electron.cmd'),
    ['.', `--remote-debugging-port=${CDP_PORT}`],
    {
      cwd: root,
      env: { ...process.env, NTV_PROFILE: profile },
      stdio: ['ignore', fs.openSync(path.join(work, 'app.out.log'), 'w'), fs.openSync(path.join(work, 'app.err.log'), 'w')],
      windowsHide: true,
      shell: true,
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
