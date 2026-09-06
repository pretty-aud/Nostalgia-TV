/**
 * A FILM OPENS A PANEL, and does not start playing.
 *
 * Clicking a movie used to play it outright, so there was nowhere to say what
 * the file is — which is the question you ask before committing to two hours.
 * It now opens the same panel a series does, minus the one thing a film has
 * nothing to put in: the episode list. Its settings button stays and is
 * pointed at the film.
 *
 * The regression this guards is the one that would be worst to ship: the
 * panel hides the list and relabels the button for a film, so if neither is
 * restored the NEXT series opens with no episodes and a button labelled for a
 * film. Both kinds are opened here, in that order, for exactly that reason.
 *
 * Bare statements; throws so shoot-all gates on it.
 *
 * Failing controls, RUN rather than assumed:
 *   - point the movie tile back at playMovieFromLibrary and it throws "a film
 *     did not open the panel";
 *   - remove the restore from BOTH openDetail and closeDetail and it throws
 *     "a series opened with its episode list still hidden".
 *
 * That second control needed both. Removing either one alone leaves this
 * probe green, because the two restores are redundant with each other on
 * every route the interface can actually take: the panel is modal, so the
 * only way from a film to a series is through Close. Neither is therefore
 * load-bearing on its own, and the pair is belt and braces rather than one
 * mechanism — said out loud here because a comment claiming otherwise is how
 * a future reader deletes the wrong one and finds the probe still passing.
 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(700);
document.getElementById('btnBrowse').click();
await wait(900);

const app = document.getElementById('app');
const panel = document.getElementById('browseDetail');

/** The Movies grid — the section whose heading says so. */
const sections = [...document.querySelectorAll('.browsesec')];
const movieSection = sections.find((s) => /movie/i.test((s.querySelector('.browsesec__head, h2, h3') || {}).textContent || ''));
if (!movieSection) throw new Error(`no Movies section: ${sections.map((s) => (s.querySelector('.browsesec__head, h2, h3') || {}).textContent).join(' | ')}`);
const movieTile = movieSection.querySelector('.tile');
if (!movieTile) throw new Error('the Movies section has no tiles');

movieTile.click();
await wait(900);

if (panel.hidden) throw new Error('a film did not open the panel');
if (app.dataset.view === 'playing') throw new Error('a film started playing instead of opening the panel');

// A film has no episodes to list. It DOES have languages and a card image,
// so the settings button stays — this asserted the opposite when the panel
// was first built, which was right then and became wrong the moment films
// were given settings of their own. A probe that pins a superseded decision
// is worse than none: it argues for the old behaviour with a red build.
if (!document.getElementById('detailEpisodes').hidden) {
  throw new Error('the film panel is showing an episode list');
}
const filmSettings = document.getElementById('btnDetailSettings');
if (filmSettings.hidden) throw new Error('the film panel hides its settings button');
if (!/movie/i.test(filmSettings.textContent)) {
  throw new Error(`the film's settings button reads "${filmSettings.textContent}"`);
}
const title = document.getElementById('detailTitle').textContent.trim();
if (!title) throw new Error('the film panel has no title');
if (!/movie/i.test(document.getElementById('detailMeta').textContent)) {
  throw new Error(`the film panel does not say it is a movie: "${document.getElementById('detailMeta').textContent}"`);
}

// The media line has to work here too — it is why the panel exists.
const row = document.getElementById('detailMedia');
for (let i = 0; i < 20 && row.hidden; i += 1) await wait(100);
if (row.hidden) throw new Error('the film panel never showed its media line');

// Play must act on the FILM, not on whatever show was open before.
const play = document.getElementById('btnDetailPlay');
if (!/play|resume/i.test(play.textContent)) throw new Error(`the film panel's button reads "${play.textContent}"`);

document.getElementById('btnDetailClose').click();
await wait(500);
if (!panel.hidden) throw new Error('the film panel did not close');

/**
 * NOW A SERIES, which is the regression that matters.
 */
const showTile = sections
  .filter((s) => s !== movieSection)
  .map((s) => s.querySelector('.tile'))
  .find(Boolean);
if (!showTile) throw new Error('no series tile to open after the film');
showTile.click();
await wait(900);
if (panel.hidden) throw new Error('a series did not open the panel after a film');
if (document.getElementById('detailEpisodes').hidden) {
  throw new Error('a series opened with its episode list still hidden');
}
if (!/show/i.test(document.getElementById('btnDetailSettings').textContent)) {
  throw new Error('a series opened with the film panel settings label');
}
if (!document.querySelector('#detailEpisodes .ep')) {
  throw new Error('the series panel listed no episodes');
}

const box = document.querySelector('.detail__panel').getBoundingClientRect();
return { x: box.x, y: box.y, width: Math.min(760, box.width), height: Math.min(520, box.height) };
