/**
 * Prove test/markup.test.js can actually go red.
 *
 * A structural guard that passes the moment it is written is indistinguishable
 * from one that inspects nothing. Each mutation below is the real fault the
 * corresponding assertion claims to catch; the file is restored from a hashed
 * copy afterwards and the hash is re-checked, so a crash cannot leave a
 * damaged stylesheet behind.
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const MUTATIONS = [
  ['src/renderer/styles.css', '.upnext {', ',\n.upnext {', 'stray comma in a selector list'],
  ['src/renderer/index.html', 'id="btnMovies"', 'id="btnMoviez"', 'renamed element id'],
];

const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');

function runTests() {
  try {
    execFileSync('npx', ['vitest', 'run', 'test/markup.test.js'],
      { cwd: root, stdio: 'pipe', shell: true });
    return 'GREEN';
  } catch {
    return 'RED';
  }
}

if (runTests() !== 'GREEN') {
  console.log('baseline is already RED — fix that first');
  process.exit(1);
}
console.log('baseline GREEN');

let failures = 0;
for (const [rel, from, to, label] of MUTATIONS) {
  const file = path.join(root, rel);
  const original = fs.readFileSync(file, 'utf8');
  const before = hash(original);

  if (!original.includes(from)) {
    console.log(`  ✗ ${label}: anchor not found, mutation never applied`);
    failures += 1;
    continue;
  }

  let result;
  try {
    fs.writeFileSync(file, original.replace(from, to));
    result = runTests();
  } finally {
    fs.writeFileSync(file, original);
  }

  if (hash(fs.readFileSync(file, 'utf8')) !== before) {
    console.log(`  ✗ ${label}: FILE NOT RESTORED — ${rel} is damaged`);
    failures += 1;
    continue;
  }

  console.log(`  ${result === 'RED' ? '✓' : '✗'} ${label}: ${result}`);
  if (result !== 'RED') failures += 1;
}

console.log(failures ? `${failures} mutation(s) survived` : 'all mutations caught');
process.exit(failures ? 1 : 0);
