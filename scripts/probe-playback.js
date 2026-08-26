'use strict';

/**
 * Can Chromium play these files as they are?
 *
 * The app converts anything it does not believe is playable, and for a 58GB 4K
 * remux that conversion is half an hour of copying. Whether it is NEEDED is a
 * question about what this exact Electron build can decode — not something to
 * settle from a codec table, because the answer depends on the Chromium build,
 * the platform decoders installed, and the MIME the protocol declares.
 *
 * So it asks the real thing. For each file it plays a couple of seconds and
 * reads webkitVideoDecodedByteCount / webkitAudioDecodedByteCount, which count
 * bytes that came out of a DECODER. Metadata loading proves only that the
 * container was parsed; those counters prove pictures and sound.
 *
 * Also tries a second MIME. Chromium accepts Matroska but has been fussy about
 * what it is called, and "the container is fine, the label was wrong" would be
 * a very cheap fix for a very expensive problem.
 *
 * Usage: electron scripts/probe-playback.js -- <file> [file...]
 * Dev tooling. Ships with nothing.
 */

const { app, BrowserWindow, protocol, net } = require('electron');
const { Readable } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');

const marker = process.argv.indexOf('--');
const files = marker === -1 ? [] : process.argv.slice(marker + 1);

// One MIME by default: the three were tested against each other and made no
// difference, so repeating them only triples the run.
const MIMES = (process.env.PROBE_MIMES || 'video/x-matroska').split(',');

protocol.registerSchemesAsPrivileged([
  { scheme: 'probe', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

/** Byte-range serving, the same shape the app's media:// handler provides. */
function serve(request) {
  const url = new URL(request.url);
  const absPath = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const mime = decodeURIComponent(url.searchParams.get('mime') || 'video/mp4');

  let size;
  try { size = fs.statSync(absPath).size; } catch { return new Response('not found', { status: 404 }); }

  const range = request.headers.get('range');
  const headers = { 'Content-Type': mime, 'Accept-Ranges': 'bytes' };

  if (!range) {
    headers['Content-Length'] = String(size);
    return new Response(Readable.toWeb(fs.createReadStream(absPath)), { status: 200, headers });
  }

  const match = /bytes=(\d*)-(\d*)/.exec(range);
  const start = match && match[1] ? Number(match[1]) : 0;
  const end = match && match[2] ? Number(match[2]) : size - 1;
  headers['Content-Length'] = String(end - start + 1);
  headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  return new Response(Readable.toWeb(fs.createReadStream(absPath, { start, end })), { status: 206, headers });
}

const PROBE = `
window.probe = async (url) => {
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  document.body.append(v);
  const out = { metadata: false, error: null, w: 0, h: 0, duration: 0, video: 0, audio: 0 };
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting for metadata')), 25000);
      v.addEventListener('loadedmetadata', () => { clearTimeout(t); resolve(); }, { once: true });
      v.addEventListener('error', () => {
        clearTimeout(t);
        const e = v.error;
        reject(new Error(e ? ('code ' + e.code + (e.message ? ': ' + e.message : '')) : 'media error'));
      }, { once: true });
      v.src = url;
      v.load();
    });
    out.metadata = true;
    out.w = v.videoWidth; out.h = v.videoHeight; out.duration = v.duration;
    // Seek in a little: the first seconds of a remux are often black with no
    // sound, and "nothing decoded" would then be true but meaningless.
    if (isFinite(v.duration) && v.duration > 120) {
      await new Promise((r) => { v.addEventListener('seeked', r, { once: true }); v.currentTime = 60; setTimeout(r, 8000); });
    }
    await v.play().catch(() => {});
    await new Promise((r) => setTimeout(r, 3500));
    out.video = v.webkitVideoDecodedByteCount || 0;
    out.audio = v.webkitAudioDecodedByteCount || 0;
  } catch (error) {
    out.error = String(error.message || error);
  }
  v.pause(); v.removeAttribute('src'); v.load(); v.remove();
  return out;
};
true;
`;

process.on('uncaughtException', (error) => console.error('ignored: ' + error.message));
process.on('unhandledRejection', (error) => console.error('ignored: ' + error));

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

app.whenReady().then(async () => {
  protocol.handle('probe', serve);
  void net;

  const win = new BrowserWindow({ width: 900, height: 600, show: false, webPreferences: { sandbox: false } });
  await win.loadURL('data:text/html,<body style="background:#111"></body>');
  await win.webContents.executeJavaScript(PROBE);

  console.log('');
  console.log('file'.padEnd(46), 'mime'.padEnd(18), 'meta'.padEnd(5), 'size'.padEnd(11), 'video'.padEnd(9), 'audio');
  console.log('-'.repeat(110));

  for (const file of files) {
    const name = path.basename(file);
    for (const mime of MIMES) {
      const url = `probe://local/${encodeURIComponent(file)}?mime=${encodeURIComponent(mime)}`;
      // eslint-disable-next-line no-await-in-loop
      const r = await win.webContents.executeJavaScript(`window.probe(${JSON.stringify(url)})`);
      const size = r.w ? `${r.w}x${r.h}` : '-';
      console.log(
        name.slice(0, 44).padEnd(46),
        mime.padEnd(18),
        (r.metadata ? 'yes' : 'no').padEnd(5),
        size.padEnd(11),
        (r.video ? 'DECODES' : 'none').padEnd(9),
        (r.audio ? 'DECODES' : 'none'),
        r.error ? `  (${r.error})` : '',
      );
    }
    console.log('');
  }

  app.exit(0);
});
