/**
 * Run the box office against REAL content, on the second monitor, to watch.
 *
 *   node scripts/boxoffice-demo.mjs
 *
 * The smoke proves the machinery on a fixture library of six-second colour
 * bars. That is the right fixture for a test and the wrong one for a look:
 * the whole question about this card is how it reads over an actual frame of
 * an actual programme, and coloured bars cannot answer it.
 *
 * So this boots the real app against her own library, sets the style, and then
 * SEEKS TO THE END of each episode so the card comes round every few seconds
 * instead of every twenty-six minutes. The app
 * is left running at the end for her to watch; it does not close itself.
 *
 * A SCRATCH PROFILE throughout (NTV_PROFILE), so her real state — every show's
 * place, her settings, her artwork — is never touched by any of this.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = path.join(os.tmpdir(), 'ntv-boxoffice-demo');
/**
 * HER REAL LIBRARY, not a copy and not junctions.
 *
 * Junctions were the obvious way to make a small demo library out of two of
 * her shows, and the scan found nothing: Node reports a junction as
 * isSymbolicLink, not isDirectory, and main.js only descends into directories.
 * Worth knowing beyond this script — a library organised with junctions would
 * come up empty in the app with no error.
 */
const library = process.env.NTV_DEMO_LIBRARY || 'H:/TVandFilms';
const profile = path.join(work, 'profile');
const CDP_PORT = 9224;          // not the smoke's, so both can exist at once

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (line) => console.log(line);

// -- a minimal CDP client ---------------------------------------------------

let seq = 0;
function evaluate(ws, expression) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CDP timeout: ${expression.slice(0, 50)}`)), 20000);
    const onMessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
      if (message.error) { reject(new Error(message.error.message)); return; }
      const result = message.result && message.result.result;
      if (result && result.subtype === 'error') { reject(new Error(result.description)); return; }
      resolve(result ? result.value : undefined);
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({
      id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true },
    }));
  });
}

async function connect() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
      // The INTERFACE plane. The video plane is a page too, and it holds
      // neither window.tv nor any view.
      const page = pages.find((p) => p.type === 'page' && p.webSocketDebuggerUrl
        && /index\.html/.test(p.url || ''));
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
        return ws;
      }
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error('the app never came up on CDP');
}

async function until(ws, what, expression, ms = 30000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await evaluate(ws, expression).catch(() => '');
    if (value) return value;
    await sleep(400);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// -- the run ----------------------------------------------------------------

async function main() {
  if (!fs.existsSync(library)) {
    throw new Error(`no library at ${library} — is the drive attached?`);
  }
  say(`library: ${library}`);

  await fsp.rm(profile, { recursive: true, force: true });
  await fsp.mkdir(profile, { recursive: true });
  await fsp.writeFile(path.join(profile, 'channel-state.json'), JSON.stringify({
    version: 1,
    rootPath: library,
    cursors: {},
    history: [],
    queue: [],
    settings: {
      mode: 'deck',
      bumperStyle: 'boxoffice',
      bumperBackground: 'video',
      bumperEnabled: true,
      // AUDIBLE. The point of watching this is the cue under the animation,
      // and the smoke's default silence would make it a mime.
      muted: false,
      volume: 65,
      // The interstitials before the card are what give the transcode its head
      // start, so they stay on — turning them off would hide the very thing
      // the timing depends on.
      bumperClipsEnabled: true,
      promosEnabled: true,
      moviesEnabled: false,
    },
  }));

  const child = spawn(
    path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
    ['.', `--remote-debugging-port=${CDP_PORT}`],
    {
      cwd: root,
      env: { ...process.env, NTV_PROFILE: profile, NTV_SMOKE_PLACE: 'secondary' },
      stdio: ['ignore',
        fs.openSync(path.join(work, 'app.out.log'), 'w'),
        fs.openSync(path.join(work, 'app.err.log'), 'w')],
      windowsHide: true,
      shell: false,
    },
  );

  const ws = await connect();
  say('app up on the second monitor');

  await until(ws, 'the library scan', "document.getElementById('app').dataset.view === 'ready' ? 'ready' : ''", 240000);
  const counted = await evaluate(ws, "document.getElementById('readyStats') ? document.getElementById('readyStats').textContent : ''");
  say(`library: ${counted || 'scanned'}`);

  // The ready screen's button has no id — the smoke reaches it the same way.
  await evaluate(ws, "document.querySelector('.welcome__inner button').click(); true");
  await until(ws, 'the first programme', "document.getElementById('app').dataset.view === 'playing' ? 'playing' : ''", 40000);

  /**
   * Four cards. Each one: skip to just before the episode ends, let the chain
   * run, and report what the card actually did.
   *
   * Four rather than one because the first is the only one with a cold cache —
   * and "is it ready in time" is the whole question the prepare-ahead exists
   * to answer, so a run that only ever saw a cold start would answer half of
   * it and a run that only saw warm starts would answer none.
   */
  /**
   * Watch the duration once, not once per round.
   *
   * mpv reports it through the same property feed the transport already reads,
   * so this needs no test-only surface — and registering the listener inside
   * the loop would stack a fresh one on every card.
   */
  /**
   * COUNT the duration reports, do not reset a value and wait for it.
   *
   * mpv announces a duration once, when a file loads. Zeroing the value at the
   * top of each round and waiting for it to come back races that announcement:
   * if the next programme had already loaded and reported, the zero erased the
   * only report there was going to be, and round two waited for ever. Counting
   * lets a round wait for a report NEWER than the one it started with, which
   * cannot be lost.
   */
  await evaluate(ws, `window.__demoDuration = 0;
    window.__demoSeen = 0;
    window.tv.onMpvProp((name, value) => {
      if (name === 'duration' && typeof value === 'number' && value > 0) {
        window.__demoDuration = value;
        window.__demoSeen += 1;
      }
    });
    true`);

  for (let round = 1; round <= 3; round += 1) {
    const now = await evaluate(ws, "document.getElementById('npShow').textContent");

    /**
     * Straight to just before the end. This is the whole trick: her episodes
     * are twenty-six minutes, and nobody is going to sit through one to find
     * out what the card does afterwards.
     *
     * Six seconds rather than one, so the resume-save and the end-of-file
     * handling run the way they normally would instead of being skipped past.
     */
    const seenBefore = await evaluate(ws, 'window.__demoSeen || 0');
    await evaluate(ws, `window.__demoPos = 0;
      window.tv.onMpvProp((name, value) => {
        if (name === 'time-pos' && typeof value === 'number') window.__demoPos = value;
      });
      true`);
    // A report at least as new as this round, rather than "any report" —
    // the previous programme's duration is still sitting in the variable.
    const duration = await until(ws, 'mpv to report a duration',
      `(window.__demoSeen > ${round === 1 ? -1 : seenBefore - 1} && window.__demoDuration > 0)
        ? window.__demoDuration : 0`, 45000);
    const target = Math.max(0, Math.round(duration - 6));
    await evaluate(ws, `window.tv.mpvSeek(${target}); true`);
    await sleep(1500);
    const landed = await evaluate(ws, 'window.__demoPos || 0');
    say(`  round ${round}: ${now} — ${(duration / 60).toFixed(1)} min, `
      + `sought ${target}s, mpv is at ${Number(landed).toFixed(1)}s`);

    /**
     * Generously long, and it reports what it is looking at.
     *
     * Her real BUMPERS and PROMOS folders hold 308 and 34 clips, and they are
     * whole stings rather than the fixtures' one-second placeholders — so the
     * chain between the episode ending and the card appearing is genuinely
     * tens of seconds. The first attempt at this timed out at 120s and said
     * only "timed out", which is indistinguishable from the card being broken.
     */
    const cardUp = await until(ws, 'the box office card',
      `(() => {
        if (!document.getElementById('boxoffice').hidden) return 'up';
        const app = document.getElementById('app');
        window.__demoSaw = (window.__demoSaw || '') + '|' + app.dataset.view;
        return '';
      })()`, 240000).catch(async (error) => {
      const saw = await evaluate(ws, "window.__demoSaw || '(nothing)'").catch(() => '(unreadable)');
      const views = [...new Set(String(saw).split('|').filter(Boolean))].join(' -> ');
      throw new Error(`${error.message}; the app went through: ${views}`);
    });
    if (cardUp !== 'up') throw new Error('the card never came up');

    const shape = await evaluate(ws, `JSON.stringify({
      rows: [...document.querySelectorAll('.boxoffice__row')].map((r) => r.textContent),
      backdrop: (() => {
        const clip = document.getElementById('boxofficeClip');
        const still = document.getElementById('boxofficeStill');
        if (!clip.hidden && clip.getAttribute('src')) return 'moving clip';
        if (!still.hidden && still.getAttribute('src')) return 'still frame';
        return 'gradient only';
      })(),
    })`);
    const card = JSON.parse(shape);
    say(`card ${round}: after ${now} — backdrop: ${card.backdrop}`);
    say(`         ${card.rows.join('  ·  ')}`);

    // Let it finish and hand back, then the next programme runs.
    await until(ws, 'the card to hand back',
      "(document.getElementById('boxoffice').hidden && document.getElementById('app').dataset.view === 'playing') ? 'done' : ''", 40000);
    await sleep(1500);
  }

  say('');
  say('LEFT RUNNING for you to watch — close the window when you are done.');
  say('(scratch profile; your real state and settings were never touched)');
  child.unref();
}

main().catch((error) => {
  console.error(`demo failed: ${error.message}`);
  spawnSync('taskkill', ['/F', '/T', '/IM', 'electron.exe'], { windowsHide: true });
  process.exit(1);
});
