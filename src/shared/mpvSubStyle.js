'use strict';

/**
 * Her subtitle settings, translated into mpv's subtitle renderer.
 *
 * The settings shape is unchanged — {color, font, size, background,
 * backgroundOpacity, position}, the same object the Settings screen and its
 * live preview have always edited — only the OUTPUT changes: instead of a
 * ::cue stylesheet rewritten into the video element's shadow DOM, it becomes
 * a set of mpv properties. mpv's renderer is an upgrade underneath: ASS
 * styling and image subs render properly, where the old path could only
 * refuse them.
 *
 * Mapping decisions:
 *  - `size` is a percent of the player's default cue size; mpv's default
 *    sub-font-size is 38 (at its 720p reference frame, scaled by window),
 *    so percent maps onto that base.
 *  - `font` names ONE real family per role — mpv takes a family name, not a
 *    CSS stack, so each stack's first shipping-Windows face is the pick.
 *  - THE BOX RIDES sub-border-style. mpv 0.39 remodelled subtitle edges:
 *    the mode lives in `sub-border-style` (outline-and-shadow is the
 *    default; background-box draws the box), and `sub-back-color` colours
 *    the box ONLY in that mode — on the default mode it is the SHADOW
 *    colour, and with no shadow offset a back-colour alone draws NOTHING.
 *    The first draft set colours without the mode and produced invisible
 *    subtitles at her default settings, on the exact build we vendor.
 *    box ON  -> background-box + black back at the chosen opacity, no
 *    outline (the box provides the edge);
 *    box OFF -> outline-and-shadow with a black outline — the job the CSS
 *    text-shadow did: text needs its own edge over a light scene.
 *  - `position`: mpv's sub-pos runs 0 (top) to 100 (its normal bottom
 *    placement); top/middle/bottom map onto the same heights the cue
 *    `line` percentages produced.
 *  - ASS/SSA tracks KEEP THEIR AUTHORED LOOK: mpv's default
 *    sub-ass-override applies these settings to plain formats (srt/vtt)
 *    only, and that is deliberate — styled anime subs rendering as their
 *    typesetter intended is one of the reasons this branch exists. Her
 *    settings style the subtitles that HAVE no styling of their own.
 */

const MPV_DEFAULT_SUB_FONT_SIZE = 38;

const SUB_FONTS = {
  sans: 'Segoe UI',
  serif: 'Georgia',
  mono: 'Consolas',
};

const SUB_POSITIONS = { top: 10, middle: 50, bottom: 100 };

/** '#RRGGBB' + opacity% -> mpv's '#AARRGGBB'. */
function mpvColor(hex, opacityPercent = 100) {
  const value = String(hex || '').replace('#', '');
  const rgb = /^[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : 'ffffff';
  const alpha = Math.round((Math.min(100, Math.max(0, opacityPercent)) / 100) * 255)
    .toString(16).padStart(2, '0');
  return `#${alpha}${rgb}`;
}

/**
 * The property set for one settings object. Returned as plain
 * name -> value pairs so the host can validate and apply them one by one.
 */
function subStyleProperties(settings = {}) {
  const size = Number(settings.size) > 0 ? Number(settings.size) : 100;
  const boxOn = settings.background !== false;
  const opacity = Number.isFinite(Number(settings.backgroundOpacity))
    ? Number(settings.backgroundOpacity)
    : 75;

  return {
    'sub-color': mpvColor(settings.color || '#ffffff', 100),
    'sub-font': SUB_FONTS[settings.font] || SUB_FONTS.sans,
    'sub-font-size': Math.round(MPV_DEFAULT_SUB_FONT_SIZE * (size / 100)),
    'sub-border-style': boxOn ? 'background-box' : 'outline-and-shadow',
    'sub-back-color': boxOn ? mpvColor('#000000', opacity) : '#00000000',
    'sub-outline-size': boxOn ? 0 : 3,
    'sub-outline-color': '#ff000000',
    'sub-pos': SUB_POSITIONS[settings.position] ?? SUB_POSITIONS.bottom,
  };
}

module.exports = { subStyleProperties, mpvColor, SUB_FONTS };
