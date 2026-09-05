import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The interface must not appear on its own.
 *
 * Chrome is meant to be summoned — a press, a hover, a key — and never to show
 * up because something started playing. The <video> 'play' event cannot tell
 * "the viewer pressed play" from "the app started the next thing", so hanging
 * showChrome() off it made the transport fade in and out over the opening
 * seconds of every episode, every bumper and every promo.
 *
 * That is a one-line regression to reintroduce and completely invisible in a
 * diff, so the wiring is asserted here rather than trusted.
 *
 * Source text rather than imports: index.js is a browser bundle entry and does
 * not load under vitest.
 */

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const raw = fs.readFileSync(path.join(here, '..', 'src', 'renderer', 'index.js'), 'utf8');

/**
 * Strip comments LINE-ANCHORED, never character-wise.
 *
 * A character-wise stripper hunts for `//` and this file is full of
 * `media://local/...` and `https://` — it would cut real code at the scheme.
 * Dropping whole lines that OPEN with a comment marker cannot misfire, and the
 * prose it removes is exactly the prose that discusses showChrome and the play
 * event, which would otherwise satisfy every assertion below on its own.
 */
const code = raw
  .split('\n')
  .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
  .join('\n');

/**
 * The WHOLE body of `player.addEventListener('<name>', ...)`, braces balanced.
 *
 * This used to read to the end of the line, which quietly made every
 * assertion below blind to a multi-line handler — a showChrome() on the
 * second line would not have been seen, which is precisely the regression
 * this file exists to prevent. Found when a handler legitimately grew to two
 * lines and the "did the regex find anything" control fired.
 */
function handlerFor(name) {
  const out = [];
  const opener = `player.addEventListener('${name}'`;
  let from = 0;
  for (;;) {
    const start = code.indexOf(opener, from);
    if (start === -1) break;
    let depth = 0;
    let i = start;
    for (; i < code.length; i += 1) {
      if (code[i] === '(') depth += 1;
      else if (code[i] === ')') { depth -= 1; if (depth === 0) { i += 1; break; } }
    }
    out.push(code.slice(start, i));
    from = i;
  }
  return out.join('\n');
}

describe('chrome only appears on purpose', () => {
  it('the comment stripper is doing something, and is needed', () => {
    // Failing control. The block comments above showChrome discuss the play
    // event at length; if they survive, the assertions below can pass on prose.
    expect(raw.length).toBeGreaterThan(code.length);
    expect(raw.match(/showChrome/g).length).toBeGreaterThan(
      code.match(/showChrome/g).length,
    );
  });

  it('finds the play and pause handlers at all', () => {
    // A regex that matched nothing would make the next check vacuously true.
    expect(handlerFor('play')).toMatch(/btnPlay/);
    expect(handlerFor('pause')).toMatch(/btnPlay/);
  });

  it('does not show chrome when playback starts', () => {
    expect(handlerFor('play')).not.toMatch(/showChrome/);
    expect(handlerFor('pause')).not.toMatch(/showChrome/);
  });

  it('still shows chrome when the viewer presses', () => {
    // togglePlay is the one play/pause path that is always a viewer action —
    // the click on the picture, the space bar, the transport button.
    const toggle = /function togglePlay\(\)[\s\S]*?\n}/.exec(code);
    expect(toggle).not.toBe(null);
    expect(toggle[0]).toMatch(/showChrome/);
  });

  it('still shows chrome on hover', () => {
    expect(code).toMatch(/mousemove[\s\S]{0,160}showChrome/);
  });

  it('never shows chrome over an interstitial clip', () => {
    // A clip runs for seconds and its transport would act on an episode that is
    // no longer on screen, so showChrome refuses outright rather than relying on
    // each of its ~8 call sites to remember.
    const fn = /function showChrome\(\)[\s\S]*?\n}/.exec(code);
    expect(fn).not.toBe(null);
    expect(fn[0]).toMatch(/if\s*\(playingBumperClip\)\s*return/);
  });
});
