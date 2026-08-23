'use strict';

/**
 * Generate a fake TV library of real, playable video files.
 *
 * Chromium can encode video itself via canvas.captureStream + MediaRecorder, so
 * this needs no ffmpeg and no downloads. Each clip burns its show name, episode
 * code and a running clock into the picture, which makes it obvious at a glance
 * whether the scheduler actually played what the bumper promised.
 *
 *   npx electron scripts/make-fixtures.js [outputDir]
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fsp = require('node:fs/promises');

const OUT_DIR = process.argv[2]
  || path.join(app.getPath('temp'), 'nostalgia-tv-fixtures');

/**
 * Deliberately mixed naming conventions — this doubles as a live exercise of
 * every branch in the filename parser, not just the tidy SxxExx case.
 */
const LIBRARY = [
  { show: 'Detective Marlow',   files: ['Detective Marlow - S01E01 - Cold Open.webm', 'Detective Marlow - S01E02 - The Second Body.webm', 'Detective Marlow - S01E03 - Last Call.webm'] },
  { show: 'Kitchen Nightmares', files: ['Kitchen Nightmares 1x01.webm', 'Kitchen Nightmares 1x02.webm'] },
  { show: 'Deep Space Nine-ish',files: ['Season 1/ep1.webm', 'Season 1/ep2.webm', 'Season 2/ep1.webm'] },
  { show: 'The Grand Tourist',  files: ['The.Grand.Tourist.S01E01.Paris.1080p.WEB-DL.x264-GRP.webm', 'The.Grand.Tourist.S01E02.Lisbon.1080p.WEB-DL.x264-GRP.webm'] },
  { show: 'Bake It Til You Make It', files: ['S01E01.webm', 'S01E02.webm', 'S01E03.webm'] },
  { show: 'Night Radio',        files: ['Night Radio 2024.03.15.webm', 'Night Radio 2024.03.16.webm'] },
  { show: 'Quiz Bowl',          files: ['Episode 1.webm', 'Episode 2.webm', 'Episode 10.webm'] },
  { show: 'Wildlife Britain',   files: ['Wildlife Britain - S02E01.webm', 'Wildlife Britain - S02E02.webm', 'Specials/Christmas Special.webm'] },
];

const PALETTE = ['#f4a261', '#2a9d8f', '#e76f51', '#8ecae6', '#ffb703', '#bc6c25', '#a3b18a', '#cdb4db'];
const CLIP_SECONDS = 4;

const page = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#000"></body>`;

async function main() {
  await fsp.mkdir(OUT_DIR, { recursive: true });

  const win = new BrowserWindow({
    width: 700, height: 420, show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false, offscreen: false },
  });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
  await win.webContents.executeJavaScript(RECORDER);

  let made = 0;
  const total = LIBRARY.reduce((n, s) => n + s.files.length, 0);

  for (let s = 0; s < LIBRARY.length; s += 1) {
    const entry = LIBRARY[s];
    for (let i = 0; i < entry.files.length; i += 1) {
      const relative = path.join(entry.show, entry.files[i]);
      const target = path.join(OUT_DIR, relative);
      await fsp.mkdir(path.dirname(target), { recursive: true });

      const base64 = await win.webContents.executeJavaScript(
        `record(${JSON.stringify(entry.show)}, ${JSON.stringify(path.basename(entry.files[i], '.webm'))}, ${JSON.stringify(PALETTE[s % PALETTE.length])}, ${CLIP_SECONDS})`,
        true,
      );
      await fsp.writeFile(target, Buffer.from(base64, 'base64'));
      made += 1;
      process.stdout.write(`  [${made}/${total}] ${relative}\n`);
    }
  }

  process.stdout.write(`\nWrote ${made} clips to:\n${OUT_DIR}\n`);
  win.destroy();
  app.quit();
}

const RECORDER = `
window.record = function (showName, code, colour, seconds) {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 360;
    const ctx = canvas.getContext('2d');
    const stream = canvas.captureStream(25);
    const chunks = [];
    const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 400000 });
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onerror = (e) => reject(new Error(String(e.error || 'recorder error')));
    rec.onstop = async () => {
      const blob = new Blob(chunks, { type: 'video/webm' });
      const buf = await blob.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
      resolve(btoa(binary));
    };

    const started = performance.now();
    function frame() {
      const elapsed = (performance.now() - started) / 1000;
      ctx.fillStyle = colour;
      ctx.fillRect(0, 0, 640, 360);
      ctx.fillStyle = 'rgba(0,0,0,0.72)';
      ctx.fillRect(0, 250, 640, 110);

      ctx.fillStyle = '#141018';
      ctx.font = '600 34px Segoe UI, sans-serif';
      ctx.fillText(showName, 40, 90);

      ctx.fillStyle = '#141018';
      ctx.font = '20px Consolas, monospace';
      ctx.fillText(code, 40, 130);

      // A moving element proves the file really is video and really is seeking.
      ctx.fillStyle = '#fff';
      ctx.font = '600 64px Consolas, monospace';
      ctx.fillText(elapsed.toFixed(1) + 's', 40, 330);

      ctx.fillStyle = colour;
      ctx.fillRect(40 + (elapsed / seconds) * 540, 268, 46, 14);

      if (elapsed < seconds) requestAnimationFrame(frame);
      else rec.stop();
    }
    rec.start();
    requestAnimationFrame(frame);
  });
};
`;

app.whenReady().then(() => {
  main().catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    app.exit(1);
  });
});
