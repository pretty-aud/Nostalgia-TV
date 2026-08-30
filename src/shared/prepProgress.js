'use strict';

/**
 * What to say while a file is being converted.
 *
 * Split out from the renderer because it is the part that can be WRONG, and the
 * part a screenshot cannot check: an estimate drawn from one tick of a
 * forty-minute job is wild, a percentage of an unknown duration is a lie, and
 * both look perfectly reasonable in a picture.
 *
 * The wait this exists for is real. A 49GB film whose audio Chromium cannot
 * decode takes about forty minutes to rebuild. What used to announce it was a
 * toast with a sixty-second life, so the message vanished after one minute and
 * left thirty-nine of silence — reported, reasonably, as "it says processing,
 * then the popup disappears and nothing plays".
 */

/** Below this the estimate is drawn from too little to mean anything. */
const ESTIMATE_AFTER_SECONDS = 8;

/** And from too little of the FILE, which is the same problem measured differently. */
const ESTIMATE_AFTER_FRACTION = 0.01;

function formatClock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Rounded, and deliberately vague at the short end.
 *
 * "about 43 seconds left" invites you to watch it be wrong. Anything under a
 * minute and a half is just "a minute".
 */
function describeRemaining(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds < 90) return 'a minute';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours} hours`;
}

/**
 * Returns { fraction, text }.
 *
 * `fraction` is null when the file's duration is unknown, which happens and has
 * to be survivable: the bar is then left alone rather than animated to imply
 * progress nobody measured.
 */
function preparingCopy(outMs, totalMs, elapsedSeconds) {
  const done = Math.max(0, Number(outMs) || 0);
  const total = Number(totalMs) || 0;
  const elapsed = Math.max(0, Number(elapsedSeconds) || 0);

  if (total <= 0) {
    return { fraction: null, text: `${formatClock(done / 1000)} converted` };
  }

  const fraction = Math.max(0, Math.min(1, done / total));
  const ready = elapsed > ESTIMATE_AFTER_SECONDS && fraction > ESTIMATE_AFTER_FRACTION;
  const remaining = ready ? describeRemaining((elapsed / fraction) - elapsed) : null;

  return {
    fraction,
    text: `${formatClock(done / 1000)} of ${formatClock(total / 1000)}`
      + (remaining ? `  ·  about ${remaining} left` : ''),
  };
}

module.exports = {
  preparingCopy,
  // Exported for tests.
  describeRemaining,
};
