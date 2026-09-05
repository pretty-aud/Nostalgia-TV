'use strict';

/**
 * The faces the interface can be set in.
 *
 * Two of the six are BUNDLED with the app (Inter and Space Grotesk, both SIL
 * OFL) and one is half-bundled — Terminal prefers the shipped JetBrains Mono
 * and falls back to what Windows has. The other three are Windows faces,
 * deliberately: shipping four more woff2 files to offer a serif and a
 * handwriting face would add megabytes to every install for a preference, and
 * every one of these is present on a stock Windows 11. Each stack still ends
 * in a generic, so a missing face degrades to the right SHAPE rather than to
 * whatever the browser picks first.
 *
 * The labels describe the look, not the licence: nobody chooses a font from a
 * foundry name.
 */
const FONT_CHOICES = [
  {
    id: 'grotesk',
    label: 'Grotesk — geometric, characterful',
    stack: '"Space Grotesk", "Inter", system-ui, sans-serif',
  },
  {
    id: 'inter',
    label: 'Inter — clean and neutral',
    stack: '"Inter", "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif',
  },
  {
    id: 'terminal',
    label: 'Terminal — retro monospace',
    stack: '"JetBrains Mono", "Cascadia Mono", Consolas, ui-monospace, monospace',
  },
  {
    id: 'serif',
    label: 'Serif — traditional, bookish',
    stack: 'Georgia, "Times New Roman", Times, serif',
  },
  {
    id: 'modern',
    label: 'Modern — narrow and geometric',
    stack: 'Bahnschrift, "DIN Alternate", "Segoe UI Variable Display", system-ui, sans-serif',
  },
  {
    id: 'playful',
    label: 'Playful — handwritten',
    stack: '"Ink Free", "Comic Sans MS", "Segoe Print", cursive',
  },
];

const DEFAULT_FONTS = { display: 'grotesk', body: 'inter' };

/** A stack for a saved id, falling back rather than blanking the interface. */
function fontStackFor(id, fallbackId) {
  const found = FONT_CHOICES.find((f) => f.id === id)
    || FONT_CHOICES.find((f) => f.id === fallbackId);
  return found ? found.stack : FONT_CHOICES[0].stack;
}
module.exports = { FONT_CHOICES, DEFAULT_FONTS, fontStackFor };
