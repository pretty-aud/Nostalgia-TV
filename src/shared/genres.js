'use strict';

/**
 * Genre tags: the pure half.
 *
 * Tags are set BY HAND. There is no derivation here and there never will be —
 * the library was measured before this was built (1576 files, zero sidecars,
 * zero usable container genre tags, nothing genre-like in any folder or
 * filename), so there is nothing on disk to read. Everything below is about
 * storing what a person typed and answering questions about it.
 *
 * Keying matches every other per-title store in the app: shows by show.id,
 * movies by relPath. That is deliberate and it has a known hole — show.id is
 * a slug of the FOLDER NAME (parseEpisode.js showId), so renaming a folder
 * orphans its tags exactly as it orphans its artwork and its audio
 * preference. Consistent with its neighbours beats clever and alone.
 */

/**
 * The starting vocabulary.
 *
 * Reconciled from the TMDB movie/TV lists, IMDb, AniList and MyAnimeList,
 * then cut against the library it actually has to describe — roughly 32 shows
 * and 23 films, heavily anime and western animation.
 *
 * Three judgement calls worth stating, because each one has a respectable
 * argument on the other side:
 *
 * 1. Animation and Anime are BOTH here, and an anime title carries BOTH.
 *    Strictly, neither is a genre — they answer "in what medium, made where",
 *    not "what is it about", which is why TMDB refuses an Anime genre and
 *    Plex and Jellyfin push the distinction down to separate libraries. But
 *    TheTVDB ships both as siblings, and more to the point that is the axis a
 *    person actually browses by: nobody thinks "animation from Japan
 *    tonight". The trap to avoid is making Animation silently mean
 *    "non-anime animation" — an exclusion nobody documents and everybody
 *    trips over. So: Animation means animated, Anime narrows it, anime
 *    carries both, and neither ever surprises you.
 *
 * 2. Action and Adventure stay SPLIT, against the usual advice to merge them.
 *    The merge argument is that the line is a coin flip. True in general —
 *    but this library is action-dense enough that one merged tag would match
 *    most of it, and a tag matching most of the library is a label, not a
 *    filter. Two useful shelves beat one useless one.
 *
 * 3. The anime-native tags stop at Mecha, Psychological, Supernatural and
 *    Slice of Life. Those four name things nothing else covers and that
 *    recur here. Isekai, Iyashikei, Magical Girl, Harem, the sports
 *    sub-tags and the demographics (shounen/shoujo/seinen/josei) are left
 *    out — the demographics because they describe which magazine serialised
 *    the manga rather than anything about the show, and the rest because
 *    they would match one or two titles. All of them are two keystrokes away
 *    as user-created tags, which is the whole point of the feature.
 *
 * Not a fixed list: the picker creates new tags, and this is only what an
 * empty library starts with.
 */
const DEFAULT_GENRES = [
  'Action',
  'Adventure',
  'Animation',
  'Anime',
  'Comedy',
  'Crime',
  'Documentary',
  'Drama',
  'Fantasy',
  'Horror',
  'Mecha',
  'Mystery',
  'Psychological',
  'Romance',
  'Sci-Fi',
  'Slice of Life',
  'Supernatural',
  'Thriller',
];

/** Longer than any genre anyone needs, short enough to stay one chip. */
const MAX_TAG_LENGTH = 24;

/**
 * The store, with its shape guaranteed.
 *
 * Modelled on browse.js libraryOf() for the same reason: the renderer
 * hydrates state with a SHALLOW spread, so a file saved before a sub-key
 * existed comes back missing it, and `undefined.shows` throws. Read through
 * here and that can never happen.
 */
function tagsOf(state) {
  const raw = (state && state.tags) || {};
  return {
    shows: raw.shows || {},
    movies: raw.movies || {},
    custom: Array.isArray(raw.custom) ? raw.custom : [],
  };
}

/**
 * Trim, collapse runs of whitespace, cap the length.
 *
 * Deliberately NOT case-folding: "Sci-Fi" is how it should read on a chip.
 * Case is compared separately, by keyFor below.
 */
function cleanTag(text) {
  return String(text == null ? '' : text)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TAG_LENGTH);
}

/**
 * The identity of a tag for comparison — case- and punctuation-insensitive.
 *
 * Typing "sci fi" when "Sci-Fi" already exists must select the existing one
 * rather than create a near-duplicate that then splits the shelf in two.
 * Punctuation is folded for the same reason: "slice-of-life" and "Slice of
 * Life" are one tag by any reading a person would give them.
 */
function keyFor(tag) {
  return cleanTag(tag).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Case-insensitive membership, so a list never gains a near-duplicate. */
function hasTag(list, tag) {
  const key = keyFor(tag);
  if (!key) return false;
  return (list || []).some((entry) => keyFor(entry) === key);
}

/** A-Z, case-insensitively, so "anime" never sorts after "Zombie". */
function sortTags(list) {
  return [...(list || [])].sort((a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: 'base' }));
}

/** One title's tags, always an array, always clean, always sorted. */
function tagsFor(state, kind, id) {
  if (!kind || !id) return [];
  const store = tagsOf(state);
  const bucket = kind === 'movie' ? store.movies : store.shows;
  const list = bucket[id];
  return Array.isArray(list) ? sortTags(list.map(cleanTag).filter(Boolean)) : [];
}

/**
 * Set one title's tags, returning a NEW tags object.
 *
 * An empty list DELETES the key rather than storing []. The store is never
 * pruned against a scan (same as showPrefs), so without this every title
 * whose tags were cleared would leave a permanent empty array behind.
 */
function withTags(state, kind, id, list) {
  const store = tagsOf(state);
  const key = kind === 'movie' ? 'movies' : 'shows';
  const next = { ...store[key] };
  const clean = [];
  for (const tag of list || []) {
    const value = cleanTag(tag);
    // keyFor, not just non-empty: a tag of pure punctuation survives
    // cleanTag but folds to an EMPTY key, so it could be stored and then
    // never matched by a filter or found by a search — a chip that does
    // nothing, forever.
    if (keyFor(value) && !hasTag(clean, value)) clean.push(value);
  }
  if (clean.length) next[id] = sortTags(clean);
  else delete next[id];
  return { ...store, [key]: next };
}

/**
 * Every tag the library can offer, in one sorted list.
 *
 * The defaults, plus anything the person typed, plus anything already ON a
 * title — that last one matters because a tag can outlive its presence in
 * `custom` (an older save, a hand-edited file) and a tag you can see on a
 * chip but cannot find in the picker reads as a bug.
 */
function allTags(state) {
  const store = tagsOf(state);
  const out = [];
  const add = (tag) => {
    const value = cleanTag(tag);
    if (value && !hasTag(out, value)) out.push(value);
  };
  DEFAULT_GENRES.forEach(add);
  store.custom.forEach(add);
  for (const bucket of [store.shows, store.movies]) {
    for (const list of Object.values(bucket)) {
      if (Array.isArray(list)) list.forEach(add);
    }
  }
  return sortTags(out);
}

/**
 * Only the tags something is actually tagged WITH, with counts.
 *
 * This is what the filter dropdown offers. Offering all 18 defaults there
 * would put 18 rows in front of a person of which 14 return nothing — a
 * filter whose options mostly produce an empty page is worse than no filter,
 * because every empty result reads as "your library is missing things"
 * rather than "nothing was ever tagged that".
 */
function tagsInUse(state, shows, movies) {
  const counts = new Map();
  const bump = (tag) => {
    const key = keyFor(tag);
    if (!key) return;
    const found = counts.get(key);
    if (found) found.count += 1;
    else counts.set(key, { name: cleanTag(tag), count: 1 });
  };
  for (const show of shows || []) tagsFor(state, 'show', show.id).forEach(bump);
  for (const movie of movies || []) tagsFor(state, 'movie', movie.relPath).forEach(bump);
  return sortTags([...counts.values()].map((entry) => entry.name))
    .map((name) => ({ name, count: counts.get(keyFor(name)).count }));
}

/**
 * Does this title pass the filter?
 *
 * ANY, not ALL. With roughly 55 titles carrying one to three tags each, ALL
 * returns an empty page on the second click almost every time — the operator
 * would be technically defensible and practically useless. "Horror or
 * thriller" is also simply what a person means when they tick two boxes on a
 * shelf of things they own.
 */
function matchesGenres(titleTags, selected) {
  if (!selected || !selected.length) return true;
  const wanted = new Set(selected.map(keyFor).filter(Boolean));
  if (!wanted.size) return true;
  return (titleTags || []).some((tag) => wanted.has(keyFor(tag)));
}

/**
 * Add a tag to the vocabulary without attaching it to anything.
 *
 * Returns the tags object unchanged when the tag already exists in ANY form —
 * a default, another custom entry, or on a title — so the picker's "Create"
 * row can be pressed twice without growing the list.
 */
function withCustomTag(state, tag) {
  const store = tagsOf(state);
  const value = cleanTag(tag);
  // Same guard as withTags: pure punctuation folds to an empty key, and a
  // tag with no key can never be matched, counted or deleted again.
  if (!keyFor(value) || hasTag(allTags(state), value)) return store;
  return { ...store, custom: [...store.custom, value] };
}

/**
 * Remove a tag everywhere: the vocabulary and every title carrying it.
 *
 * A default genre can be deleted too. It comes back on the next launch,
 * because DEFAULT_GENRES is a constant rather than something seeded into the
 * save file — worth knowing, and the reason the picker warns about deleting
 * one rather than silently doing something that half-works.
 */
function withoutTag(state, tag) {
  const store = tagsOf(state);
  const key = keyFor(tag);
  if (!key) return store;
  const strip = (bucket) => {
    const next = {};
    for (const [id, list] of Object.entries(bucket)) {
      const kept = (list || []).filter((entry) => keyFor(entry) !== key);
      if (kept.length) next[id] = kept;
    }
    return next;
  };
  return {
    shows: strip(store.shows),
    movies: strip(store.movies),
    custom: store.custom.filter((entry) => keyFor(entry) !== key),
  };
}

/** How many titles carry this tag — the number the delete warning names. */
function countTagged(state, shows, movies, tag) {
  const key = keyFor(tag);
  if (!key) return 0;
  let n = 0;
  for (const show of shows || []) {
    if (tagsFor(state, 'show', show.id).some((entry) => keyFor(entry) === key)) n += 1;
  }
  for (const movie of movies || []) {
    if (tagsFor(state, 'movie', movie.relPath).some((entry) => keyFor(entry) === key)) n += 1;
  }
  return n;
}

module.exports = {
  DEFAULT_GENRES,
  MAX_TAG_LENGTH,
  tagsOf,
  cleanTag,
  keyFor,
  hasTag,
  sortTags,
  tagsFor,
  withTags,
  allTags,
  tagsInUse,
  matchesGenres,
  withCustomTag,
  withoutTag,
  countTagged,
};
