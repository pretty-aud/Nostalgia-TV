/**
 * Play up-next cards back to back, on the second monitor, for review.
 *
 *   node scripts/bumper-preview.mjs [style] [times]
 *   node scripts/bumper-preview.mjs boxoffice 4
 *
 * The point is the review LOOP. Watching one of these through the channel
 * means an episode, a sting and a promo first — about two minutes a look — and
 * three looks went past in a row with nothing learned. This raises the card
 * directly, with real footage behind it, roughly every fifteen seconds.
 *
 * It reports what the card actually had behind it each time, because "it fell
 * back to the still again" is the failure that has cost the most here and it
 * is invisible from the sofa.
 *
 * A SCRATCH PROFILE (NTV_PROFILE), so her real state is never touched, and
 * NTV_DEBUG=1, which is what exposes the entry point at all.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = path.join(os.tmpdir(), 'ntv-bumper-preview');
const profile = path.join(work, 'profile');
const library = process.env.NTV_DEMO_LIBRARY || 'H:/TVandFilms';
const CDP_PORT = 9225;

const style = process.argv[2] || 'boxoffice';
const times = Number(process.argv[3] || 4);
/** NTV_SHOTS=1 photographs each card mid-run, into the work folder. */
const shots = process.env.NTV_SHOTS === '1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (line) => console.log(line);

let seq = 0;
/** One PNG of the renderer's own pixels, base64, over the same socket. */
function capture(ws) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('capture timeout')), 30000);
    const onMessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
      if (message.error) { reject(new Error(message.error.message)); return; }
      resolve(message.result && message.result.data);
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method: 'Page.captureScreenshot', params: { format: 'png' } }));
  });
}

function evaluate(ws, expression) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP timeout')), 120000);
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
  for (let i = 0; i < 90; i += 1) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
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

async function until(ws, what, expression, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await evaluate(ws, expression).catch(() => '');
    if (value) return value;
    await sleep(400);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function main() {
  if (!fs.existsSync(library)) throw new Error(`no library at ${library}`);

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
      bumperStyle: style,
      bumperBackground: 'video',
      bumperEnabled: true,
      muted: false,
      volume: 65,
      /**
       * OFF. The stings and promos exist to give the transcode a head start
       * in the real channel; here they are the two minutes of waiting this
       * script exists to remove, and the debug entry point waits for the clip
       * itself instead.
       */
      bumperClipsEnabled: false,
      promosEnabled: false,
      moviesEnabled: false,

      /**
       * The schedule card's music folder, and Minimal Lofi's two.
       *
       * Seeded from the environment so a review run uses REAL files. Without
       * them the lofi card comes up on black with a 90 BPM fallback pulse,
       * which looks like a working card and is a picture of nothing being
       * tested — the folders are the whole feature.
       */
      bumperMusicDir: process.env.NTV_MUSIC_DIR || '',
      lofiMusicDir: process.env.NTV_LOFI_MUSIC || process.env.NTV_MUSIC_DIR || '',
      lofiFootageDir: process.env.NTV_LOFI_FOOTAGE || '',
    },
  }));

  const child = spawn(
    path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
    ['.', `--remote-debugging-port=${CDP_PORT}`],
    {
      cwd: root,
      env: {
        ...process.env,
        NTV_PROFILE: profile,
        NTV_SMOKE_PLACE: 'secondary',
        NTV_DEBUG: '1',
      },
      stdio: ['ignore',
        fs.openSync(path.join(work, 'app.out.log'), 'w'),
        fs.openSync(path.join(work, 'app.err.log'), 'w')],
      windowsHide: true,
      shell: false,
    },
  );

  const ws = await connect();
  await until(ws, 'the library scan',
    "document.getElementById('app').dataset.view === 'ready' ? 'ready' : ''", 300000);
  await evaluate(ws, "document.querySelector('.welcome__inner button').click(); true");
  await until(ws, 'the channel to start',
    "document.getElementById('app').dataset.view === 'playing' ? 'playing' : ''", 60000);

  const debugging = await evaluate(ws, 'Boolean(window.__debug)');
  if (!debugging) throw new Error('debug mode is not on — NTV_DEBUG did not reach the preload');
  say(`debug mode on — playing "${style}" ${times} times, on the second monitor`);
  say('');

  for (let round = 1; round <= times; round += 1) {
    // Kick the card off, then watch it while it runs rather than only after.
    await evaluate(ws, `window.__debugRun = window.__debug.playUpNext({ style: ${JSON.stringify(style)} });
      window.__debugDone = false;
      window.__debugRun.then((r) => { window.__debugReport = r; window.__debugDone = true; });
      true`);

    /**
     * WHICHEVER CARD THIS STYLE DRAWS, not the box office.
     *
     * This waited on `#boxoffice` by id, so a run of any other style sat here
     * for two minutes and then reported "timed out waiting for the card" — while
     * the card was playing perfectly on the second monitor the whole time. The
     * script that exists to review these cards could only review one of them.
     *
     * `data-bumper-style` is set by every driver as it opens, which makes this
     * the one condition that cannot go stale when a style is added.
     */
    await until(
      ws,
      `the ${style} card`,
      `document.getElementById('app').dataset.bumperStyle === ${JSON.stringify(style)} ? 'up' : ''`,
      120000,
    );

    /**
     * Sampled WHILE it plays, not after. Whether the clip is decoding and the
     * band is open are both moments, not end states — checking afterwards
     * finds a torn-down card and reports nothing either way.
     */
    const seen = [];
    for (let i = 0; i < 5; i += 1) {
      await sleep(1400);
      const snap = await evaluate(ws, 'JSON.stringify(window.__debug.inspect())').catch(() => null);
      if (snap) seen.push(JSON.parse(snap));
      /**
       * PHOTOGRAPH THE SCREEN, not the DOM.
       *
       * Every check here asks the renderer what it believes. It said the clip
       * was decoding and the band was open while she was watching a card that
       * did neither — so the only honest evidence is the glass itself.
       */
      /**
       * FROM THE RENDERER, not from the screen.
       *
       * This shelled out to grab-window.ps1 with the Electron PID. That process
       * owns two windows — the video plane and the transparent overlay — and on
       * a run it photographed neither: the file that came back was a picture of
       * an unrelated application that happened to be in front. Useless as
       * evidence, and not a thing a review script should be taking at all.
       *
       * Page.captureScreenshot asks the renderer for its own pixels, so the
       * frame is the card by construction and can never wander onto her
       * desktop. It is also COMPLETE for these cards: everything they draw —
       * the text, the backdrop <video>, the mark — lives in the overlay. mpv is
       * carrying audio only here, so there is nothing on the video plane for a
       * renderer capture to miss.
       */
      if (shots && i === 2) {
        const png = await capture(ws).catch(() => null);
        if (png) {
          await fsp.writeFile(path.join(work, `card${round}.png`), Buffer.from(png, 'base64'));
        }
      }
    }

    await until(ws, 'the card to finish', 'window.__debugDone ? "done" : ""', 30000);
    const report = JSON.parse(await evaluate(ws, 'JSON.stringify(window.__debugReport || {})'));

    const playing = seen.filter((s) => s.clipPlaying);
    const bands = [...new Set(seen.map((s) => s.band))].join(' -> ');
    say(`card ${round}: ${report.lead || '?'} — backdrop ${report.backdrop}`);
    say(`         clip decoding: ${playing.length ? `yes, ${playing[0].clipSize}, reached ${playing[playing.length - 1].clipTime.toFixed(1)}s` : 'NO'}`);
    say(`         band: ${bands}`);
    say(`         beats: ${seen.map((s) => s.beat).join(' -> ')}`);
    for (const s of seen) {
      say(`         ${String(s.beat).padEnd(7)} band=${String(s.band).padEnd(9)} block=${s.blockOpacity} wash=${s.washOpacity} lead@${s.leadAt} in ${s.viewport}`);
    }
    await sleep(1200);
  }

  say('');
  say('LEFT RUNNING — close the window when you are done.');
  child.unref();
}

main().catch((error) => {
  console.error(`preview failed: ${error.message}`);
  spawnSync('taskkill', ['/F', '/T', '/IM', 'electron.exe'], { windowsHide: true });
  process.exit(1);
});
