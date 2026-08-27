'use strict';

/**
 * Why does a 4K file stutter?
 *
 * Stutter has three candidate causes and they need separating, because the fix
 * for each is completely different:
 *
 *   1. The bytes do not arrive fast enough  -> the drive, or our media:// pipe.
 *   2. The decoder cannot keep up           -> software decode instead of GPU.
 *   3. The compositor cannot keep up        -> painting/scaling, not decoding.
 *
 * getVideoPlaybackQuality() tells 1 and 2 apart from 3: droppedVideoFrames
 * counts frames the pipeline gave up on, while totalVideoFrames counts what the
 * decoder produced. A decoder that cannot keep up produces too FEW frames for
 * the elapsed time; a compositor that cannot keep up drops frames it was given.
 *
 * Then it repeats the run with a large read buffer. If the two runs are the
 * same, our 64KB pipe is not the problem and no amount of tuning it will help.
 *
 * Usage: npx electron scripts/diagnose-playback.js -- "I:/path/to/file.mkv"
 * Dev tooling. Ships with nothing.
 */

const { app, BrowserWindow, protocol } = require('electron');
const { Readable } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');

const marker = process.argv.indexOf('--');
const files = marker === -1 ? [] : process.argv.slice(marker + 1);
const SECONDS = Number(process.env.DIAG_SECONDS || 20);

// Set per run so the two passes differ only in this.
let highWaterMark = 64 * 1024;

protocol.registerSchemesAsPrivileged([
  { scheme: 'diag', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

/** Byte-for-byte the shape of the app's media:// handler. */
function serve(request) {
  const url = new URL(request.url);
  const absPath = decodeURIComponent(url.pathname.replace(/^\//, ''));
  let size;
  try { size = fs.statSync(absPath).size; } catch { return new Response('not found', { status: 404 }); }

  const range = request.headers.get('range');
  const headers = { 'Content-Type': 'video/x-matroska', 'Accept-Ranges': 'bytes' };
  if (!range) {
    headers['Content-Length'] = String(size);
    return new Response(Readable.toWeb(fs.createReadStream(absPath, { highWaterMark })), { status: 200, headers });
  }
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  const start = m && m[1] ? Number(m[1]) : 0;
  const end = m && m[2] ? Number(m[2]) : size - 1;
  headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  headers['Content-Length'] = String(end - start + 1);
  return new Response(Readable.toWeb(fs.createReadStream(absPath, { start, end, highWaterMark })), { status: 206, headers });
}

const PAGE = `
<style>html,body{margin:0;background:#000;overflow:hidden}video{width:100vw;height:100vh}</style>
<video id="v" autoplay muted></video>
<script>
  const v = document.getElementById('v');
  window.run = (src, seconds) => new Promise((resolve) => {
    const out = { events: [] };
    const t0 = performance.now();
    const mark = (n) => out.events.push(n + '@' + Math.round(performance.now() - t0) + 'ms');
    for (const n of ['loadedmetadata','canplay','playing','waiting','stalled','error','suspend']) {
      v.addEventListener(n, () => mark(n), { once: n !== 'waiting' && n !== 'stalled' });
    }
    v.src = src;
    v.play().catch((e) => mark('playfail:' + e.name));

    let firstFrameAt = null;
    const samples = [];
    const tick = setInterval(() => {
      const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
      if (q && q.totalVideoFrames > 0 && firstFrameAt === null) firstFrameAt = performance.now() - t0;
      samples.push({
        at: Math.round(performance.now() - t0),
        time: Number(v.currentTime.toFixed(2)),
        total: q ? q.totalVideoFrames : null,
        dropped: q ? q.droppedVideoFrames : null,
        corrupted: q ? q.corruptedVideoFrames : null,
        buffered: v.buffered.length ? Number((v.buffered.end(v.buffered.length - 1) - v.currentTime).toFixed(2)) : 0,
        readyState: v.readyState,
        bytes: v.webkitVideoDecodedByteCount || 0,
      });
    }, 500);

    setTimeout(() => {
      clearInterval(tick);
      const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : {};
      out.firstFrameMs = firstFrameAt;
      out.samples = samples;
      out.final = {
        currentTime: v.currentTime,
        total: q.totalVideoFrames, dropped: q.droppedVideoFrames,
        videoWidth: v.videoWidth, videoHeight: v.videoHeight,
      };
      v.pause(); v.removeAttribute('src'); v.load();
      resolve(out);
    }, seconds * 1000);
  });
</script>`;

app.whenReady().then(async () => {
  protocol.handle('diag', serve);

  const win = new BrowserWindow({
    width: 1280, height: 800, show: true, backgroundColor: '#000',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE));

  console.log('=== GPU feature status (does the GPU decode video?) ===');
  const status = app.getGPUFeatureStatus();
  for (const [k, val] of Object.entries(status)) {
    if (/video|gpu_compositing|rasterization|webgl$/.test(k)) console.log('  ', k.padEnd(34), val);
  }

  for (const file of files) {
    const src = 'diag://local/' + encodeURIComponent(file);
    console.log('');
    console.log('='.repeat(78));
    console.log(path.basename(file));
    console.log('='.repeat(78));

    for (const [label, hwm] of [['64 KB  (what the app does today)', 64 * 1024], ['4 MB   (large read buffer)', 4 * 1024 * 1024]]) {
      highWaterMark = hwm;
      const r = await win.webContents.executeJavaScript(
        `window.run(${JSON.stringify(src)}, ${SECONDS})`, true,
      );

      const f = r.final || {};
      const wallSeconds = SECONDS;
      const expected = f.currentTime ? f.currentTime : 0;
      console.log('');
      console.log(`-- ${label}`);
      console.log('   first frame at      :', r.firstFrameMs == null ? 'NEVER' : Math.round(r.firstFrameMs) + ' ms');
      console.log('   played              :', expected.toFixed(1), 'sec of video in', wallSeconds, 'sec of wall clock',
        expected ? `(${(expected / wallSeconds * 100).toFixed(0)}% real time)` : '');
      console.log('   resolution          :', f.videoWidth + 'x' + f.videoHeight);
      console.log('   frames decoded      :', f.total);
      console.log('   frames DROPPED      :', f.dropped,
        f.total ? `(${(f.dropped / f.total * 100).toFixed(1)}%)` : '');
      console.log('   effective fps       :', expected ? (f.total / wallSeconds).toFixed(1) : '0');
      console.log('   events              :', (r.events || []).join(', ') || 'none');

      const stalls = (r.samples || []).filter((s, i, a) => i > 0 && s.time === a[i - 1].time && s.at > 2000);
      console.log('   half-second samples with NO progress:', stalls.length, 'of', (r.samples || []).length);
      const buf = (r.samples || []).map((s) => s.buffered).filter((n) => n > 0);
      if (buf.length) {
        console.log('   buffer ahead (sec)  : min', Math.min(...buf).toFixed(1), 'max', Math.max(...buf).toFixed(1));
      }
    }
  }

  console.log('');
  app.quit();
}).catch((e) => { console.error(e); app.quit(); });
