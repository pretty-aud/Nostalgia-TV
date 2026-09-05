import { describe, it, expect } from 'vitest';
import { subStyleProperties, mpvColor } from '../src/shared/mpvSubStyle.js';
import { cropSpecFor } from '../src/shared/mpvCrop.js';

/**
 * The settings-to-mpv translations. The settings object is the one the
 * Settings screen has always edited; these pins hold the translation so a
 * future tweak to one property cannot silently re-style another.
 */
describe('subStyleProperties', () => {
  it('maps the defaults onto mpv\'s renderer', () => {
    expect(subStyleProperties({
      color: '#ffffff', font: 'sans', size: 100,
      background: true, backgroundOpacity: 75, position: 'bottom',
    })).toEqual({
      'sub-color': '#ffffffff',
      'sub-font': 'Segoe UI',
      'sub-font-size': 38,               // mpv's own default, at 100%
      // THE MODE IS THE FEATURE: on mpv 0.39+ the box only draws in
      // background-box mode — colours alone render NOTHING on the default
      // border style, which was a review-caught invisible-subtitles blocker.
      'sub-border-style': 'background-box',
      'sub-back-color': '#bf000000',     // 75% alpha over black
      'sub-outline-size': 0,             // the box provides the edge
      'sub-outline-color': '#ff000000',
      'sub-pos': 100,
    });
  });

  it('size is a percent of mpv\'s default cue size', () => {
    expect(subStyleProperties({ size: 150 })['sub-font-size']).toBe(57);
    expect(subStyleProperties({ size: 50 })['sub-font-size']).toBe(19);
    expect(subStyleProperties({ size: 0 })['sub-font-size']).toBe(38);   // garbage: default
  });

  it('box off swaps the background for a text outline — the edge must come from somewhere', () => {
    const style = subStyleProperties({ background: false });
    expect(style['sub-border-style']).toBe('outline-and-shadow');
    expect(style['sub-back-color']).toBe('#00000000');
    expect(style['sub-outline-size']).toBe(3);
  });

  it('positions map top/middle/bottom onto sub-pos heights', () => {
    expect(subStyleProperties({ position: 'top' })['sub-pos']).toBe(10);
    expect(subStyleProperties({ position: 'middle' })['sub-pos']).toBe(50);
    expect(subStyleProperties({ position: 'bottom' })['sub-pos']).toBe(100);
    expect(subStyleProperties({})['sub-pos']).toBe(100);
  });

  it('fonts name one real family per role, defaulting sane', () => {
    expect(subStyleProperties({ font: 'mono' })['sub-font']).toBe('Consolas');
    expect(subStyleProperties({ font: 'nonsense' })['sub-font']).toBe('Segoe UI');
  });

  it('mpvColor builds #AARRGGBB and refuses garbage hex', () => {
    expect(mpvColor('#ffe066', 100)).toBe('#ffffe066');
    expect(mpvColor('#000000', 50)).toBe('#80000000');
    expect(mpvColor('not-a-color', 100)).toBe('#ffffffff');
    // Single-digit alphas MUST pad: '#0000000' (7 chars) would fail the
    // host's colour validation and silently refuse the whole style batch
    // for anyone sliding opacity to the bottom of its range.
    expect(mpvColor('#000000', 0)).toBe('#00000000');
    expect(mpvColor('#000000', 5)).toBe('#0d000000');
  });

  it('a missing backgroundOpacity falls back to the 75% default', () => {
    expect(subStyleProperties({ background: true })['sub-back-color']).toBe('#bf000000');
  });
});

/**
 * The crop translation. Same detection, same fractions — the output is
 * mpv's video-crop spec, which names the real picture's pixel box and lets
 * mpv re-fit it at every window size, where the CSS transform had to
 * re-derive geometry on each resize.
 */
describe('cropSpecFor', () => {
  it('translates the canonical 4:3-inside-16:9 pillarbox to the picture\'s pixel box', () => {
    // Her real case: 852x480 tagged 16:9 with the picture pillarboxed in.
    // 0.75 of 852 is 639 -> grown to even 640; origin 106.5 -> floored to 106.
    expect(cropSpecFor({ fx: 0.125, fy: 0, fw: 0.75, fh: 1, worthCropping: true }, 852, 480))
      .toBe('640x480+106+0');
  });

  it('rounds in the keep-picture direction: origins floor, sizes grow', () => {
    expect(cropSpecFor({ fx: 0.1, fy: 0.1, fw: 0.8, fh: 0.8, worthCropping: true }, 1001, 1001))
      .toBe('802x802+100+100');
    // An origin landing on an odd pixel FLOORS to even, and the WIDTH grows
    // to keep the content's far edge: content spans columns 107..749 here,
    // and 644 from 106 covers it all — 642 would have shaved column 748.
    expect(cropSpecFor({ fx: 0.125, fy: 0, fw: 0.75, fh: 1, worthCropping: true }, 856, 480))
      .toBe('644x480+106+0');
  });

  it('re-snaps an odd frame-edge clamp down to even', () => {
    // vw 999, fx 0.5 -> x=498; the remainder 501 is odd and must not leak
    // into the spec — chroma subsampling dislikes odd dimensions.
    expect(cropSpecFor({ fx: 0.5, fy: 0, fw: 0.6, fh: 1, worthCropping: true }, 999, 500))
      .toBe('500x500+498+0');
  });

  it('never lets the box escape the frame', () => {
    // fx 0.5 + fw 0.6 overruns the right edge; the width clamps to what
    // remains, the untouched axis keeps its full size.
    const spec = cropSpecFor({ fx: 0.5, fy: 0, fw: 0.6, fh: 1, worthCropping: true }, 1000, 500);
    expect(spec).toBe('500x500+500+0');
  });

  it('leaves the frame alone when the crop is not worth acting on', () => {
    expect(cropSpecFor({ fx: 0, fy: 0, fw: 0.75, fh: 1, worthCropping: false }, 852, 480)).toBeNull();
    expect(cropSpecFor(null, 852, 480)).toBeNull();
    // A box that keeps (nearly) everything after rounding: not worth it.
    expect(cropSpecFor({ fx: 0, fy: 0, fw: 0.999, fh: 0.999, worthCropping: true }, 1920, 1080)).toBeNull();
  });

  /**
   * THE 4.7% BOX. A viewer found this, on her own film, in the first hour the
   * auto-crop had ever actually run on this branch.
   *
   * cropdetect sampled "All You Need is Kill (2025)" at four points, every one
   * of them a dark stretch, and honestly reported the only lit patch it could
   * see: 316x310 in the middle of a 1920x1080 frame. detectCrop's union across
   * samples is the safety rule and could not help — the union keeps the most
   * picture ANY sample saw, and no sample had seen the picture. The box was
   * cached, and mpv obediently treated a postage stamp as the whole film.
   *
   * Bars are borders. Across 136 cached detections in her real library, every
   * one of the 24 legitimate crops kept at least 74.6% of the frame; the floor
   * sits at 50%, far below anything real and far above this.
   */
  it('refuses a box too small to be bars, however confidently it was measured', () => {
    const theRealOne = {
      fx: 0.41770833333333335,
      fy: 0.3574074074074074,
      fw: 0.16458333333333333,
      fh: 0.28703703703703703,
      worthCropping: true,
    };
    expect(cropSpecFor(theRealOne, 1920, 1080)).toBeNull();
  });

  it('still accepts every shape a real bar crop takes', () => {
    // 4:3 pillarboxed in 16:9 — 75% of the frame.
    expect(cropSpecFor({ fx: 0.125, fy: 0, fw: 0.75, fh: 1, worthCropping: true }, 1920, 1080))
      .toBe('1440x1080+240+0');
    // 2.35:1 letterboxed in 16:9 — 75%, the other axis. Origin 133.9 floors to
    // 132 and the far edge 946.1 grows to 948, so the height is 816: the
    // keep-picture rounding, not a slack expectation.
    expect(cropSpecFor({ fx: 0, fy: 0.124, fw: 1, fh: 0.752, worthCropping: true }, 1920, 1080))
      .toBe('1920x816+0+132');
    // Windowboxed on all four sides: both axes shaved, still plainly bars.
    expect(cropSpecFor({ fx: 0.09, fy: 0.09, fw: 0.82, fh: 0.82, worthCropping: true }, 1920, 1080))
      .toBe('1576x888+172+96');
  });

  it('refuses garbage fractions and garbage dimensions', () => {
    expect(cropSpecFor({ fx: 0, fy: 0, fw: 1.4, fh: 1, worthCropping: true }, 852, 480)).toBeNull();
    expect(cropSpecFor({ fx: 0, fy: 0, fw: 0.75, fh: 1, worthCropping: true }, 0, 480)).toBeNull();
    expect(cropSpecFor({ fx: 0, fy: 0, fw: 0.75, fh: 1, worthCropping: true }, NaN, 480)).toBeNull();
  });
});
