/**
 * Prove the moved-library locator against the real disks on this machine.
 *
 * Mirrors locateLibrary() in electron/main.js. Read-only.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isVideoFile } = require('../src/shared/parseEpisode.js');

function locate(previousPath) {
  if (!previousPath) return { ok: false };
  if (fs.existsSync(previousPath)) return { ok: true, rootPath: previousPath, moved: false };

  const name = path.basename(previousPath);
  if (!name) return { ok: false };

  for (let code = 'A'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code += 1) {
    const candidate = path.join(`${String.fromCharCode(code)}:\\`, name);
    if (candidate === previousPath) continue;
    try {
      if (!fs.statSync(candidate).isDirectory()) continue;
    } catch { continue; }

    let hasVideo = false;
    try {
      for (const entry of fs.readdirSync(candidate, { withFileTypes: true })) {
        if (entry.isDirectory()) { hasVideo = true; break; }
        if (entry.isFile() && isVideoFile(entry.name)) { hasVideo = true; break; }
      }
    } catch { continue; }

    if (hasVideo) return { ok: true, rootPath: candidate, moved: true };
  }
  return { ok: false };
}

for (const probe of ['F:\\TVandFilms', 'I:\\TVandFilms', 'Q:\\NoSuchLibrary', '']) {
  console.log(`${(probe || '(empty)').padEnd(22)} -> ${JSON.stringify(locate(probe))}`);
}
