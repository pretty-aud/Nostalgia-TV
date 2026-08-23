/**
 * Apply the redesign to styles.css.
 *
 * Written as a script rather than typed inline so every replacement is exact
 * and reviewable, and so a missed selector reports itself instead of silently
 * doing nothing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer', 'styles.css');
let css = fs.readFileSync(file, 'utf8');
const misses = [];
const R = (from, to) => {
  if (!css.includes(from)) { misses.push(from.slice(0, 68).replace(/\n/g, ' ⏎ ')); return; }
  css = css.split(from).join(to);
};

/* ── 1. Labels stop being uppercase mono ───────────────────────────────────
   This is the single biggest thing making the interface read as a 1960s
   technical manual rather than as current software. Mono keeps the job it
   deserves — episode codes, timecodes, counts, the wordmark — and stops being
   the default treatment for every heading in the app. */
R(`.sectionhead {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding: calc(var(--u) * 3) calc(var(--u) * 3) var(--u);
  font-size: var(--t-micro);
  font-weight: 500;
  letter-spacing: var(--tr-wide);
  text-transform: uppercase;
  color: var(--ink-faint);`,
`.sectionhead {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding: calc(var(--u) * 3) var(--gutter) var(--u);
  font-family: var(--grotesque);
  font-size: var(--t-meta);
  font-weight: 500;
  letter-spacing: var(--tr-none);
  text-transform: none;
  color: var(--ink-mute);`);

R(`.setgroup__head {
  font-size: var(--t-micro);
  letter-spacing: var(--tr-label);
  text-transform: uppercase;
  color: var(--ink-faint);
  margin-bottom: calc(var(--u) * 1.5);
}`,
`.setgroup__head {
  font-family: var(--grotesque);
  font-size: var(--t-lead);
  font-weight: 600;
  letter-spacing: var(--tr-tight);
  text-transform: none;
  color: var(--ink);
  margin-bottom: calc(var(--u) * 1.5);
}`);

R(`.trackmenu__head {
  font-size: var(--t-micro);
  letter-spacing: var(--tr-label);
  text-transform: uppercase;
  color: var(--ink-faint);
  margin-bottom: var(--u);
}`,
`.trackmenu__head {
  font-family: var(--grotesque);
  font-size: var(--t-meta);
  font-weight: 500;
  letter-spacing: var(--tr-none);
  text-transform: none;
  color: var(--ink-mute);
  margin-bottom: var(--u);
}`);

/* The eyebrow keeps its uppercase: it is a single small kicker above a display
   line, which is the one place the treatment still earns its keep. */
R(`.eyebrow {
  font-size: var(--t-micro);
  font-weight: 600;
  letter-spacing: var(--tr-wide);
  text-transform: uppercase;
  color: var(--ink-faint);
}`,
`.eyebrow {
  font-family: var(--grotesque);
  font-size: var(--t-micro);
  font-weight: 600;
  letter-spacing: var(--tr-label);
  text-transform: uppercase;
  color: var(--ink-mute);
}`);

/* ── 2. Show rows become seated cards ──────────────────────────────────────
   Separator rules are replaced by inset, rounded rows with air between them:
   the Law of Proximity does the grouping, so the lines are not needed, and
   removing them takes a lot of visual noise out of a 13-item list. */
R(`.show {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 2px calc(var(--u) * 1.5);
  padding: calc(var(--u) * 1.5) calc(var(--u) * 3);
  border-top: 1px solid var(--hair);
  cursor: pointer;
  transition: background var(--fast);
}`,
`.show {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 3px calc(var(--u) * 1.5);
  margin: 0 var(--gutter) 4px;
  padding: calc(var(--u) * 1.5) calc(var(--u) * 1.75);
  border: 1px solid transparent;
  border-radius: var(--r-md);
  cursor: pointer;
  transition: background var(--fast), border-color var(--fast), transform var(--fast);
}`);
R('.show:hover { background: var(--lift); }',
  `.show:hover { background: var(--paper-high); border-color: var(--hair); }
.show:active { transform: scale(0.995); }`);

R('.shows { list-style: none; }', '.shows { list-style: none; padding-bottom: var(--u); }');

/* ── 3. Controls: rounded, seated, consistent ──────────────────────────── */
R(`.btn {
  padding: 7px 12px;
  border: 1px solid var(--hair);
  font-size: var(--t-body);`,
`.btn {
  padding: 9px 14px;
  border: 1px solid var(--hair);
  border-radius: var(--r-sm);
  font-weight: 500;
  font-size: var(--t-body);`);

R(`.btn--signal {
  background: var(--signal);
  border-color: var(--signal);
  color: #17130a;               /* dark ink on amber: 10.9:1, never white */
  font-weight: 600;
  padding: 13px 22px;
  font-size: var(--t-lead);
}`,
`.btn--signal {
  background: var(--signal);
  border-color: var(--signal);
  color: #17130a;               /* dark ink on amber: 10.9:1, never white */
  font-weight: 600;
  padding: 13px 24px;
  border-radius: var(--r-sm);
  font-size: var(--t-lead);
  box-shadow: var(--e-1);
}`);

R(`.showctl {
  width: 26px;
  height: 22px;
  border: 1px solid transparent;`,
`.showctl {
  width: 28px;
  height: 24px;
  border-radius: var(--r-sm);
  border: 1px solid transparent;`);

R(`.show__toggle {
  grid-row: span 2;
  align-self: center;
  width: 16px; height: 16px;
  border: 1px solid var(--hair);`,
`.show__toggle {
  grid-row: span 2;
  align-self: center;
  width: 18px; height: 18px;
  border-radius: var(--r-sm);
  border: 1px solid var(--hair);`);

R('.show__bar {\n  grid-column: 1 / -1;\n  height: 2px;',
  '.show__bar {\n  grid-column: 1 / -1;\n  height: 3px;\n  border-radius: var(--r-pill);\n  overflow: hidden;');
R('.show__bar i { display: block; height: 100%; background: var(--signal-soft); }',
  '.show__bar i { display: block; height: 100%; background: var(--signal-soft); border-radius: var(--r-pill); }');

/* Segmented control rather than three abutting boxes. */
R('.modes { display: flex; gap: 0; padding: 0 calc(var(--u) * 3); }',
  `.modes {
  display: flex;
  gap: 2px;
  padding: 4px;
  margin: 0 var(--gutter);
  background: var(--paper);
  border: 1px solid var(--hair);
  border-radius: var(--r-md);
}`);
R(`.mode {
  flex: 1;
  padding: 8px 4px;
  border: 1px solid var(--hair);
  font-size: var(--t-meta);`,
`.mode {
  flex: 1;
  padding: 8px 6px;
  border: 0;
  border-radius: var(--r-sm);
  font-weight: 500;
  font-size: var(--t-meta);`);
R('.mode + .mode { border-left: 0; }', '');
R('.mode:hover { color: var(--ink); }', '.mode:hover { color: var(--ink); background: var(--lift); }');
R('.mode[aria-pressed="true"] { background: var(--signal); border-color: var(--signal); color: #17130a; font-weight: 600; }',
  '.mode[aria-pressed="true"] { background: var(--signal); color: #17130a; font-weight: 600; box-shadow: var(--e-1); }');

/* Sliders: a hairline track reads as a scratch. */
R(`input[type="range"] {
  flex: 1;
  -webkit-appearance: none;
  height: 2px;
  background: var(--ink-faint);
  cursor: pointer;
}`,
`input[type="range"] {
  flex: 1;
  -webkit-appearance: none;
  height: 4px;
  border-radius: var(--r-pill);
  background: var(--hair);
  cursor: pointer;
}`);

R('.select {\n  width: 100%;\n  min-width: 0;\n  padding: 6px 8px;\n  border: 1px solid var(--hair);',
  '.select {\n  width: 100%;\n  min-width: 0;\n  padding: 9px 10px;\n  border: 1px solid var(--hair);\n  border-radius: var(--r-sm);');

/* ── 4. Surfaces: seated, with a rim of light ─────────────────────────── */
R(`.modal__panel {
  position: relative;`, `.modal__panel {
  position: relative;
  border-radius: var(--r-lg);
  overflow: hidden;`);
R('  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.72);', '  box-shadow: var(--e-3), var(--rim);');
R('  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.66);', '  box-shadow: var(--e-2), var(--rim);\n  border-radius: var(--r-md);');
R('  box-shadow: 0 30px 90px rgba(0, 0, 0, 0.7);', '  box-shadow: var(--e-3), var(--rim);');
R('.skipask__panel {\n  width: min(460px, calc(100% - var(--u) * 8));',
  '.skipask__panel {\n  width: min(460px, calc(100% - var(--u) * 8));\n  border-radius: var(--r-lg);');

R('.trackopt {\n  width: 100%;\n  text-align: left;\n  padding: 7px 10px;\n  border: 0;',
  '.trackopt {\n  width: 100%;\n  text-align: left;\n  padding: 9px 11px;\n  border: 0;\n  border-radius: var(--r-sm);');

R('.modal__close {\n  width: 30px; height: 30px;\n  border: 1px solid var(--hair);',
  '.modal__close {\n  width: 32px; height: 32px;\n  border: 1px solid var(--hair);\n  border-radius: var(--r-sm);');

R('.cuepreview {\n  height: 92px;', '.cuepreview {\n  height: 92px;\n  border-radius: var(--r-md);');
R('.swatch {\n  width: 24px; height: 24px;', '.swatch {\n  width: 26px; height: 26px;\n  border-radius: var(--r-sm);');

/* ── 5. The settings gear, off the edge ───────────────────────────────── */
R(`.settingsbtn {
  margin-top: calc(var(--u) * 2);
  margin-left: auto;
  width: 34px;
  height: 34px;`,
`.settingsbtn {
  margin-top: calc(var(--u) * 2);
  margin-left: auto;
  margin-right: var(--gutter);   /* clears the sidebar edge, matching the rows */
  width: 36px;
  height: 36px;
  border-radius: var(--r-sm);`);

/* ── 6. Remaining sidebar gutters follow the new inset ────────────────── */
R('.sidebar__head {\n  padding: calc(var(--u) * 3);', '.sidebar__head {\n  padding: calc(var(--u) * 3) var(--gutter);');
R('.field { display: block; padding: calc(var(--u) * 1.5) calc(var(--u) * 3) 0; }',
  '.field { display: block; padding: calc(var(--u) * 1.5) var(--gutter) 0; }');
R('.modes__note {\n  padding: var(--u) calc(var(--u) * 3) 0;', '.modes__note {\n  padding: var(--u) var(--gutter) 0;');
R('.check {\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  padding: calc(var(--u) * 2) calc(var(--u) * 3) 0;',
  '.check {\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  padding: calc(var(--u) * 2) var(--gutter) 0;');
R('.sched {\n  display: grid;\n  grid-template-columns: 22px 1fr;\n  gap: calc(var(--u) * 1.5);\n  padding: 7px calc(var(--u) * 3);',
  '.sched {\n  display: grid;\n  grid-template-columns: 22px 1fr;\n  gap: calc(var(--u) * 1.5);\n  padding: 7px var(--gutter);');

fs.writeFileSync(file, css);
console.log(misses.length ? `MISSED ${misses.length}:` : 'all replacements applied');
for (const m of misses) console.log('  •', m);
