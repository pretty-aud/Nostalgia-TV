/**
 * Does artwork capture actually produce a PICTURE, at a useful size?
 *
 * The renderer shots cannot reach this: capture lives in the main process and
 * measures with nativeImage, so vitest cannot import it either — electron/
 * artwork.js requires 'electron'. Hence a smoke of its own.
 *
 * The fixture is generated here rather than committed: 180 seconds of
 * testsrc2 with a black box painted over 84..96s, so that a grab at the
 * episode default of 90 seconds lands on black BY CONSTRUCTION. That is the
 * "sometimes its a black screen" she reported, made reproducible.
 *
 * Usage: electron scripts/artwork-smoke.js
 * Design tooling only. Not part of the build.
 */

const { app, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const ffmpeg = path.join(root, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const artwork = require(path.join(root, 'electron', 'artwork.js'));

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) });
};

app.whenReady().then(async () => {
  if (!fs.existsSync(ffmpeg)) {
    console.error(`no ffmpeg at ${ffmpeg} — run "npm run vendor:ffmpeg"`);
    app.exit(2);
    return;
  }

  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'ntv-art-'));
  const clip = path.join(work, 'black-at-90.mp4');
  const artDir = path.join(work, 'artwork');

  const made = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=10:duration=180',
    '-vf', "drawbox=x=0:y=0:w=iw:h=ih:color=black@1:t=fill:enable='between(t,84,96)'",
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    clip,
  ], { encoding: 'utf8' });
  if (made.status !== 0 || !fs.existsSync(clip)) {
    console.error('could not build the fixture:', (made.stderr || '').trim());
    app.exit(3);
    return;
  }

  /**
   * THE CONTROL. A single grab at 90 seconds, which is what this module did
   * before: it must come out black, or the fixture is not exercising the bug
   * and everything below is measuring nothing.
   */
  const flat = path.join(work, 'naive.png');
  spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-ss', '90', '-i', clip, '-frames:v', '1', '-vf', 'scale=640:-2', '-y', flat,
  ]);
  const naive = artwork.measure(flat);
  check('the fixture really is black at 90s (control)',
    naive && naive.mean < 16, naive ? `mean luma ${naive.mean.toFixed(1)}` : 'no frame');

  artwork.init({ dir: artDir, findFfmpeg: () => ffmpeg });
  const captured = await artwork.capture('episode', 'black-at-90.mp4', clip, 90);
  check('a frame was captured', captured);

  const stored = fs.existsSync(artDir) ? fs.readdirSync(artDir).filter((f) => /\.(png|jpg)$/.test(f)) : [];
  check('exactly one file was stored', stored.length === 1, stored.join(' '));

  if (stored.length === 1) {
    const file = path.join(artDir, stored[0]);
    const seen = artwork.measure(file);
    check('it is not black', seen && seen.mean >= 16, seen ? `mean luma ${seen.mean.toFixed(1)}` : 'unreadable');
    check('it is not a flat colour card', seen && seen.spread >= 10, seen ? `spread ${seen.spread.toFixed(1)}` : '');
    // A LITERAL, deliberately. Comparing against artwork.CAPTURE_WIDTH would
    // move with the constant under test: drop it back to 640 and the check
    // would happily agree. 1200 is "wider than a rail card", which is the
    // property that actually matters.
    check('it is wide enough for a rail card', seen && seen.width >= 1200,
      seen ? `${seen.width}x${seen.height}` : '');
    // A 1280x720 PNG of a real frame runs past a megabyte; the whole point of
    // JPEG here is that a permanent, never-evicted store stays small.
    const bytes = fs.statSync(file).size;
    check('the file is a sane size', bytes < 600 * 1024, `${Math.round(bytes / 1024)}KB`);
    // ...and it is actually a JPEG. The extension is chosen by this module, so
    // read the magic bytes instead: FF D8 FF opens every JPEG.
    const head = fs.readFileSync(file).subarray(0, 3);
    check('the capture really is a JPEG', head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff,
      [...head].map((b) => b.toString(16).padStart(2, '0')).join(' '));
  }

  /**
   * A SMALL SOURCE MUST NOT BE STRETCHED. scale=1280 unconditionally turns a
   * 640x480 file into 1280x960 — the same detail over four times the pixels
   * and a bigger file for nothing. The hand-picked path has always clamped;
   * this checks the capture path does too.
   */
  const small = path.join(work, 'small.mp4');
  spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=10:duration=8',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', small,
  ]);
  if (fs.existsSync(small)) {
    await artwork.capture('episode', 'small.mp4', small, 2);
    const url = await artwork.read('episode', 'small.mp4');
    const grabbed = fs.readdirSync(artDir).map((f) => path.join(artDir, f))
      .filter((f) => /\.jpg$/.test(f) && artwork.measure(f))
      .map((f) => artwork.measure(f))
      .find((m) => m.width <= 640);
    check('a 640-wide source is not upscaled', Boolean(url) && Boolean(grabbed),
      grabbed ? `${grabbed.width}x${grabbed.height}` : 'no capture at or below 640 wide');
  }

  check('has() finds a capture', await artwork.has('episode', 'black-at-90.mp4'));
  const url = await artwork.read('episode', 'black-at-90.mp4');
  check('read() returns a data URL the renderer can show',
    typeof url === 'string' && url.startsWith('data:image/'), url ? url.slice(0, 22) : 'null');

  /**
   * A rebuild must clear captures and SPARE anything chosen by hand — that is
   * the whole promise made in the confirm dialog.
   */
  const source = path.join(artDir, stored[0] || '');
  if (stored.length === 1) {
    await artwork.setFromImage('show', 'chosen-show', source);
    check('a hand-picked image stores', await artwork.has('show', 'chosen-show'));
    // Hand-picked stays PNG and read() must PREFER it, or a later capture at
    // the same key would quietly shadow a deliberate choice.
    const chosenUrl = await artwork.read('show', 'chosen-show');
    check('a hand-picked image reads back as the PNG',
      typeof chosenUrl === 'string' && chosenUrl.startsWith('data:image/png'),
      chosenUrl ? chosenUrl.slice(0, 20) : 'null');

    const { removed } = await artwork.rebuild();
    check('the rebuild removed the capture', removed >= 1, `${removed} removed`);
    check('the capture is gone', !(await artwork.has('episode', 'black-at-90.mp4')));
    check('the hand-picked image survived', await artwork.has('show', 'chosen-show'));
  }

  await fsp.rm(work, { recursive: true, force: true }).catch(() => {});

  let bad = 0;
  for (const r of results) {
    if (!r.ok) bad += 1;
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
  }
  console.log(bad ? `\nARTWORK SMOKE FAILED (${bad} of ${results.length})` : '\nARTWORK SMOKE PASSED');
  app.exit(bad ? 1 : 0);
}).catch((error) => {
  console.error('smoke crashed:', error && error.stack);
  app.exit(1);
});
