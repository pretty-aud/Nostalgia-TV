'use strict';

/**
 * Filename -> {show, season, episode, title} parsing.
 *
 * Everything here is pure and synchronous so it can be unit-tested without a
 * filesystem. `buildLibrary` is the entry point the main process uses; it takes
 * a flat list of relative paths and returns shows with their episodes already
 * sorted into broadcast order.
 */

const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.m4v', '.mkv', '.avi', '.mov', '.wmv', '.webm', '.mpg', '.mpeg', '.flv', '.ts', '.m2ts',
]);

/**
 * Release-scene noise. Stripped before we go hunting for loose numbers, so that
 * "1080p" and "x264" can never be mistaken for an episode number. Order matters
 * a little: longer tokens first, so "web-dl" is consumed before "web".
 */
const JUNK_TOKENS = [
  '2160p', '1440p', '1080p', '1080i', '720p', '576p', '480p', '360p',
  // Movie releases label the format rather than the resolution far more often
  // than episodes do: "Annihilation (2018) - 4K UHD Remux" left "- 4K UHD"
  // sitting in the title until these were listed.
  '4k', 'uhd', 'imax', 'sdr10', 'dolby', 'vision',
  'web-dl', 'webdl', 'webrip', 'web', 'bluray', 'blu-ray', 'brrip', 'bdrip', 'bdremux', 'remux',
  'hdtv', 'pdtv', 'dvdrip', 'dvd', 'hdrip', 'camrip',
  'x264', 'x265', 'h264', 'h265', 'h.264', 'h.265', 'hevc', 'avc', 'xvid', 'divx', 'av1',
  'aac2.0', 'aac', 'ac3', 'eac3', 'dts-hd', 'dts', 'truehd', 'atmos', 'flac', 'mp3', 'opus',
  'ddp5.1', 'ddp', 'dd5.1', '5.1', '7.1', '2.0',
  '10bit', '8bit', 'hdr10', 'hdr', 'dovi', 'dv', 'sdr',
  'proper', 'repack', 'internal', 'limited', 'extended', 'uncut', 'remastered', 'complete',
  'amzn', 'nf', 'netflix', 'hulu', 'dsnp', 'hmax', 'atvp', 'pcok', 'stan', 'iplayer',
  'multi', 'dual', 'subbed', 'dubbed', 'eng', 'ita', 'jpn',
];

/** Folder names that describe a season rather than a show. */
const SEASON_FOLDER = /^(?:season|series|s|saison|staffel)[\s._-]*(\d{1,3})$/i;
const SPECIALS_FOLDER = /^(?:specials?|season\s*0+|extras?|ova)$/i;

/**
 * The interstitial clips that play between episodes, kept in their own
 * top-level folder alongside the shows.
 *
 * Matched only at the TOP level: a show legitimately called "Bumpers" would be
 * a strange thing to own, but an episode inside some show named `bumpers.mkv`
 * is not, and that must stay an episode.
 */
const BUMPER_FOLDER = /^bumpers?$/i;

/**
 * Longer interstitials — trailers, channel idents, "coming up this week".
 * Same rules as bumpers, kept separate so they can play at their own cadence.
 */
const PROMO_FOLDER = /^promos?$/i;

/**
 * Feature films. Unlike a show, a movie is a single file and its title comes
 * from the FILENAME rather than the folder, so a movie may sit loose in here or
 * in a folder of its own without changing what it is called.
 */
const MOVIES_FOLDER = /^movies?$/i;

/**
 * The ident that runs before a movie.
 *
 * Both "MOVIE PRESENTATION" and "MOVE PRESENTATION" are accepted: the folder
 * was described both ways, and a feature that silently does nothing because of
 * a missing letter is a worse outcome than accepting two spellings.
 */
const PRESENTATION_FOLDER = /^(?:movie|move)[\s._-]*presentations?$/i;

/** True when a path's TOP-level folder matches, and it is not a loose file. */
function inTopFolder(relPath, pattern) {
  const parts = segments(relPath);
  return parts.length > 1 && pattern.test(parts[0].trim());
}

/** True when a relative path sits inside the top-level bumpers folder. */
function isBumperPath(relPath) {
  return inTopFolder(relPath, BUMPER_FOLDER);
}

/** True when a relative path sits inside the top-level promos folder. */
function isPromoPath(relPath) {
  return inTopFolder(relPath, PROMO_FOLDER);
}

function isMoviePath(relPath) {
  return inTopFolder(relPath, MOVIES_FOLDER);
}

function isPresentationPath(relPath) {
  return inTopFolder(relPath, PRESENTATION_FOLDER);
}

/**
 * A movie's title, taken from its FILENAME.
 *
 * Release names carry the year, the resolution, the group and the source, none
 * of which belong on screen. The year is worth keeping separately — it is the
 * one piece of that noise a viewer actually wants — so it is lifted out rather
 * than simply deleted.
 */
function parseMovie(relPath) {
  const fileName = segments(relPath).pop();
  const stem = stripExtension(fileName);

  /**
   * A bare four-digit year — the LAST one, not the first.
   *
   * Titles contain year-shaped numbers: "BladeRunner 2049 - 2017.mkv" is the
   * 2017 film, and taking the first match made 2049 the "year" and stripped
   * it from the name. The release year sits at the end by convention, so the
   * last candidate is the year and everything before it is title.
   */
  const yearMatches = [...normaliseSeparators(stem).matchAll(/(?:^|[\s([-])((?:19|20)\d{2})(?:$|[\s)\]-])/g)];
  const year = yearMatches.length ? Number(yearMatches[yearMatches.length - 1][1]) : null;

  let title = stripJunk(normaliseSeparators(stem));
  if (year) {
    // Strip only the LAST occurrence, boundary-checked — the same digits
    // earlier in the string are part of the name ("2001 A Space Odyssey - 2001").
    const token = String(year);
    const at = title.lastIndexOf(token);
    const before = at > 0 ? title[at - 1] : ' ';
    const after = at + token.length < title.length ? title[at + token.length] : ' ';
    if (at !== -1 && !/\d/.test(before) && !/\d/.test(after)) {
      title = `${title.slice(0, at)} ${title.slice(at + token.length)}`;
    }
  }
  title = trimTitle(title.replace(/\s+/g, ' '));

  return {
    relPath,
    fileName,
    // Never return an empty title: an untitled row is worse than a messy one.
    name: title || trimTitle(normaliseSeparators(stem)) || fileName,
    year,
  };
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function extname(name) {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

function stripExtension(name) {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? name : name.slice(0, dot);
}

function isVideoFile(name) {
  return VIDEO_EXTENSIONS.has(extname(name));
}

/** Split a path on either slash, dropping empty segments. */
function segments(relPath) {
  return String(relPath).split(/[\\/]+/).filter(Boolean);
}

/** Turn dots/underscores/extra spaces into single spaces. */
function normaliseSeparators(text) {
  return text.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Remove bracketed groups, release tokens and trailing -GROUP tags.
 * Used for title cleanup and before loose number-hunting.
 */
function stripJunk(text) {
  let out = text;
  out = out.replace(/[[({][^\])}]*[\])}]/g, ' '); // [YTS], (1080p), {tag}
  out = normaliseSeparators(out);

  const tokenPattern = new RegExp(
    `(?:^|[\\s-])(?:${JUNK_TOKENS.map(escapeRegExp).join('|')})(?=$|[\\s-])`,
    'gi',
  );
  // Run twice: removing one token can expose the delimiter the next one needed.
  out = out.replace(tokenPattern, ' ').replace(tokenPattern, ' ');

  out = out.replace(/\s+-\s*[A-Za-z0-9]+$/, ''); // trailing "-GROUP"
  return out.replace(/\s+/g, ' ').trim();
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Trim the dashes/colons/spaces that separate a title from what preceded it. */
function trimTitle(text) {
  return text
    .replace(/^[\s._\-–—:]+/, '')
    .replace(/[\s._\-–—:]+$/, '')
    .trim();
}

/**
 * Comparator for names containing numbers: "ep2" sorts before "ep10".
 * A plain string compare gets that backwards, which silently scrambles any
 * show whose filenames we could not parse properly.
 */
function naturalCompare(a, b) {
  const chunk = (s) => String(s).toLowerCase().match(/(\d+|\D+)/g) || [];
  const ca = chunk(a);
  const cb = chunk(b);
  for (let i = 0; i < Math.max(ca.length, cb.length); i += 1) {
    const x = ca[i];
    const y = cb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d/.test(x);
    const ny = /^\d/.test(y);
    if (nx && ny) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// season / episode extraction
// ---------------------------------------------------------------------------

/**
 * Try every known numbering convention against a filename stem, strongest
 * first. Returns null when nothing matched, so the caller can fall back to
 * natural filename order rather than inventing an episode number.
 *
 * `matchEnd` is where the numbering ended — everything after it is the title.
 */
function extractNumbering(stem) {
  // 1. S01E02 / s1.e2 / S01 E02, including multi-episode S01E01-E02 and S01E01E02.
  const sxxexx = stem.match(
    /(?<![a-z0-9])s(\d{1,3})[\s._-]*e(\d{1,4})(?:[\s._-]*(?:-\s*)?e(\d{1,4}))?/i,
  );
  if (sxxexx) {
    return {
      season: Number(sxxexx[1]),
      episode: Number(sxxexx[2]),
      episodeEnd: sxxexx[3] ? Number(sxxexx[3]) : Number(sxxexx[2]),
      matchStart: sxxexx.index,
      matchEnd: sxxexx.index + sxxexx[0].length,
      confidence: 'high',
    };
  }

  // 2. Season 1 Episode 2 (spelled out).
  const spelled = stem.match(
    /(?:season|series)[\s._-]*(\d{1,3})[\s._-]*(?:episode|ep)[\s._-]*(\d{1,4})/i,
  );
  if (spelled) {
    return {
      season: Number(spelled[1]),
      episode: Number(spelled[2]),
      episodeEnd: Number(spelled[2]),
      matchStart: spelled.index,
      matchEnd: spelled.index + spelled[0].length,
      confidence: 'high',
    };
  }

  // 3. 1x02. The lookarounds are what stop "1920x1080" parsing as S20E108.
  const cross = stem.match(/(?<!\d)(\d{1,2})\s*x\s*(\d{1,3})(?!\d)/i);
  if (cross) {
    return {
      season: Number(cross[1]),
      episode: Number(cross[2]),
      episodeEnd: Number(cross[2]),
      matchStart: cross.index,
      matchEnd: cross.index + cross[0].length,
      confidence: 'high',
    };
  }

  // 4. Date-stamped daily shows: 2024-03-15. Season becomes the year so that
  //    ordering across years still works.
  const dated = stem.match(/(?<!\d)(19|20)(\d{2})[.\-_](\d{2})[.\-_](\d{2})(?!\d)/);
  if (dated) {
    const year = Number(dated[1] + dated[2]);
    return {
      season: year,
      episode: Number(dated[3]) * 100 + Number(dated[4]), // MMDD keeps date order
      episodeEnd: Number(dated[3]) * 100 + Number(dated[4]),
      matchStart: dated.index,
      matchEnd: dated.index + dated[0].length,
      confidence: 'high',
      dated: true,
    };
  }

  // Everything below hunts for loose numbers, so strip release noise first.
  // We track the offset shift is not needed — for these weaker matches we
  // recompute the title from the cleaned string instead.
  const clean = stripJunk(stem);

  // 5. Episode 5 / Ep 5 / E05, with no season attached.
  const epOnly = clean.match(/(?<![a-z0-9])(?:episode|epis|ep|e)[\s._-]*(\d{1,4})(?!\d)/i);
  if (epOnly) {
    return {
      season: null,
      episode: Number(epOnly[1]),
      episodeEnd: Number(epOnly[1]),
      matchStart: epOnly.index,
      matchEnd: epOnly.index + epOnly[0].length,
      confidence: 'medium',
      cleaned: clean,
    };
  }

  // 6. A leading number: "01 - The Pilot".
  const leading = clean.match(/^(\d{1,4})(?!\d)/);
  if (leading) {
    return {
      season: null,
      episode: Number(leading[1]),
      episodeEnd: Number(leading[1]),
      matchStart: 0,
      matchEnd: leading[0].length,
      confidence: 'medium',
      cleaned: clean,
    };
  }

  // 7. Last resort: any standalone number that is not a year in brackets.
  const loose = clean.match(/(?<![a-z0-9])(\d{1,4})(?![\d])/i);
  if (loose && !(Number(loose[1]) >= 1900 && Number(loose[1]) <= 2100)) {
    return {
      season: null,
      episode: Number(loose[1]),
      episodeEnd: Number(loose[1]),
      matchStart: loose.index,
      matchEnd: loose.index + loose[0].length,
      confidence: 'low',
      cleaned: clean,
    };
  }

  return null;
}

/** Season number implied by a folder like "Season 2" or "Specials". */
function seasonFromFolder(folderName) {
  if (!folderName) return null;
  if (SPECIALS_FOLDER.test(folderName.trim())) return 0;
  const m = folderName.trim().match(SEASON_FOLDER);
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------------------
// per-file parse
// ---------------------------------------------------------------------------

/**
 * Parse one relative path into an episode record.
 *
 * Show name comes from the top-level folder when there is one (the layout the
 * library actually uses); for a loose file at the root we fall back to the text
 * before the episode marker.
 */
function parseEpisode(relPath, options = {}) {
  const parts = segments(relPath);
  const fileName = parts[parts.length - 1];
  const stem = stripExtension(fileName);
  const folders = parts.slice(0, -1);

  let showName = null;
  let folderSeason = null;

  if (folders.length > 0) {
    // The FIRST folder under the chosen root is the show. Deeper folders are
    // seasons, not shows — "Show/Season 2/ep.mkv" is one show, not two.
    showName = normaliseSeparators(folders[0]);
    for (let i = 1; i < folders.length; i += 1) {
      const s = seasonFromFolder(folders[i]);
      if (s !== null) folderSeason = s;
    }

    // ...unless that first folder only names a season, which happens when the
    // root IS the show: "Sopranos/Season 1/ep.mkv" scanned from inside
    // Sopranos would otherwise produce a show called "Season 1".
    const asSeason = seasonFromFolder(folders[0]);
    if (asSeason !== null) {
      folderSeason = asSeason;
      showName = options.rootName ? normaliseSeparators(options.rootName) : null;
    }
  } else if (options.rootName) {
    // Loose files directly inside the chosen folder: that folder is the show.
    showName = normaliseSeparators(options.rootName);
  }

  const numbering = extractNumbering(stem);

  // Title: whatever follows the episode marker, cleaned up.
  let title = '';
  if (numbering) {
    const source = numbering.cleaned || stem;
    title = trimTitle(stripJunk(normaliseSeparators(source.slice(numbering.matchEnd))));
  } else {
    title = trimTitle(stripJunk(normaliseSeparators(stem)));
  }

  // Loose file at the root: the show name has to come out of the filename.
  if (!showName) {
    const head = numbering && numbering.matchStart > 0
      ? stem.slice(0, numbering.matchStart)
      : stem;
    showName = trimTitle(stripJunk(normaliseSeparators(head))) || trimTitle(normaliseSeparators(stem));
  }

  // Strip a leading repeat of the show name from the title:
  // "Show B/Show B - S01E02 - Pilot" should title as "Pilot", not "Show B Pilot".
  if (title && showName) {
    const lowered = title.toLowerCase();
    const showLower = showName.toLowerCase();
    if (lowered.startsWith(showLower)) {
      title = trimTitle(title.slice(showName.length));
    }
  }

  const season = numbering && numbering.season !== null
    ? numbering.season
    : (folderSeason !== null ? folderSeason : (numbering ? 1 : null));

  return {
    relPath,
    fileName,
    showName: showName || 'Unknown',
    season,
    episode: numbering ? numbering.episode : null,
    episodeEnd: numbering ? numbering.episodeEnd : null,
    title,
    confidence: numbering ? numbering.confidence : 'none',
    dated: Boolean(numbering && numbering.dated),
  };
}

// ---------------------------------------------------------------------------
// library assembly
// ---------------------------------------------------------------------------

/**
 * Broadcast order: season ascending, then episode ascending, with unparsed
 * files falling back to natural filename order at the end of their season.
 *
 * Season 0 (specials) deliberately sorts LAST, so a channel never opens a show
 * on a Christmas special instead of the pilot.
 */
function compareEpisodes(a, b) {
  const seasonRank = (ep) => {
    if (ep.season === null || ep.season === undefined) return Number.MAX_SAFE_INTEGER - 1;
    if (ep.season === 0) return Number.MAX_SAFE_INTEGER - 2; // specials after the run
    return ep.season;
  };
  const sa = seasonRank(a);
  const sb = seasonRank(b);
  if (sa !== sb) return sa - sb;

  const ea = a.episode === null || a.episode === undefined ? Number.MAX_SAFE_INTEGER : a.episode;
  const eb = b.episode === null || b.episode === undefined ? Number.MAX_SAFE_INTEGER : b.episode;
  if (ea !== eb) return ea - eb;

  return naturalCompare(a.fileName, b.fileName);
}

/** Stable id for a show, so saved progress survives a rescan. */
function showId(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
}

/**
 * Group parsed files into shows.
 *
 * @param {Array<{relPath: string, absPath?: string, size?: number}>} entries
 * @returns {{shows: Array, skipped: Array}}
 */
function buildLibrary(entries, options = {}) {
  const skipped = [];
  const bumpers = [];
  const promos = [];
  const movies = [];
  const presentations = [];
  const byShow = new Map();

  for (const entry of entries) {
    const relPath = typeof entry === 'string' ? entry : entry.relPath;
    const fileName = segments(relPath).pop();

    if (!isVideoFile(fileName)) {
      skipped.push({ relPath, reason: 'not a video file' });
      continue;
    }
    if (fileName.startsWith('.') || fileName.startsWith('._')) {
      skipped.push({ relPath, reason: 'hidden file' });
      continue;
    }

    const absPath = typeof entry === 'string' ? undefined : entry.absPath;
    const size = typeof entry === 'string' ? undefined : entry.size;

    // Movies are titled from the FILE, not the folder, so they get their own
    // parse rather than the show pipeline's folder-is-the-name rule.
    if (isMoviePath(relPath)) {
      movies.push({ ...parseMovie(relPath), absPath, size });
      continue;
    }

    // Checked BEFORE parsing: left to the normal path, these folders would
    // become shows called "Bumpers" and "Promos" and take their turn in the
    // rotation like any other, which is exactly what they must never do.
    const interstitial = isBumperPath(relPath) ? bumpers
      : (isPromoPath(relPath) ? promos
        : (isPresentationPath(relPath) ? presentations : null));
    if (interstitial) {
      interstitial.push({
        relPath,
        fileName,
        name: trimTitle(stripJunk(normaliseSeparators(stripExtension(fileName)))) || fileName,
        absPath,
        size,
      });
      continue;
    }

    const parsed = parseEpisode(relPath, { rootName: options.rootName });
    const id = showId(parsed.showName);

    if (!byShow.has(id)) {
      byShow.set(id, { id, name: parsed.showName, episodes: [] });
    }
    byShow.get(id).episodes.push({
      ...parsed,
      absPath: typeof entry === 'string' ? undefined : entry.absPath,
      size: typeof entry === 'string' ? undefined : entry.size,
    });
  }

  const shows = [...byShow.values()].map((show) => {
    show.episodes.sort(compareEpisodes);
    show.episodes.forEach((ep, index) => { ep.index = index; });
    return {
      ...show,
      episodeCount: show.episodes.length,
      // Surfaced in the UI so a badly-named show is visible rather than silently wrong.
      needsReview: show.episodes.some((ep) => ep.confidence === 'none' || ep.confidence === 'low'),
    };
  });

  shows.sort((a, b) => naturalCompare(a.name, b.name));
  bumpers.sort((a, b) => naturalCompare(a.fileName, b.fileName));
  promos.sort((a, b) => naturalCompare(a.fileName, b.fileName));
  movies.sort((a, b) => naturalCompare(a.name, b.name));
  presentations.sort((a, b) => naturalCompare(a.fileName, b.fileName));
  return { shows, bumpers, promos, movies, presentations, skipped };
}

module.exports = {
  isVideoFile,
  buildLibrary,
  // Exported for tests: the parser's seams. Not production API — the only
  // production consumers of this module are isVideoFile and buildLibrary.
  isBumperPath,
  isPromoPath,
  isMoviePath,
  isPresentationPath,
  parseMovie,
  naturalCompare,
  extractNumbering,
  parseEpisode,
};
