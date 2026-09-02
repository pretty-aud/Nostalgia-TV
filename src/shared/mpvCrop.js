'use strict';

/**
 * The auto-crop, spoken as mpv's video-crop.
 *
 * detectCrop's output is unchanged — cached, unioned FRACTIONS of the frame
 * ({fx, fy, fw, fh}, plus worthCropping), found the same way with the same
 * safety direction (union over sample points, so a dark scene can never
 * shave real picture). The application is where mpv is a straight upgrade:
 *
 * The CSS transform had to re-derive scale and translation from the window
 * geometry on every resize, because the zoom it applied came from the
 * MISMATCH between the content's aspect and the window's — a first attempt
 * here reproduced the transform's scale formula and got a zoom of zero for
 * the canonical pillarbox, since against a window matching the video's own
 * aspect there IS no mismatch to exploit. mpv's `video-crop` property
 * removes the window from the equation entirely: name the real picture's
 * pixel box once, and mpv treats THAT as the video, containing it correctly
 * at every window size and aspect from then on.
 *
 * Fractions become pixels against the video's coded dimensions, snapped to
 * even numbers (chroma subsampling dislikes odd offsets), and grown rather
 * than shrunk when rounding — the union rule again: when in doubt, keep
 * picture, never shave it.
 */

/** "WxH+X+Y" for mpv's video-crop, or null for "leave the frame alone". */
function cropSpecFor(crop, videoWidth, videoHeight) {
  if (!crop || !crop.worthCropping) return null;

  const vw = Number(videoWidth);
  const vh = Number(videoHeight);
  if (!Number.isInteger(vw) || !Number.isInteger(vh) || vw <= 0 || vh <= 0) return null;

  const fw = Number(crop.fw);
  const fh = Number(crop.fh);
  if (!(fw > 0) || !(fh > 0) || fw > 1 || fh > 1) return null;

  const fx = Math.min(1, Math.max(0, Number(crop.fx) || 0));
  const fy = Math.min(1, Math.max(0, Number(crop.fy) || 0));

  // Round the ORIGIN down and the SIZE up to even pixels: every rounding
  // error keeps picture instead of shaving it.
  const even = (n) => Math.max(0, 2 * Math.floor(n / 2));
  const evenUp = (n) => 2 * Math.ceil(n / 2);

  const x = even(fx * vw);
  const y = even(fy * vh);
  // Sizes come from the content's FAR EXTENT, not from fw alone: flooring
  // the origin without widening to match would shave the right/bottom edge
  // by the pixels the floor gave back — the exact error the keep-picture
  // rule forbids. Even minus even stays even; the frame clamp can hand back
  // an odd remainder on odd-sized video, so re-snap DOWN at the boundary,
  // where there is no further picture to keep.
  const w = even(Math.min(vw, evenUp((fx + fw) * vw)) - x);
  const h = even(Math.min(vh, evenUp((fy + fh) * vh)) - y);
  if (w <= 0 || h <= 0) return null;

  // A crop that keeps (nearly) everything is not worth a mode switch —
  // mirrors detectCrop's own worthCropping threshold, re-checked after
  // rounding so a borderline box cannot flap.
  if (w >= vw - 2 && h >= vh - 2) return null;

  return `${w}x${h}+${x}+${y}`;
}

module.exports = { cropSpecFor };
