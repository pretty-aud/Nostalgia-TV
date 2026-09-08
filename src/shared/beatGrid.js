'use strict';

/**
 * The pulse used when a track's tempo could not be found — ambient, rubato, or
 * simply too short to hold a bar. Lives here rather than with the analysis
 * because the GRID is what needs it: the card still cuts on a regular beat, it
 * just is not claiming to have heard one.
 */
const FALLBACK_BPM = 90;

/**
 * THE BEAT GRID a card cuts on — pure arithmetic, shared by both processes.
 *
 * It lived in electron/bumperTempo.js beside the analysis that produces a
 * tempo, which was the wrong side of the wall: the analysis needs ffmpeg and a
 * child process, and this needs neither. The renderer draws the card and so
 * needs the grid, and a renderer cannot require anything under electron/.
 */

/**
 * FOUR BEATS TO THE BAR, ASSUMED, and stated rather than detected.
 *
 * Telling 3/4 from 4/4 needs downbeat detection, which is a different and much
 * harder problem than tempo — it depends on harmonic change and stress, not on
 * periodicity, and a wrong answer would put every cut on the wrong beat of the
 * bar rather than merely somewhere odd. Almost everything this style will be
 * pointed at is in four. If a waltz turns up, the cuts land on beats rather
 * than bars and nobody can tell.
 */
const BEATS_PER_BAR = 4;

/**
 * The beat times a card should cut on, in seconds from the moment playback
 * starts — which is `startAt` into the file, not its beginning.
 *
 * THE HOOK AND THE GRID HAVE TO AGREE. bumperMusic.pickStart chooses where in
 * the track to come in, and that offset is almost never on a beat. Without
 * folding it in here, every cut would be out by the same constant, which is the
 * failure that looks most like "the beat detection does not work".
 */
function gridFrom(tempo, startAt, seconds) {
  const period = 60 / (tempo.bpm || FALLBACK_BPM);

  const beats = [];
  /**
   * WITHOUT A TRUSTED PHASE THE GRID STARTS AT ZERO.
   *
   * An unconfident read has no meaningful phase — there was no peak to take one
   * from — so aligning to it would be aligning to a number that came from
   * nowhere, and would push the first cut an arbitrary fraction of a beat late
   * for no reason. Starting at zero at least makes the first pop land with the
   * music coming in.
   */
  /**
   * The first beat at or after the card's own zero.
   *
   * `phase` is a time in the FILE where a beat falls, measured within twenty
   * seconds of `startAt`. The offset between them is reduced into [0, period)
   * by a single modulo — which works whether the measured beat sits before the
   * hook or after it, and which the previous `ceil` form got wrong for negative
   * offsets by returning a first beat a whole period late.
   */
  const first = tempo.confident
    ? (() => {
      const offset = (tempo.phase || 0) - startAt;
      return offset - Math.floor(offset / period) * period;
    })()
    : 0;

  for (let t = first; t < seconds; t += period) {
    if (t >= 0) beats.push(Number(t.toFixed(3)));
  }
  return { period, beats, barLength: period * BEATS_PER_BAR };
}

module.exports = { gridFrom, BEATS_PER_BAR, FALLBACK_BPM };
