'use strict';

/**
 * Does Chromium actually DECODE the audio in a prepared file?
 *
 * canPlayType only answers "would I try". webkitAudioDecodedByteCount answers
 * "did bytes come out", which is the question when the picture plays and the
 * room stays silent.
 *
 * Usage: electron probe-audio.js -- <file> [file...]
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const marker = process.argv.indexOf('--');
const files = marker === -1 ? process.argv.slice(2) : process.argv.slice(marker + 1);

const out = path.join(path.dirname(files[0] || '.'), 'audio-probe.txt');
const say = (line) => { try { fs.appendFileSync(out, `${line}\n`); } catch { /* ignore */ } };
fs.writeFileSync(out, '');

setTimeout(() => { say('TIMED OUT'); app.exit(2); }, 180000);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 640, height: 400, show: true, backgroundColor: '#000',
    webPreferences: { webSecurity: false },
  });

  // A real page IN the media's own folder. A data: URL has an opaque origin and
  // Chromium refuses to load file:// media into it — "rejected by URL safety
  // check" is the harness failing, not the file.
  const pageDir = path.dirname(files[0]);
  const page = path.join(pageDir, 'audio-probe.html');
  fs.writeFileSync(page, '<video id=v style="width:100%"></video>');
  await win.loadFile(page);

  for (const file of files) {
    const url = path.basename(file);   // relative to the page, same folder
    const result = await win.webContents.executeJavaScript(`(async () => {
      const v = document.getElementById('v');
      v.src = ${JSON.stringify(url)};
      v.muted = false;
      v.volume = 1;
      await new Promise((done) => {
        v.addEventListener('loadedmetadata', done, { once: true });
        v.addEventListener('error', done, { once: true });
        setTimeout(done, 12000);
      });
      try { await v.play(); } catch (e) {}
      await new Promise((r) => setTimeout(r, 3500));
      return {
        error: v.error ? v.error.code + ' ' + v.error.message : null,
        duration: Math.round(v.duration || 0),
        currentTime: Number((v.currentTime || 0).toFixed(2)),
        videoBytes: v.webkitVideoDecodedByteCount || 0,
        audioBytes: v.webkitAudioDecodedByteCount || 0,
        audioTracks: v.audioTracks ? v.audioTracks.length : 'n/a',
      };
    })()`, true);

    say(`${path.basename(file)}`);
    say(`   error ${result.error} | dur ${result.duration}s | played ${result.currentTime}s`);
    say(`   video bytes ${result.videoBytes} | AUDIO BYTES ${result.audioBytes} | tracks ${result.audioTracks}`);
    say(result.audioBytes > 0 ? '   -> audio DECODES' : '   -> NO AUDIO DECODED');
  }

  say('done');
  app.exit(0);
});
