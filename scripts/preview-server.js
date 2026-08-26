'use strict';

/**
 * Serve the renderer in a plain browser so the UI can be looked at.
 *
 * The renderer normally talks to Electron through `window.tv`, which does not
 * exist in a browser — boot() would throw on the first call and nothing would
 * render at all. So this serves a generated copy of index.html with a stub
 * injected ahead of the bundle, backed by a small fake library.
 *
 * Design-only. Nothing here ships, and nothing in src/ is modified: the page is
 * generated in memory from the real index.html, so it cannot drift from it.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildLibrary, isVideoFile } = require('../src/shared/parseEpisode.js');

const PORT = Number(process.env.PORT) || 4173;
const rendererDir = path.join(__dirname, '..', 'src', 'renderer');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
};

/**
 * PREVIEW_STATE=<path> replays a real saved state through boot().
 *
 * Served as its own script rather than inlined, because the page's CSP names
 * 'self' for scripts and has no 'unsafe-inline'. Read once per request so
 * editing the file does not need a restart.
 */
function previewState() {
  const file = process.env.PREVIEW_STATE;
  if (!file) return null;
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    console.error(`PREVIEW_STATE unreadable: ${error.message}`);
    return null;
  }
}

/**
 * PREVIEW_LIBRARY=<root> serves the REAL library instead of the fake one.
 *
 * The canned five shows do not have the properties that break things: no saved
 * resume position resolves against them, so the whole "pick up where you left
 * off" branch of the ready screen is never entered. A bug that only appears
 * with a real library is invisible to a fixture by construction.
 */
function previewLibrary() {
  const root = process.env.PREVIEW_LIBRARY;
  if (!root) return null;
  try {
    const found = [];
    const queue = [{ dir: root, depth: 0 }];
    while (queue.length) {
      const { dir, depth } = queue.shift();
      if (depth > 6) break;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.name.startsWith('.')) continue;
        if (entry.isDirectory()) queue.push({ dir: full, depth: depth + 1 });
        else if (entry.isFile() && isVideoFile(entry.name)) {
          found.push({
            relPath: path.relative(root, full).split(path.sep).join('/'),
            absPath: full,
            size: 0,
          });
        }
      }
    }

    const lib = buildLibrary(found, { rootName: path.basename(root) });
    // mediaUrl is left blank on purpose: this harness is for boot and layout,
    // and an empty url would wedge the player's retry loop if anything played.
    const stats = {
      showCount: lib.shows.length,
      episodeCount: lib.shows.reduce((n, s) => n + s.episodes.length, 0),
      bumperCount: lib.bumpers.length,
      promoCount: lib.promos.length,
      movieCount: lib.movies.length,
      presentationCount: lib.presentations.length,
      skippedCount: lib.skipped.length,
    };
    return JSON.stringify({ ok: true, rootPath: root, ...lib, stats });
  } catch (error) {
    console.error(`PREVIEW_LIBRARY failed: ${error.message}`);
    return null;
  }
}

function previewHtml() {
  const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
  const stateTag = (previewState() || previewLibrary()) ? '<script src="preview-state.js"></script>\n' : '';
  return html
    // The CSP names 'self' only; the stub is served from the same origin, so
    // the only change needed is getting it in BEFORE the bundle runs.
    .replace('<script src="bundle.js"></script>',
      `${stateTag}<script src="preview-stub.js"></script>\n<script src="bundle.js"></script>`);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const name = url.pathname === '/' ? '/index.html' : url.pathname;

  if (name === '/index.html') {
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    res.end(previewHtml());
    return;
  }

  /**
   * The real thumbnail cache, read only.
   *
   * mediaUrl is blank in this harness on purpose, so the renderer can never
   * decode a frame here and every tile falls back to initials — which makes
   * the harness useless for reviewing the one thing a gallery is mostly made
   * of. The app has already cached those frames to disk; this hands them back
   * under the same key the renderer asks by. Nothing is written.
   */
  if (name === '/preview-thumb') {
    const absPath = url.searchParams.get('p') || '';
    const hash = crypto.createHash('sha1').update(absPath).digest('hex');
    const file = path.join(
      process.env.APPDATA || '', 'shuffle-tv', 'thumbnails', hash + '.jpg',
    );
    if (!absPath || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    res.end(fs.readFileSync(file));
    return;
  }

  if (name === '/preview-stub.js') {
    res.writeHead(200, { 'Content-Type': MIME['.js'] });
    res.end(fs.readFileSync(path.join(__dirname, 'preview-stub.js')));
    return;
  }

  if (name === '/preview-state.js') {
    const state = previewState();
    const library = previewLibrary();
    res.writeHead(state || library ? 200 : 404, { 'Content-Type': MIME['.js'] });
    res.end([
      state ? `window.__PREVIEW_STATE__ = ${state};` : '',
      library ? `window.__PREVIEW_LIBRARY__ = ${library};` : '',
    ].filter(Boolean).join('\n'));
    return;
  }

  // Resolve inside the renderer directory, keeping subpaths (fonts/ lives
  // there), and refuse anything that escapes it.
  const file = path.resolve(rendererDir, `.${name}`);
  if (!file.startsWith(path.resolve(rendererDir)) || !fs.existsSync(file)) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

server.listen(PORT, () => console.log(`preview on http://localhost:${PORT}`));
