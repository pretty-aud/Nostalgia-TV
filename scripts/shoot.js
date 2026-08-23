'use strict';

/**
 * Screenshot the renderer with Electron, for design review.
 *
 * The Browser pane cannot produce a screenshot unless it is on screen, which
 * makes a visual pass unverifiable from here. Electron can capture its own
 * window, and it is the exact engine the app ships on, so what comes back is
 * what the app actually looks like rather than an approximation in a browser.
 *
 * Usage: electron scripts/shoot.js <url> <outfile> [width] [height]
 * Design tooling only. Not part of the build.
 */

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Args come after `--`.
 *
 * Electron hands argv to Chromium's own parser first, and a bare `http://…`
 * positional is taken as a URL for it to open rather than as data for the
 * script — which kills the process before the app is ever ready. `--` stops
 * that parsing.
 */
const marker = process.argv.indexOf('--');
const [url, out, w = '1280', h = '880'] = marker === -1
  ? process.argv.slice(2)
  : process.argv.slice(marker + 1);

const logFile = path.join(__dirname, '..', 'shots', 'shoot.log');
function log(message) {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `${message}\n`);
  } catch { /* logging must never be the thing that fails */ }
}

// Never let this hold the machine: it is a screenshot, not a service.
setTimeout(() => { log('timed out'); app.exit(2); }, 40000);

app.whenReady().then(async () => {
  log(`ready url=${url} out=${out}`);

  const win = new BrowserWindow({
    width: Number(w),
    height: Number(h),
    show: false,
    frame: false,
    backgroundColor: '#08070c',
  });

  try {
    await win.loadURL(url);
    log('loaded');
  } catch (error) {
    log(`loadURL failed: ${error.message}`);
    app.exit(3);
    return;
  }

  // showInactive paints the window without stealing focus. capturePage on a
  // window that has never been shown comes back empty, because nothing has
  // composited a frame for it to copy.
  win.showInactive();

  // Let fonts settle: font-display: block holds text invisible until the woff2
  // lands, so capturing too early photographs an empty layout.
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)').catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 1400));

  const image = await win.webContents.capturePage();
  const size = image.getSize();
  log(`captured ${size.width}x${size.height} empty=${image.isEmpty()}`);

  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, image.toPNG());
  log(`wrote ${out}`);
  app.exit(0);
});
