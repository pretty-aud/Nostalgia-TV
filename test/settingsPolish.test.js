import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * THE SETTINGS POLISH PASS.
 *
 * What these can and cannot do is worth stating plainly, because this pass had
 * a rule that read correctly and did nothing. vitest has no layout engine, so
 * nothing here can prove a gap or a contrast ratio — those are measured in the
 * real engine by scripts/shots/setsub-rhythm.js and settings-switches.js, which
 * shoot-all gates on.
 *
 * What these CAN prove is the class of mistake that made the inert guard
 * possible: a rule in the stylesheet that a second rule silently outranks. That
 * is a property of the text, and text is exactly what a unit test can read.
 */
/**
 * COMMENTS STRIPPED, or the prose explaining a deleted rule counts as the rule.
 *
 * The "no id-scoped .setsub" test below failed on its first run against the
 * comment written to explain why that selector had been removed — the same
 * trap scheduleOnOpen.test.js already documents for HTML, arriving here in
 * CSS. A test that reads source has to read the source, not the argument
 * about it.
 */
const CSS = readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const HTML = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
const JS = readFileSync(new URL('../src/renderer/index.js', import.meta.url), 'utf8');

describe('the sub-section dividers', () => {
  it('gives every sub-heading a rule and space above it', () => {
    const rule = /\.setsub \{[^}]*\}/.exec(CSS)?.[0] ?? '';
    expect(rule, '.setsub must carry the boundary').toMatch(/border-top: 1px solid var\(--hair-soft\)/);
    expect(rule).toMatch(/margin-top: calc\(var\(--u\) \* 4\)/);
  });

  /**
   * THE ONE THAT WOULD HAVE CAUGHT IT.
   *
   * `.setgroup > .setsub:first-of-type` is (0,3,0). `#settingsBody .setsub` is
   * (1,1,0), and an id beats any number of classes — so while both existed the
   * carefully-written combinator lost every cascade it entered and Promos kept
   * the tight margin the rule was written to take away. Nothing threw, and the
   * stylesheet read correctly at both sites.
   */
  it('has no id-scoped .setsub rule to outrank the base ones', () => {
    const scoped = CSS.match(/#[A-Za-z][\w-]*\s+\.setsub\b[^{]*\{/g) || [];
    expect(scoped, 'an id selector here silently beats .setgroup > .setsub:first-of-type').toEqual([]);
  });

  it('spares only the heading that actually touches the section head', () => {
    // ADJACENCY, not "first". Both :first-of-type variants described something
    // else: parent-scoped it spared Promos inside #promoGroup, and
    // .setgroup-scoped it spared "New additions" and "Fonts", which are their
    // section's first h4 but sit well below lead content. Ten sub-headings,
    // two of them silently losing the divider.
    expect(CSS).toMatch(/\.setgroup__head \+ \.setsub \{/);
    expect(CSS).not.toMatch(/\.setsub:first-of-type/);
  });

  it('leaves the divider on every sub-heading that does not open its section', () => {
    // The markup side of the same rule, so a future edit that moves a heading
    // up against its section head is a deliberate act rather than a surprise.
    const opens = [...HTML.matchAll(/<h3 class="setgroup__head[^"]*">[^<]*<\/h3>\s*<h4 class="setsub">([^<]+)</g)]
      .map((m) => m[1]);
    const all = [...HTML.matchAll(/<h4 class="setsub">([^<]+)</g)].map((m) => m[1]);
    // TWO, not one — Continuity opens straight onto "Play order" exactly as
    // Bumpers opens onto "Up next". I expected one here and the test said
    // otherwise, which is the version of this assertion worth keeping: it
    // knows the markup better than the person writing the rule did.
    expect(opens, 'these butt their section head and take no rule').toEqual(['Play order', 'Up next']);
    expect(all.length, 'the other sub-headings all earn a divider').toBeGreaterThan(8);
  });

  it('breaks sections harder than sub-sections, by space as well as by rule', () => {
    const section = /\.setgroup \+ \.setgroup \{[^}]*\}/.exec(CSS)?.[0] ?? '';
    // NOT \b after the paren — `)` and `;` are both non-word characters, so the
    // boundary never matches there and the assertion can only ever fail. Ask
    // for the semicolon, which is what actually distinguishes --hair from
    // --hair-soft.
    expect(section).toMatch(/border-top: 1px solid var\(--hair\);/);
    const sectionGap = Number(/margin-top: calc\(var\(--u\) \* (\d+)\)/.exec(section)?.[1]);
    const subGap = Number(/\.setsub \{[^}]*margin-top: calc\(var\(--u\) \* (\d+)\)/.exec(CSS)?.[1]);
    expect(sectionGap, 'a section break must out-space a sub-section break').toBeGreaterThan(subGap);
  });

  it('sets sub-headings in full ink, not the faintest tint in the panel', () => {
    // They were --ink-faint: 2.36:1 on the sheet, under AA, and quieter than
    // the field labels they are supposed to rank above.
    const rule = /\.setsub \{[^}]*\}/.exec(CSS)?.[0] ?? '';
    expect(rule).toMatch(/color: var\(--ink\)/);
    expect(rule).not.toMatch(/--ink-faint/);
  });
});

describe('the switches', () => {
  const ROWS = [
    'cueBackground', 'loopToggle', 'rememberScheduleToggle', 'presentationToggle',
    'bumperClipToggle', 'autoCropToggle', 'promoToggle', 'promoBetweenToggle',
  ];

  /**
   * ATTRIBUTE-ORDER-BLIND. The first version of these pinned the literal
   * `<input type="checkbox" id="…"` and broke the moment role="switch" was
   * inserted between the two — the enumeration one SILENTLY, by matching zero
   * inputs and comparing two empty lists to each other. A test that passes
   * because it found nothing is worse than one that fails.
   */
  const inputs = [...HTML.matchAll(/<input\b[^>]*type="checkbox"[^>]*>/g)].map((m) => m[0]);
  const idOf = (tag) => /id="([^"]+)"/.exec(tag)?.[1];

  it('are still real checkboxes, so the logic and the screen reader are untouched', () => {
    for (const id of ROWS) {
      const tag = inputs.find((t) => idOf(t) === id);
      expect(tag, `${id} must stay a native checkbox`).toBeTruthy();
      expect(tag).toMatch(/type="checkbox"/);
    }
  });

  it('are every checkbox in the settings sheet — none left drawn as a tick box', () => {
    expect(inputs.length, 'the enumeration must actually find them').toBe(ROWS.length);
    expect(inputs.map(idOf).sort()).toEqual([...ROWS].sort());
  });

  /**
   * role="switch" costs no JavaScript: HTML-AAM maps a checkbox's `checked`
   * straight onto aria-checked when the role is switch, so there is no second
   * piece of state to keep in step — which is the only reason this is safe to
   * add to eight controls in a polish pass.
   */
  it('announce themselves as switches, since that is what they now look like', () => {
    for (const id of ROWS) {
      expect(inputs.find((t) => idOf(t) === id), `${id} should carry role="switch"`)
        .toMatch(/role="switch"/);
    }
  });

  it('needs no JavaScript change — every one is read as .checked', () => {
    // The claim that made this conversion safe, asserted rather than asserted-
    // by-me-in-a-commit-message. If a row ever grows a bespoke reader, this
    // fails and the conversion has to be re-argued.
    for (const id of ROWS) {
      expect(JS, `${id} should be read through .checked`)
        .toMatch(new RegExp(`el\\('${id}'\\)\\.checked|'${id}'\\)\\.addEventListener`));
    }
  });

  /**
   * appearance:none silently kills accent-color, and theme 01 used accent-color
   * to keep the settings sheet orange rather than lime — a rule whose own
   * comment says a lime tick beside an orange one "reads as a bug". The token
   * seam is what keeps that true now.
   */
  it('lets a theme override the on colour without touching the base rule', () => {
    expect(CSS).toMatch(/background: var\(--switch-on, var\(--signal\)\)/);
    expect(CSS).toMatch(/:root\[data-theme="01"\] \{ --switch-on:/);
  });

  it('draws the off state at a boundary you can see, not at hairline weight', () => {
    // --hair measured 1.37:1-1.91:1 over the sheet in all 34 palettes, under
    // the 3:1 WCAG asks of a control boundary. It is a divider weight, and this
    // is not a divider.
    const track = /\.check input\[type="checkbox"\] \{[^}]*\}/.exec(CSS)?.[0] ?? '';
    expect(track).toMatch(/border: 1px solid var\(--ink-mute\)/);
  });

  /**
   * A REAL BUG THIS PASS SHIPPED AND A PROBE CAUGHT.
   *
   * `transition: background` animates every longhand under the shorthand, and
   * one of them is background-position — which the VCR skin uses to centre the
   * cross it draws on this very input. The mark slid from 0% to 50% on every
   * tick; vhs-osd photographed it at 49.96% and threw. Nothing about the switch
   * itself looked wrong, because the switch does not use background-position:
   * the damage was entirely to a different component sharing the element.
   */
  it('transitions the colour only, never the background shorthand', () => {
    const shorthand = CSS.match(/\.check input\[type="checkbox"\][^{]*\{[^}]*transition:[^;]*\bbackground\s*var\(/g) || [];
    expect(shorthand, 'this animates background-position and slides the VCR mark').toEqual([]);
    expect(CSS).toMatch(/transition: background-color var\(--fast\), border-color var\(--fast\)/);
  });

  /**
   * A MEDIA QUERY CARRIES NO SPECIFICITY, which made the first version of this
   * fallback dead under the one skin it was written for: the plain selector
   * came to (0,2,1) and the VCR skin's is (0,3,1). Both halves of the fix have
   * to hold — the skin must be named, and the block must sit after it — so
   * both are asserted, the second by position rather than by hope.
   */
  it('hands the native control back under forced colours', () => {
    expect(CSS).toMatch(/@media \(forced-colors: active\)[\s\S]{0,400}appearance: auto/);
  });

  it('makes that fallback reach the one skin that repaints the control', () => {
    const media = CSS.indexOf('@media (forced-colors: active)');
    const skin = CSS.indexOf(':root[data-skin="vcr"] .check input,');
    expect(media, 'the forced-colors block is missing').toBeGreaterThan(-1);
    expect(skin, 'the VCR checkbox block is missing').toBeGreaterThan(-1);
    expect(media, 'it must come after the skin, or the tie goes the wrong way')
      .toBeGreaterThan(skin);
    const block = CSS.slice(media, media + 600);
    expect(block, 'and it must name the skin to tie its specificity at all')
      .toMatch(/:root\[data-skin="vcr"\] \.check input\[type="checkbox"\]/);
  });

  /**
   * .check:hover input (0,3,1) and .check input:checked (0,3,1) tie, and the
   * hover rule sits later — so without an explicit checked-hover the border of
   * an ON switch repainted --ink over its own accent fill on hover.
   */
  it('does not repaint a switched-on control white when the pointer is over it', () => {
    expect(CSS).toMatch(/\.check:hover input\[type="checkbox"\]:checked \{\s*border-color: var\(--switch-on, var\(--signal\)\);/);
  });

  it('keeps the VCR skin from drawing a knob inside its tick box', () => {
    // The skin outranks the switch (0,3,1) vs (0,2,1) and keeps its own box —
    // but it never mentions ::after, which is not something specificity can fix.
    expect(CSS).toMatch(/:root\[data-skin="vcr"\] \.check input\[type="checkbox"\]::after \{ content: none; \}/);
  });
});

/**
 * Amber means "on". It stopped meaning that when seven slider readouts took it
 * as their text colour — the stylesheet's own note says the signal "was doing
 * seven jobs at once, which meant nothing it marked actually stood out".
 */
describe('what the accent is allowed to mean', () => {
  it('leaves slider readouts as data rather than as state', () => {
    const rule = /\.field__control output \{[^}]*\}/.exec(CSS)?.[0] ?? '';
    expect(rule).toMatch(/color: var\(--ink\)/);
    expect(rule).not.toMatch(/--signal/);
  });

  it('picks the pressed-mode ink from the palette instead of hard-coding it', () => {
    // #17130a is dark ink on amber and 3.48:1 on Arctic's blue, 3.21:1 on
    // Bone — both under AA, on the most-pressed control in the sheet.
    const rule = /\.mode\[aria-pressed="true"\] \{[^}]*\}/.exec(CSS)?.[0] ?? '';
    expect(rule).toMatch(/color: var\(--paper\)/);
    expect(rule).not.toMatch(/#17130a/);
  });
});
