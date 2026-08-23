'use strict';

/**
 * Screenshot the renderer after putting it into a particular state.
 *
 * shoot.js captures whatever the page looks like on load, which is enough for
 * the welcome screen and not much else — the transport only exists while
 * something is playing, and a toggle can only be photographed in one of its
 * positions at a time. This runs a snippet first, so the state being reviewed
 * is the state that gets captured.
 *
 * The snippet arrives as a FILE, never as an argv string: quoting JavaScript
 * through a shell has silently mangled source in this project before.
 *
 * Usage: electron scripts/shoot-state.js -- <url> <outfile> <snippet.js> [w] [h]
 * Design tooling only. Not part of the build.
 */

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const marker = process.argv.indexOf('--');
const [url, out, snippetPath, w = '1280', h = '880'] = marker === -1
  ? process.argv.slice(2)
  : process.argv.slice(marker + 1);

const logFile = path.join(__dirname, '..', 'shots', 'shoot.log');
function log(message) {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `${message}\n`);
  } catch { /* logging must never be the thing that fails */ }
}

setTimeout(() => { log('timed out'); app.exit(2); }, 40000);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: Number(w), height: Number(h), show: false, frame: false, backgroundColor: '#08070c',
  });

  try {
    await win.loadURL(url);
  } catch (error) {
    log(`loadURL failed: ${error.message}`);
    app.exit(3);
    return;
  }

  win.showInactive();
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)').catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 900));

  // A snippet may return a bounding rect to crop to. A 36px control in a
  // 1280px window is too few pixels to judge a colour by.
  let rect = null;
  if (snippetPath && snippetPath !== '-') {
    const snippet = fs.readFileSync(path.resolve(snippetPath), 'utf8');
    try {
      // Wrapped so the snippet can await, and so a stray `const` cannot collide
      // with anything the renderer already declared at top level.
      const value = await win.webContents.executeJavaScript(
        `(async () => { ${snippet}\n })()`,
      );
      log(`snippet ok: ${JSON.stringify(value)}`);
      if (value && Number.isFinite(value.width) && value.width > 0) {
        rect = {
          x: Math.max(0, Math.round(value.x)),
          y: Math.max(0, Math.round(value.y)),
          width: Math.round(value.width),
          height: Math.round(value.height),
        };
      }
    } catch (error) {
      // Loud: a snippet that threw means the shot shows the WRONG state, and a
      // screenshot of the wrong state is worse than no screenshot.
      log(`SNIPPET FAILED: ${error.message}`);
      console.error(`SNIPPET FAILED: ${error.message}`);
      app.exit(4);
      return;
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 500));

  let image = await win.webContents.capturePage(rect || undefined);
  log(`captured ${image.getSize().width}x${image.getSize().height} empty=${image.isEmpty()}`);
  if (image.isEmpty()) { console.error('EMPTY CAPTURE'); app.exit(5); return; }
  // Enlarged only when the crop is SMALL. The 3x was for judging a 36px
  // control; applied to a full dialog it produced a multi-megapixel image
  // that failed to encode, and the run died with no error and no file.
  if (rect && rect.width < 520) {
    image = image.resize({ width: Math.round(rect.width * 3), quality: 'best' });
  }

  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, image.toPNG());
  app.exit(0);
});
