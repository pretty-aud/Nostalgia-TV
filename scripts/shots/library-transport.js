/**
 * LIBRARY MODE IS NOT THE CHANNEL.
 *
 * Five things she asked for, all of which are behaviour rather than pixels:
 *
 *   1. Previous and Next walk the SELECTED show, not the channel's history.
 *      Pressing Previous while watching a library pick used to play the last
 *      thing the CHANNEL had shown — a different programme entirely.
 *   2. The player's "Next: <show> <episode>" line is hidden in library mode.
 *      It is the channel announcing its own queue, which she is not in.
 *   3. A film hides Previous and Next: there is nothing to step to.
 *   4. The film panel offers Start over once there is a position to abandon.
 *   5. The film panel offers settings, pointed at the film.
 *
 * Bare statements; throws so shoot-all gates on it.
 *
 * Failing controls, each RUN:
 *   - make stepLibraryEpisode return false and Next leaves the episode where
 *     it was: "Next did not move to the following episode";
 *   - drop the .upnext rule and it throws "the channel's up-next is showing";
 *   - drop the data-library rule and it throws "Previous is showing for a
 *     film".
 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const app = document.getElementById('app');
await wait(700);
document.getElementById('btnBrowse').click();
await wait(900);

const sections = [...document.querySelectorAll('.browsesec')];
const headOf = (s) => ((s.querySelector('.browsesec__head, h2, h3') || {}).textContent || '');
const movieSection = sections.find((s) => /movie/i.test(headOf(s)));
const showSection = sections.find((s) => s !== movieSection && s.querySelector('.tile'));
if (!movieSection || !showSection) throw new Error('need both a show and a movie section');

// ── a series, from the library ────────────────────────────────────────────
showSection.querySelector('.tile').click();
await wait(800);
const episodes = [...document.querySelectorAll('#detailEpisodes .ep')];
if (episodes.length < 3) throw new Error('need a show with at least three episodes');
// Start on the SECOND episode, so Previous has somewhere to go.
episodes[1].click();
await wait(1200);

if (app.dataset.browsing !== 'true') throw new Error('playing a library pick did not enter library mode');
if (app.dataset.library !== 'show') throw new Error(`data-library is "${app.dataset.library}" for a series`);

const codeNow = () => document.getElementById('npCode').textContent.trim();
const second = codeNow();
if (!second) throw new Error('nothing is playing');

// 2 — the channel's announcement has nothing to say here.
const upnext = document.querySelector('.chrome .upnext');
if (getComputedStyle(upnext).display !== 'none') {
  throw new Error(`the channel's up-next is showing in library mode: "${upnext.textContent}"`);
}

// 1 — Previous walks the SHOW.
document.getElementById('btnPrev').click();
await wait(1200);
const first = codeNow();
if (first === second) throw new Error('Previous did not move off the episode it was on');
if (app.dataset.library !== 'show') throw new Error('Previous left library mode');

document.getElementById('btnNext').click();
await wait(1200);
if (codeNow() !== second) {
  throw new Error(`Next did not move to the following episode: expected ${second}, got ${codeNow()}`);
}

// At the ends it says so rather than falling through to the channel.
document.getElementById('btnPrev').click();
await wait(1000);
document.getElementById('btnPrev').click();
await wait(800);
if (app.dataset.library !== 'show') throw new Error('Previous at the first episode left library mode');

// ── a film, from the library ──────────────────────────────────────────────
document.getElementById('btnBrowse').click();
await wait(900);
movieSection.querySelector('.tile').click();
await wait(800);

// 5 — the film panel offers its own settings.
const settings = document.getElementById('btnDetailSettings');
if (settings.hidden) throw new Error('the film panel hides the settings button');
if (!/movie/i.test(settings.textContent)) {
  throw new Error(`the film's settings button reads "${settings.textContent}"`);
}
settings.click();
await wait(600);
if (document.getElementById('showSetModal').hidden) throw new Error('the film settings sheet did not open');
if (!document.getElementById('btnShowSetForget').hidden) {
  throw new Error('the film settings sheet offers to forget a watch history it does not have');
}
document.getElementById('btnCloseShowSet').click();
await wait(400);

document.getElementById('btnDetailPlay').click();
await wait(1400);
if (app.dataset.library !== 'movie') throw new Error(`data-library is "${app.dataset.library}" for a film`);

// 3 — nothing to step to.
for (const id of ['btnPrev', 'btnNext']) {
  if (getComputedStyle(document.getElementById(id)).display !== 'none') {
    throw new Error(`${id === 'btnPrev' ? 'Previous' : 'Next'} is showing for a film`);
  }
}
if (getComputedStyle(upnext).display !== 'none') throw new Error('a film is showing the channel up-next');

/**
 * 4 — Start over appears exactly when there is a position to abandon.
 *
 * Both halves, and the tiles are SEARCHED rather than assumed: the Movies
 * grid is alphabetical, so "the first tile" is not the film the fixture gave
 * a saved position to. Asserting only the visible case would also pass on a
 * button that is simply always there.
 */
const restart = document.getElementById('btnDetailRestart');
const seen = { withPosition: false, without: false };
for (const tile of movieSection.querySelectorAll('.tile')) {
  document.getElementById('btnBrowse').click();
  await wait(700);
  tile.click();
  await wait(800);
  const resuming = /resume/i.test(document.getElementById('btnDetailPlay').textContent);
  if (resuming && restart.hidden) {
    throw new Error(`${document.getElementById('detailTitle').textContent} offers Resume but no Start over`);
  }
  if (!resuming && !restart.hidden) {
    throw new Error(`${document.getElementById('detailTitle').textContent} was never started but offers Start over`);
  }
  seen[resuming ? 'withPosition' : 'without'] = true;
}
if (!seen.withPosition) throw new Error('no film in the fixture has a saved position — this cannot be tested');
if (!seen.without) throw new Error('every film has a position — the hidden case is untested');

// And a series must not inherit the film's panel state.
document.getElementById('btnDetailClose').click();
await wait(400);
showSection.querySelector('.tile').click();
await wait(800);
if (!document.getElementById('btnDetailRestart').hidden) {
  throw new Error('a series inherited the film panel Start over button');
}
if (!/show/i.test(document.getElementById('btnDetailSettings').textContent)) {
  throw new Error('a series inherited the film settings label');
}

const box = document.querySelector('.detail__panel').getBoundingClientRect();
return { x: box.x, y: box.y, width: Math.min(760, box.width), height: Math.min(300, box.height) };
