/**
 * Restore the segmented control, which went missing along with the two rules
 * the shell mangling already ate.
 *
 * Appended, so it wins ties regardless of what survived earlier, and written in
 * a file so no shell ever sees the braces or backticks.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer', 'styles.css');
let css = fs.readFileSync(file, 'utf8');

const block = `

/* ── restored: segmented rotation control ─────────────────────────────── */

/* A seated track with pills inside, rather than three abutting boxes. Used by
   the rotation modes and by the subtitle position picker, which is why the
   inner buttons carry no border of their own. */
.modes {
  display: flex;
  gap: 2px;
  padding: 4px;
  margin: 0 var(--gutter);
  background: var(--paper);
  border: 1px solid var(--hair);
  border-radius: var(--r-md);
}
/* Inside the settings dialog the section already provides the inset. */
.modal__body .modes { margin: 0; }

.mode {
  flex: 1;
  padding: 8px 6px;
  border: 0;
  border-radius: var(--r-sm);
  font-weight: 500;
  font-size: var(--t-meta);
  color: var(--ink-mute);
  transition: color var(--fast), background var(--fast);
}
.mode:hover { color: var(--ink); background: var(--lift); }
.mode[aria-pressed="true"] {
  background: var(--signal);
  color: #17130a;              /* dark ink on amber, never white */
  font-weight: 600;
  box-shadow: var(--e-1);
}
.modes[data-muted="true"] { opacity: 0.4; }
`;

if (css.includes('restored: segmented rotation control')) {
  css = css.replace(/\n\n\/\* ── restored: segmented rotation control[\s\S]*$/, block);
} else {
  css += block;
}

fs.writeFileSync(file, css);
for (const sel of ['.modes {', '.mode {', '.mode[aria-pressed="true"]']) {
  console.log(`${css.includes(sel) ? 'ok  ' : 'MISS'} ${sel}`);
}
