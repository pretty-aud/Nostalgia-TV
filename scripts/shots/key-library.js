/**
 * The L / Escape walk between the sidebar and the library page.
 * Bare statements; throws on failure so shoot-all gates on it.
 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = {};
const app = document.getElementById('app');
const key = (k) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const browseShown = () => !document.getElementById('browse').hidden;

await wait(600);
out.startsOnSidebar = app.dataset.view === 'ready';

// L from the sidebar OPENS the library page (it used to start playback).
key('l');
await wait(600);
out.lOpensLibrary = browseShown();

// The search box must NOT be focused, or it would swallow the L that closes.
out.searchNotFocused = document.activeElement !== document.getElementById('browseSearch');

// L again closes it, back to the sidebar — not back to the picture.
key('l');
await wait(500);
out.lClosesLibrary = !browseShown();
out.lLandsOnSidebar = app.dataset.view === 'ready';

// Escape does the same.
key('l');
await wait(500);
out.reopened = browseShown();
key('Escape');
await wait(500);
out.escapeCloses = !browseShown();
out.escapeLandsOnSidebar = app.dataset.view === 'ready';

// With a show card open, both keys peel ONE layer: the card, then the page.
key('l');
await wait(600);
const tile = document.querySelector('#browseBody .tile');
if (tile) {
  tile.click();
  await wait(600);
  out.detailOpened = !document.getElementById('browseDetail').hidden;
  key('l');
  await wait(400);
  out.lPeelsDetailFirst = document.getElementById('browseDetail').hidden && browseShown();
  key('l');
  await wait(400);
  out.lThenClosesPage = !browseShown();
}

const failures = Object.entries(out).filter(([, v]) => !v);
if (failures.length) throw new Error(`key walk failed: ${failures.map(([k]) => k).join(', ')} — ${JSON.stringify(out)}`);
return out;
