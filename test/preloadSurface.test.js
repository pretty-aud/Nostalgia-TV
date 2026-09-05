import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'acorn';

/**
 * Every window.tv.* the renderer reaches for must actually be on the bridge.
 *
 * test/ipcChannels.test.js pins preload↔main. NOTHING pinned renderer↔preload,
 * and that is the more dangerous half: `window.tv.mpvFoo` where preload has no
 * `mpvFoo` is `undefined`, and `undefined(...)` throws a SYNCHRONOUS TypeError
 * before any promise exists — so a `.catch()` written on the same line never
 * runs. It is the prefFor failure exactly: a name that stopped existing, a
 * caller left standing, and silence.
 *
 * The renderer's own guards do not cover this, because several of them check
 * one method and then call others: applyPicture tests `mpvSetVideoCrop` and
 * goes on to call `mpvSetVideoZoom`, and applyTrackPrefs tests `mpvTrackList`
 * then calls `mpvSetAudioTrack`, `mpvSetSubTrack` and `mpvSetSubVisibility`.
 * Delete any of the unguarded ones and the guard still passes.
 *
 * Source text rather than imports, because neither side loads outside Electron.
 */

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const root = path.join(here, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

/** The keys of the object handed to contextBridge.exposeInMainWorld. */
function exposedKeys(source) {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
  let keys = null;
  const walk = (node) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'CallExpression'
      && node.callee.type === 'MemberExpression'
      && node.callee.property.name === 'exposeInMainWorld') {
      const object = node.arguments[1];
      if (object && object.type === 'ObjectExpression') {
        keys = object.properties.map((p) => p.key.name || p.key.value);
      }
    }
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (Array.isArray(child)) child.forEach(walk);
      else if (child && typeof child.type === 'string') walk(child);
    }
  };
  walk(ast);
  return keys;
}

const preloadSource = read('electron', 'preload.js');
const exposed = exposedKeys(preloadSource);

const indexSource = read('src', 'renderer', 'index.js');
const bridgeSource = read('src', 'renderer', 'mpvBridge.js');

const used = new Set();
for (const m of indexSource.matchAll(/window\.tv\.([A-Za-z0-9_]+)/g)) used.add(m[1]);
for (const m of bridgeSource.matchAll(/window\.tv\.([A-Za-z0-9_]+)/g)) used.add(m[1]);
// mpvBridge is handed the bridge as a parameter named `tv`, so its call sites
// never spell `window.`; matching bare `tv.` would also catch `.tv.`, hence
// the guard on the preceding character.
for (const m of bridgeSource.matchAll(/(?<![A-Za-z0-9_.])tv\.([A-Za-z0-9_]+)/g)) used.add(m[1]);

describe('renderer to preload', () => {
  it('finds both sides at all', () => {
    // A regex or a walk that silently matched nothing would make the real
    // check below pass while proving absolutely nothing.
    expect(Array.isArray(exposed)).toBe(true);
    expect(exposed.length).toBeGreaterThan(30);
    expect(used.size).toBeGreaterThan(30);
  });

  it('exposes every member the renderer calls', () => {
    const missing = [...used].filter((name) => !exposed.includes(name)).sort();
    expect(missing).toEqual([]);
  });
});

/**
 * The other direction: a binding nothing calls.
 *
 * Not a crash — dead weight, and specifically dead REACHABLE SURFACE, since
 * each one is a live main-process handler the renderer can still invoke. The
 * switchover deleted the conversion pipeline's UI and left its whole IPC
 * surface exposed: capabilities, playbackVerdict, savePlaybackVerdict,
 * inspect, ensurePlayable, listTracks, subtitleText, cancelPrepare,
 * pinPrepared and onPrepareProgress — ten of them, for a whole branch,
 * including one that would still have spawned a full ffmpeg conversion for
 * anything that asked.
 *
 * All ten are gone, so this is asserted EMPTY rather than against a list: the
 * next unused binding fails on the day it appears, which is the only moment
 * anyone remembers why it was added.
 */
describe('preload to renderer', () => {
  it('exposes nothing the renderer never calls', () => {
    const unused = exposed.filter((name) => !used.has(name)).sort();
    expect(unused).toEqual([]);
  });
});

/**
 * THE CONVERSION PIPELINE IS UNREACHABLE, AND STAYS THAT WAY.
 *
 * mpv decodes everything, so nothing converts any more — but prepare.js still
 * CONTAINS the engine (ensurePlayable, runFfmpeg, the job queue), because the
 * same module still owns the auto-crop, the codec probe that ingest uses, and
 * the cleanup that reclaims what the old conversion cache left on her disk.
 *
 * Dead code that spawns a process is worse than dead code that does not, so
 * what matters is that no path REACHES it. These are the three channels that
 * legitimately survive; `prepare:ensure` — which would start a full ffmpeg
 * conversion for whatever asked — is deliberately not among them.
 *
 * Both sides are asserted, because either half alone can be wrong: a handler
 * with no preload verb is unreachable-but-live, and a preload verb with no
 * handler is a rejected promise the caller probably never checks.
 */
const SURVIVING_PREPARE_CHANNELS = ['prepare:cacheInfo', 'prepare:cleanup', 'prepare:crop'];

describe('the ffmpeg surface', () => {
  it('exposes exactly the three prepare channels that still have a caller', () => {
    const invoked = [...preloadSource.matchAll(/ipcRenderer\.invoke\(\s*'(prepare:[^']+)'/g)]
      .map((m) => m[1]).sort();
    expect(invoked).toEqual(SURVIVING_PREPARE_CHANNELS);
  });

  it('registers exactly those three handlers and no more', () => {
    const mainSource = read('electron', 'main.js');
    const handled = [...mainSource.matchAll(/ipcMain\.handle\(\s*'(prepare:[^']+)'/g)]
      .map((m) => m[1]).sort();
    expect(handled).toEqual(SURVIVING_PREPARE_CHANNELS);
  });

  it('leaves no way for the renderer to start a conversion', () => {
    const rendererSources = indexSource + bridgeSource + read('electron', 'preload.js');
    for (const banned of ['prepare:ensure', 'ensurePlayable', 'prepare:progress']) {
      // The preload comment explaining the removal names these, so match the
      // executable forms rather than the words: a call, or a channel string.
      expect(rendererSources).not.toMatch(new RegExp(`invoke\\(\\s*'${banned}'`));
      expect(rendererSources).not.toMatch(new RegExp(`tv\\.${banned}\\s*\\(`));
    }
  });
});

/**
 * The design preview's fake bridge has to satisfy the renderer too.
 *
 * scripts/preview-stub.js stands in for preload when the UI is served to a
 * plain browser, which is how every review screenshot is taken. The renderer
 * builds its player at MODULE SCOPE, so a member the stub lacks is not a
 * degraded preview — the bundle throws on its first line and the page renders
 * BLANK, while shoot-all and shoot-state carry on reporting success.
 *
 * That already happened: the switchover added the mpv facade and nothing
 * taught the stub about it, so the project's only appearance check quietly
 * started photographing an empty page.
 */
const stubSource = read('scripts', 'preview-stub.js');
const stubKeys = new Set(
  [...stubSource.matchAll(/^\s{4}([A-Za-z0-9_]+)\s*:/gm)].map((m) => m[1]),
);

describe('the design preview stub', () => {
  it('finds the stub members at all', () => {
    expect(stubKeys.size).toBeGreaterThan(30);
  });

  it('provides every member the renderer calls', () => {
    const missing = [...used].filter((name) => !stubKeys.has(name)).sort();
    expect(missing).toEqual([]);
  });

  it('does not invent members the real bridge does not have', () => {
    // A stub verb spelled differently from preload is worse than a missing
    // one: the preview works, the app does not, and the difference is a
    // typo nobody looks for. mpvPlay/mpvPause were exactly this — the real
    // bridge has one mpvSetPause.
    const invented = [...stubKeys].filter((name) => !exposed.includes(name)).sort();
    expect(invented).toEqual([]);
  });
});
