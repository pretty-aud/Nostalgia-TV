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
const lineHeight = parseFloat(getComputedStyle(meta).lineHeight);
const lines = Math.round(meta.scrollHeight / lineHeight);
if (!Number.isFinite(lineHeight) || lineHeight <= 0) throw new Error('could not read the meta line-height');
if (lines > 1) {
  throw new Error(`the show meta wrapped to ${lines} lines — ${meta.scrollWidth}px of text in ${meta.clientWidth}px`);
}
