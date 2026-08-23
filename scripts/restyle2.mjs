/**
 * Second restyle pass: the fixed sidebar footer, the volume control, and one
 * shared treatment for the three sidebar section labels.
 *
 * A FILE, not an inline `node -e`. Two rules were silently deleted from the
 * stylesheet by a shell mangling backticks inside an inline script; writing the
 * CSS here means the shell never sees it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer', 'styles.css');
let css = fs.readFileSync(file, 'utf8');

// Anything a previous pass damaged is re-declared here rather than patched in
// place, so the end state does not depend on what survived.
const block = `

/* ── restored and added: fixed footer, sound, shared section labels ────── */

/* The footer is a fixed strip now: the schedule and the marathon picker live
   here, so neither scrolls out of reach while browsing a long library. The
   library above it is the only scrolling region. */
.sidebar__foot {
  border-top: 1px solid var(--hair);
  padding-bottom: calc(var(--u) * 2);
  background: var(--paper-lift);
  box-shadow: var(--rim);
  flex: 0 0 auto;            /* never squeezed by the list above */
}
.sectionhead--foot { padding-top: calc(var(--u) * 2.25); }

/* Shows, Up next and Marathon are ONE role and must read as one.
   Scoped to the sidebar: the labels inside Settings name individual controls,
   which is a different job and keeps its own treatment. */
.sidebar .field__label {
  font-family: var(--grotesque);
  font-size: var(--t-meta);
  font-weight: 500;
  letter-spacing: var(--tr-none);
  text-transform: none;
  color: var(--ink-mute);
  margin-bottom: 8px;
}

.time { font-size: var(--t-meta); color: var(--ink-mute); margin-left: 6px; }

/* Sound. The slider is deliberately short: it is a trim, not a primary
   control, and a long track sitting near the scrubber invites mistaking one
   for the other (Law of Similarity). */
.volume { display: flex; align-items: center; gap: 7px; margin-left: var(--u); }
.volume input[type="range"] {
  width: 84px;
  flex: 0 0 auto;
  accent-color: var(--ink);
}
.volume #btnMute { min-width: 30px; font-size: var(--t-body); }

/* Muted and turned-fully-down sound identical, so they must look identical
   too — otherwise silence looks like a fault. */
.volume[data-silent="true"] input[type="range"] { accent-color: var(--ink-faint); }
.volume[data-silent="true"] #btnMute { color: var(--ink-faint); }
`;

if (css.includes('restored and added: fixed footer')) {
  css = css.replace(/\n\n\/\* ── restored and added[\s\S]*$/, block);
} else {
  css += block;
}

fs.writeFileSync(file, css);

const need = ['.sidebar__foot', '.sectionhead--foot', '.sidebar .field__label', '.time {', '.volume {'];
for (const sel of need) console.log(`${css.includes(sel) ? 'ok  ' : 'MISS'} ${sel}`);
