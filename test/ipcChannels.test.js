import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Every channel the preload invokes must have a handler in main.
 *
 * The two halves are in different files and nothing connects them but a string.
 * A typo does not throw at startup, does not show in a build and does not fail a
 * render — `invoke` on an unhandled channel returns a rejected promise, so the
 * button simply does nothing. That is survivable for most of this API and not
 * survivable for the window buttons: with the system title bar gone they are the
 * only minimise and close there are, and getting one of those strings wrong
 * leaves a window that cannot be closed.
 *
 * Source text rather than imports, because neither file can be loaded outside
 * Electron.
 */

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const read = (f) => fs.readFileSync(path.join(here, '..', 'electron', f), 'utf8');

const preload = read('preload.js');
const main = read('main.js');

const invoked = [...preload.matchAll(/ipcRenderer\.invoke\(\s*'([^']+)'/g)].map((m) => m[1]);
const handled = [...main.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)].map((m) => m[1]);

const sent = [...main.matchAll(/webContents\.send\(\s*'([^']+)'/g)].map((m) => m[1]);
const listened = [...preload.matchAll(/ipcRenderer\.on\(\s*'([^']+)'/g)].map((m) => m[1]);

describe('ipc channels', () => {
  it('finds channels on both sides at all', () => {
    // A regex that silently matched nothing would make every check below pass.
    expect(invoked.length).toBeGreaterThan(10);
    expect(handled.length).toBeGreaterThan(10);
    expect(sent.length).toBeGreaterThan(0);
  });

  it('has a handler for everything the renderer invokes', () => {
    expect(invoked.filter((channel) => !handled.includes(channel))).toEqual([]);
  });

  it('has a listener for everything main pushes', () => {
    expect(sent.filter((channel) => !listened.includes(channel))).toEqual([]);
  });

  it('wires the window buttons, which have no fallback', () => {
    // Named explicitly rather than left to the sweep above: if someone removes
    // the preload entries the sweep goes quiet, and the failure is a window
    // with no way to close it.
    for (const channel of ['window:minimize', 'window:toggleMaximize', 'window:close']) {
      expect(handled).toContain(channel);
      expect(invoked).toContain(channel);
    }
    expect(sent).toContain('window:state');
    expect(listened).toContain('window:state');
  });

  it('runs the window without a system frame', () => {
    // The single line the whole overlay depends on. Put the frame back and the
    // buttons become a second set below a real title bar.
    expect(main).toMatch(/frame:\s*false/);
  });
});
