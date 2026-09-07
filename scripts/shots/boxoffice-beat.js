/**
 * THE BOX OFFICE at one moment of its run, chosen by the URL.
 *
 * shoot-state photographs a snippet's final state, so a card with five beats
 * needs five runs. Rather than five near-identical files, the moment comes
 * from the query string — ?at=2400 — and the caller runs this once per beat
 * and tiles the results into a contact sheet.
 *
 * That sheet is the point: it is the same instrument used to read her
 * reference bumper (four frames a second, tiled), so the two can be laid side
 * by side and compared as timelines rather than as descriptions.
 *
 * Bare statements; throws so shoot-all gates on it.
 *
 * Failing controls, each RUN:
 *   - remove the travel measurement and it throws "the badge never travels";
 *   - remove the band and it throws "the picture is not revealed as a band".
 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const at = Number(new URLSearchParams(location.search).get('at') || 2600);

await wait(400);
window.tv.mpvOpen = () => Promise.resolve();
window.__preview.settings().bumperBackground = 'still';
window.__preview.showBoxOffice(() => {}, null);

/**
 * The travel offsets are written the moment the card is raised, so they are
 * readable immediately — and being zero means the badge opens exactly where
 * it ends, which is precisely the "not very dynamic" version.
 */
await wait(120);
const card = document.getElementById('boxoffice');
const travelX = parseFloat(card.style.getPropertyValue('--travel-x')) || 0;
const travelY = parseFloat(card.style.getPropertyValue('--travel-y')) || 0;
if (Math.abs(travelX) < 40 && Math.abs(travelY) < 40) {
  throw new Error(`the badge never travels: --travel-x=${travelX} --travel-y=${travelY}`);
}

// The band: before the picture opens, the backdrop is clipped to a slit.
const bg = card.querySelector('.boxoffice__bg');
if (!/inset/.test(getComputedStyle(bg).clipPath)) {
  throw new Error(`the picture is not revealed as a band: clip-path=${getComputedStyle(bg).clipPath}`);
}

await wait(Math.max(0, at - 520));

// Both labels she asked for, and in the right order.
const block = card.querySelector('.boxoffice__block');
const words = [...block.querySelectorAll('.boxoffice__word, .boxoffice__lead, .boxoffice__thenlabel')]
  .filter((el) => el.offsetParent !== null)
  .map((el) => el.textContent.trim());
if (at >= 3000 && !words.some((w) => /up next/i.test(w))) {
  throw new Error(`no "Up next" above the lead: ${words.join(' / ')}`);
}
if (at >= 3000 && block.querySelectorAll('.boxoffice__row').length
  && !words.some((w) => /followed by/i.test(w))) {
  throw new Error(`no "Followed by" above the rest: ${words.join(' / ')}`);
}

const box = card.getBoundingClientRect();
return { x: box.x, y: box.y, width: box.width, height: box.height };
