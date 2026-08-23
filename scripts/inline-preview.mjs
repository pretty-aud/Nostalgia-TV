// Produce a single self-contained preview file (CSS inlined) so it renders
// correctly anywhere, without depending on a relative stylesheet path.
//   node scripts/inline-preview.mjs <outputFile>

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] || path.join(here, 'design-preview.standalone.html');

const html = await readFile(path.join(here, 'design-preview.html'), 'utf8');
const css = await readFile(path.join(here, '..', 'src', 'renderer', 'styles.css'), 'utf8');

const merged = html.replace(
  '<link rel="stylesheet" href="../src/renderer/styles.css" />',
  `<style>\n${css}\n</style>`,
);

if (merged === html) {
  console.error('Stylesheet link not found — nothing was inlined.');
  process.exit(1);
}

await writeFile(out, merged, 'utf8');
console.log(`Wrote ${out} (${merged.length} bytes)`);
