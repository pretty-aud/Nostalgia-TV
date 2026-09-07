'use strict';

/**
 * Screenshot the renderer after putting it into a particular state.
 *
 * A plain on-load capture is enough for the welcome screen and not much else —
 * the transport only exists while something is playing, and a toggle can only
 * be photographed in one of its positions at a time. So this runs a snippet
 * first, and the state being reviewed is the state that gets captured. (An
 * earlier snippet-less shoot.js did the on-load capture; this tool covers that
 * case too, so it was retired.)
 *
 * The snippet arrives as a FILE, never as an argv string: quoting JavaScript
 * through a shell has silently mangled source in this project before.
 *
 * Usage: electron scripts/shoot-state.js -- <url> <outfile> <snippet.js> [w] [h]
 * Design tooling only. Not part of the build.
 */

const { app, BrowserWindow, screen } = require('electron');
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

  /**
   * ON THE SECOND MONITOR WHENEVER THERE IS ONE.
   *
   * This runs thirty-nine times in a full pass and each one puts a window on
   * screen. Landing them on the primary display means stealing the screen
   * from whatever is playing there — which is exactly what happened, and it
   * is not acceptable for a review tool to interrupt the thing being
   * reviewed. Same convention electron/main.js uses for NTV_SMOKE_PLACE.
   *
   * Positioned BEFORE the show, so it never appears on the wrong screen even
   * for a frame.
   */
  const primary = screen.getPrimaryDisplay();
  const other = screen.getAllDisplays().find((d) => d.id !== primary.id);
  if (other) win.setPosition(other.workArea.x + 60, other.workArea.y + 60);

  /**
   * THE SIZE ARGUMENTS WERE 1.5× OUT ON THIS MACHINE, and silently.
   *
   * BrowserWindow's width and height are device-independent pixels, and on a
   * 150% display those are not CSS pixels: asking for 1280x880 produced a
   * viewport of 1930x1325. Every probe in this folder has therefore been
   * running half again as large as it asked for — and the one shot that exists
   * SPECIFICALLY to see the app at a width where the layout breaks,
   * vhs-transport-narrow at 980x720, has been running at 1480x1085 and has
   * never once been narrow. Its own comment says the wrapping transport labels
   * "were reported by a person, at a size no probe was looking at". That is
   * still true, and this is why.
   *
   * setContentSize is the fix, and it is NOT a matter of dividing by the scale
   * factor — the first attempt did that and came out 1.5× too small in the
   * other direction, which the check further down caught on its first run.
   * The constructor's width/height and setContentSize simply do not agree on
   * this machine; the one that matches the viewport is this one, so the size
   * is set here and then read back rather than reasoned about.
   */
  win.setContentSize(Number(w), Number(h));

  win.showInactive();

  // Verified, not assumed. A shot taken at the wrong size reviews a layout the
  // app never has, and reports success while doing it.
  const viewport = await win.webContents
    .executeJavaScript('[innerWidth, innerHeight]').catch(() => null);
  if (viewport) {
    const [vw, vh] = viewport;
    if (Math.abs(vw - Number(w)) > 4 || Math.abs(vh - Number(h)) > 4) {
      log(`SIZE MISMATCH: asked ${w}x${h}, got ${vw}x${vh}`);
      console.error(`SIZE MISMATCH: asked ${w}x${h}, got ${vw}x${vh}`);
      app.exit(5);
      return;
    }
  }

  await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)').catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 900));

  // A snippet may return a bounding rect to crop to. A 36px control in a
  // 1280px window is too few pixels to judge a colour by.
  let rect = null;
  if (snippetPath && snippetPath !== '-') {
    const snippet = fs.readFileSync(path.resolve(snippetPath), 'utf8');
    try {
      /**
       * A snippet may need a PARAMETER — most often a theme, so one snippet can
       * photograph the same control in the palette that breaks it rather than
       * needing a near-identical file per theme. It arrives through the
       * environment and is handed over as JSON, never spliced into the source:
       * a value interpolated into that template literal below would be running
       * as code, and this repo has mangled source through a shell before.
       */
      await win.webContents.executeJavaScript(
        `window.__shotTheme = ${JSON.stringify(process.env.NTV_SHOT_THEME || '')} || undefined;`,
      );
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
