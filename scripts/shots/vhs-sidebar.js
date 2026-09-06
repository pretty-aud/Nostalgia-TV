/* The sidebar under the VCR skin. Bare statements. */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(700);
const sel = document.getElementById('themeSelect');
sel.value = 'vhs';
sel.dispatchEvent(new Event('change', { bubbles: true }));
await wait(900);
if (document.documentElement.dataset.skin !== 'vcr') throw new Error('data-skin not set: ' + document.documentElement.dataset.skin);

/**
 * THE SHOW CARD'S META LINE MUST NOT WRAP.
 *
 * It is the widest fixed string in the app — "NEXT S01E04 · 3 WATCHED OF 112"
 * — and the skin sets it in caps at 16px in a fixed-width sidebar. At 400px
 * it got 283px for 288px of text, so a three-digit episode count wrapped and
 * orphaned the count on a line of its own, leaving that card 24px taller than
 * its neighbours. Nothing overflowed, which is why no overflow check saw it;
 * the tell is the LINE COUNT.
 *
 * Both numbers on that line are deliberately labelled — they disagree by one
 * by design — so the answer is room, not truncation. This asserts the room.
 *
 * Failing control, run: set --sidebar-w back to 400px in the skin and this
 * throws "the show meta wrapped to 2 lines".
 */
const card = [...document.querySelectorAll('.show')].pop();
if (!card) throw new Error('no show cards in the sidebar');
const meta = card.querySelector('.show__meta');
if (!meta) throw new Error('a show card has no meta line');

// The worst case the library can actually produce: a three-digit code and a
// four-digit count, in caps.
meta.textContent = 'Next S01E123 · 7 watched of 1000';
await wait(300);
const metaLine = parseFloat(getComputedStyle(meta).lineHeight);
if (!Number.isFinite(metaLine) || metaLine <= 0) throw new Error('could not read the meta line-height');
const metaLines = Math.round(meta.scrollHeight / metaLine);
if (metaLines > 1) {
  throw new Error(`the show meta wrapped to ${metaLines} lines — ${meta.scrollWidth}px of text in ${meta.clientWidth}px`);
}

/**
 * UP NEXT BREAKS A TITLE AT ITS OWN SEAM.
 *
 * "Ghost in the Shell - Stand Alone Complex" has to set as two lines with the
 * episode code trailing the SECOND one. Before this the line broke wherever
 * the narrow column ran out, which orphaned the code onto a line by itself
 * and read as the title falling out of the row.
 *
 * Counted by HEIGHT against the line-height, not by getClientRects(): an
 * inline span containing a <br> reports a rect per line fragment plus one for
 * the break itself, so that count reads 3 for a two-line title and would make
 * this assertion nonsense. Measured that on the way in.
 *
 * Failing control, run: drop the titleLines() call in renderSchedule and
 * render item.showName as a single text node — the row stays one line tall
 * and this throws "set 1 line(s)".
 */
/**
 * READ WHAT THE RENDERER PRODUCED. Do not build it here.
 *
 * The first version of this set the two text nodes and the <br> itself and
 * then measured them, so it proved that CSS honours a line break — which was
 * never in doubt — and passed happily with the renderer emitting one flat
 * string. Verified: with titleLines() removed from renderSchedule it still
 * went green. The fixture now carries a seamed title so the real path runs.
 */
/**
 * Put the seamed show in the queue DELIBERATELY rather than hoping.
 *
 * Up next draws the rotation, which serves two-episode blocks and starts
 * wherever the saved state left it — so across runs the fixture's seamed
 * title was simply absent from the four rows about half the time. A marathon
 * pins the queue to one show, which is the app's own way of saying "only this
 * one", and makes the assertion below deterministic.
 */
const seamCard = [...document.querySelectorAll('.show')]
  .find((c) => /\s[-–—]\s/.test((c.querySelector('.show__name') || {}).textContent || ''));
if (!seamCard) throw new Error('the fixture has no show with a seamed title to test');
const marathonBtn = seamCard.querySelector('.showctl[data-act="marathon"]');
if (!marathonBtn) throw new Error('no marathon control on the seamed show');
marathonBtn.click();
await wait(700);

const rows = [...document.querySelectorAll('#scheduleList .sched')];
if (!rows.length) throw new Error('no Up next rows to check');
const seamRow = rows.find((r) => {
  const n = r.querySelector('.sched__name');
  return n && /\s[-–—]\s/.test(n.textContent);
}) || rows.find((r) => r.querySelector('.sched__name br'));
if (!seamRow) {
  throw new Error(`the seamed show is not in Up next even under a marathon. Rows: ${rows.map((r) => (r.querySelector('.sched__name') || {}).textContent).join(' | ')}`);
}
const seamName = seamRow.querySelector('.sched__name');
const seamCode = seamRow.querySelector('.sched__code');
if (!seamCode) throw new Error('the seamed Up next row has no episode code');

// The renderer must have BROKEN it, not merely printed it.
if (!seamName.querySelector('br')) {
  throw new Error(`the renderer set "${seamName.textContent}" as one run — no break at the seam`);
}
const titleLine = parseFloat(getComputedStyle(seamName).lineHeight);
if (!Number.isFinite(titleLine) || titleLine <= 0) throw new Error('could not read the title line-height');

// ...and it must actually occupy two line boxes, which a <br> inside a
// display:none or zero-height element would not.
const plain = rows.find((r) => {
  const n = r.querySelector('.sched__name');
  return n && !n.querySelector('br');
});
if (plain) {
  const oneLine = plain.getBoundingClientRect().height;
  const twoLine = seamRow.getBoundingClientRect().height;
  const grew = Math.round((twoLine - oneLine) / titleLine);
  if (grew !== 1) {
    throw new Error(`a seamed title set ${grew + 1} line(s): ${oneLine}px vs ${twoLine}px with a ${titleLine}px line`);
  }
}

/**
 * The code sits on the title's FIRST line, in its own column.
 *
 * It used to trail the title inline, which put it under the subtitle on a
 * two-line name. It is a grid cell now, and the row's baseline alignment
 * places it beside the series name — the line it actually identifies.
 */
const titleRects = [...seamName.getClientRects()].filter((r) => r.width > 0);
const firstLine = titleRects[0];
const codeBox = seamCode.getBoundingClientRect();
if (Math.abs(codeBox.top - firstLine.top) > 6) {
  throw new Error(`the episode code is not on the title's first line (${Math.round(codeBox.top)} vs ${Math.round(firstLine.top)})`);
}
// It must not sit on top of the title either.
for (const rect of titleRects) {
  if (rect.right > codeBox.left + 1) {
    throw new Error(`the title runs ${Math.round(rect.right - codeBox.left)}px into the code column`);
  }
}

/**
 * AND THE CODES MUST SHARE ONE TAB STOP.
 *
 * Every row is its own grid, so nothing makes the columns line up by itself —
 * it depends on the code column having a floor wide enough for the longest
 * label and on the bump control's column being reserved on every row. Give
 * one row a three-digit episode, which is the case that breaks it, and check
 * that every code still starts at the same x.
 */
const codeCells = [...document.querySelectorAll('#scheduleList .sched .sched__code')];
if (codeCells.length > 1) {
  codeCells[codeCells.length - 1].textContent = 'S01E123';
  await wait(200);
  const lefts = codeCells.map((c) => Math.round(c.getBoundingClientRect().left));
  const spread = Math.max(...lefts) - Math.min(...lefts);
  if (spread > 1) {
    throw new Error(`the episode codes are not on one tab stop: left edges ${lefts.join(', ')}`);
  }
}

// Leave the marathon off, so the screenshot this probe takes is the sidebar
// in its ordinary state rather than pinned to one show.
marathonBtn.click();
await wait(500);
